/**
 * loader.ts — turns a remote registry manifest into just-bash custom commands.
 *
 * Trust model (Phase 2): handlers run inside a QuickJS sandbox via
 * `runHandlerSandboxed` (see `client/sandbox.ts`). They have NO Node API
 * surface — `import('node:fs')` is undefined, `process` is undefined,
 * `globalThis.fetch` is the curated bridge that enforces
 * `networkPolicy.allow`. The sandbox cannot reach the host filesystem,
 * environment, or network except via that bridge.
 *
 * For local development convenience the loader supports `LOADER_MODE=trust`
 * to fall back to in-process `import()` of a `data:` URL — same behaviour as
 * Phase 1. This is for debugging only; production / CI / MCP servers default
 * to the sandbox.
 */
import { defineCommand } from 'just-bash';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgvAgainstSchema, coerceArgvValue } from './arg-parser.ts';
import { runHandlerSandboxed } from './sandbox.ts';
import { resolveBest } from './semver-pin.ts';
import type {
  BashResult,
  Manifest,
  SkillDef,
  SkillHandler,
  SkillVersionEntry,
  ToolContext,
} from '../types/index.ts';

// dist/ is published to the `dist` branch by CI on every push to main, so
// jsDelivr serves it directly without the `/dist/` subpath. Pin to a SHA
// (`@<sha>` or `@v1.2.3` after tagging) for production stability.
const DEFAULT_REGISTRY = 'https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@dist';

// Re-exported for backwards compatibility with existing tests.
export const parseArgs = parseArgvAgainstSchema;
export const coerce    = coerceArgvValue;

interface LoaderOptions {
  registry?: string | undefined;
  /** Override the execution model. Defaults to env LOADER_MODE or 'sandbox'. */
  mode?: 'sandbox' | 'trust';
  /**
   * Per-skill version pins. Keys are slugs, values are semver range strings
   * understood by `client/semver-pin.ts` (`^1.2.3`, `~1.2.0`, `1.2.3`, `*`).
   * If a slug is pinned, the loader resolves the highest matching version
   * from the manifest's `tools[].versions[]` and loads `skills/<slug>@<v>.mjs`
   * instead of the default `skills/<slug>.mjs` (latest). The integrity
   * check uses the per-version sha256 from the manifest.
   *
   * Slugs not in the map use the latest bundle (current behaviour).
   * Throws at load time if a pinned slug has no matching version.
   */
  pin?: Record<string, string>;
}

interface LoadedRegistry {
  manifest: Manifest;
  /** just-bash defineCommand() return values, opaque from our PoV. */
  commands: unknown[];
}

/** Shape of just-bash's CommandContext (the bits we use). just-bash exposes
 *  `env` as a Map; we adapt it to the Record shape ToolContext expects. */
interface BashCommandContext {
  stdin: string;
  env: Map<string, string>;
  stderr?: { write?: (s: string) => void };
}

/**
 * Read a manifest or bundle URL. Supports http(s) for normal use and
 * file:// (or bare paths) for local development and integration tests
 * — the latter so the test harness can spin up MCP servers without
 * standing up an HTTP server just to serve dist/.
 */
async function readResource(url: string): Promise<string> {
  if (url.startsWith('file:')) {
    return await readFile(fileURLToPath(url), 'utf8');
  }
  if (url.startsWith('/') || url.startsWith('./') || /^[a-zA-Z]:[\\/]/.test(url)) {
    // POSIX absolute, relative, or Windows drive-letter path
    return await readFile(url, 'utf8');
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return await r.text();
}

export async function loadRegistry(opts: LoaderOptions = {}): Promise<LoadedRegistry> {
  const base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '');
  const mode: 'sandbox' | 'trust' =
    opts.mode ?? (process.env['LOADER_MODE'] === 'trust' ? 'trust' : 'sandbox');
  const pin = opts.pin ?? {};

  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readResource(`${base}/manifest.json`)) as Manifest;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Manifest load failed: ${msg}`);
  }

  /**
   * Resolve which (source, sha256) the loader should fetch for a tool.
   * Without a pin: latest (top-level fields). With a pin: the highest
   * matching entry from `tool.versions[]`. Throws if no version satisfies.
   */
  function resolveSource(tool: SkillDef): { source: string; sha256: string | undefined } {
    const range = pin[tool.slug];
    if (!range) return { source: tool.source, sha256: tool.sha256 };
    const versions: SkillVersionEntry[] = tool.versions ?? [];
    if (versions.length === 0) {
      throw new Error(
        `pin error: ${tool.slug} pinned to "${range}" but the manifest has no versions[] ` +
        `(skill was published before per-skill versioning landed, or the dist branch ` +
        `lost its archive). Drop the pin or rebuild the registry.`,
      );
    }
    const picked = resolveBest(versions.map((v) => v.version), range);
    if (!picked) {
      throw new Error(
        `pin error: ${tool.slug} pinned to "${range}" but no archived version matches. ` +
        `Available: ${versions.map((v) => v.version).join(', ')}.`,
      );
    }
    const entry = versions.find((v) => v.version === picked)!;
    return { source: entry.source, sha256: entry.sha256 };
  }

  // Cache compiled-or-imported handlers per (slug, source) — different pins
  // for the same slug should not share a cache entry. For sandbox mode we
  // cache the raw bundle source (sandbox.ts has its own compile-cache that
  // keys by source). For trust mode we cache the imported module's default.
  const trustCache = new Map<string, SkillHandler>();
  const bundleCache = new Map<string, string>();

  async function getBundle(tool: SkillDef): Promise<{ code: string; source: string }> {
    const { source, sha256 } = resolveSource(tool);
    const cacheKey = `${tool.slug}::${source}`;
    if (bundleCache.has(cacheKey)) return { code: bundleCache.get(cacheKey)!, source };
    const code = await readResource(`${base}/${source}`);
    // Integrity check: when the manifest declares a sha256, refuse to load a
    // bundle whose contents don't match. Same defence-in-depth as Phase 1
    // (the sandbox doesn't replace the integrity check; it complements it).
    if (sha256) {
      const actual = createHash('sha256').update(code, 'utf8').digest('hex');
      if (actual !== sha256) {
        throw new Error(
          `bundle integrity check failed: ${source} has sha256 ${actual.slice(0, 16)}… ` +
          `but manifest expected ${sha256.slice(0, 16)}…. Refusing to load.`,
        );
      }
    }
    bundleCache.set(cacheKey, code);
    return { code, source };
  }

  const skillCommands = manifest.tools.map((tool) =>
    defineCommand(tool.slug, async (args: string[], ctx: BashCommandContext): Promise<BashResult> => {
      try {
        const input = parseArgvAgainstSchema(args, ctx.stdin, tool.inputSchema);
        const toolCtx = makeToolCtx(tool, ctx);
        const { code, source } = await getBundle(tool);

        let output: unknown;
        if (mode === 'sandbox') {
          const r = await runHandlerSandboxed(code, input, toolCtx);
          if (!r.ok) {
            const tag = r.isViolation ? 'sandbox-violation' : 'handler-error';
            return { stdout: '', stderr: `${tool.slug} [${tag}]: ${r.error}\n`, exitCode: 1 };
          }
          output = r.value;
        } else {
          // trust mode (LOADER_MODE=trust) — Phase 1 behaviour, debug only.
          // Cache key includes the source path so different pins for the
          // same slug don't conflate.
          const trustKey = `${tool.slug}::${source}`;
          if (!trustCache.has(trustKey)) {
            const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
            const mod = (await import(dataUrl)) as { default: SkillHandler };
            trustCache.set(trustKey, mod.default);
          }
          const handler = trustCache.get(trustKey)!;
          output = await handler(input, toolCtx);
        }
        return { stdout: JSON.stringify(output) + '\n', stderr: '', exitCode: 0 };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { stdout: '', stderr: `${tool.slug}: ${msg}\n`, exitCode: 1 };
      }
    }),
  );

  // ─── Discovery built-ins: list_skills + tool_schema ────────────────────
  // These are the mechanism that makes composable mode actually scale: the
  // model sees ONLY `bash` upfront and uses these commands to discover
  // what's available WITHOUT loading the full catalog into the system
  // prompt.
  //
  // list_skills supports filtering so the model loads a SUBSET of the
  // catalog, not all of it:
  //   bash list_skills                          → all slugs (one per line)
  //   bash list_skills --capability network     → only network-tagged
  //   bash list_skills --search weather         → fuzzy-match on slug + summary
  //   bash list_skills --json                   → full metadata as JSON
  //
  // Without these, "discovery" is indistinguishable from "preload" — the
  // model has to learn about every skill anyway. With filtering, the model
  // can ask "what skills handle X?" and only carry that subset forward.
  const listSkillsCmd = defineCommand('list_skills', async (args: string[]): Promise<BashResult> => {
    const opts = parseListSkillsArgs(args);
    let entries = manifest.tools as SkillDef[];
    if (opts.capability) {
      entries = entries.filter((t) => (t.capabilities ?? []).includes(opts.capability!));
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      entries = entries.filter((t) =>
        t.slug.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        (t.capabilities ?? []).some((c) => c.toLowerCase().includes(q)),
      );
    }
    if (opts.json) {
      const out = entries.map((t) => ({
        slug: t.slug,
        summary: t.summary,
        capabilities: t.capabilities ?? [],
        version: t.version,
      }));
      return { stdout: JSON.stringify(out, null, 2) + '\n', stderr: '', exitCode: 0 };
    }
    // Default: one line per skill — slug + summary. Token-frugal.
    const lines = entries.map((t) => `${t.slug}: ${t.summary}`);
    if (lines.length === 0) {
      return { stdout: '', stderr: `no skills match the filter\n`, exitCode: 1 };
    }
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  });

  const toolSchemaCmd = defineCommand('tool_schema', async (args: string[]): Promise<BashResult> => {
    // Parse --slug <name> from args
    let slug: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--slug' && i + 1 < args.length) { slug = args[i + 1]!; break; }
      if (args[i]?.startsWith('--slug=')) { slug = args[i]!.slice('--slug='.length); break; }
    }
    if (!slug) {
      return {
        stdout: '',
        stderr: `tool_schema requires --slug <name>. Use \`list_skills\` to discover available slugs.\n`,
        exitCode: 1,
      };
    }
    const tool = manifest.tools.find((t) => t.slug === slug);
    if (!tool) {
      return {
        stdout: '',
        stderr: `unknown skill: ${slug}. Use \`list_skills\` to see what's available.\n`,
        exitCode: 1,
      };
    }
    const view = {
      slug:          tool.slug,
      summary:       tool.summary,
      version:       tool.version,
      capabilities:  tool.capabilities ?? [],
      sideEffects:   tool.sideEffects ?? 'none',
      inputSchema:   tool.inputSchema,
      outputSchema:  tool.outputSchema,
      networkPolicy: tool.networkPolicy,
    };
    return { stdout: JSON.stringify(view, null, 2) + '\n', stderr: '', exitCode: 0 };
  });

  const commands = [...skillCommands, listSkillsCmd, toolSchemaCmd];

  return { manifest, commands };
}

function makeToolCtx(tool: SkillDef, bashCtx: BashCommandContext): ToolContext {
  const allow = new Set(tool.networkPolicy?.allow ?? []);
  return {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const host = new URL(urlStr).host;
      if (!allow.has(host)) {
        throw new Error(`network: host "${host}" not allowed (tool ${tool.slug})`);
      }
      return globalThis.fetch(url, init);
    }) as typeof fetch,
    env: filterEnv(bashCtx.env, tool.requiredEnv ?? []),
    log: (msg: string) =>
      bashCtx.stderr?.write?.(`[${tool.slug}] ${msg}\n`) ??
      process.stderr.write(`[${tool.slug}] ${msg}\n`),
  };
}

function filterEnv(env: Map<string, string>, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowed) {
    const v = env.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

interface ListSkillsOpts {
  capability: string | null;
  search: string | null;
  json: boolean;
}

/** Parse `--capability X --search Y --json` from argv. Tiny parser; the
 *  shape is small enough that pulling in the schema-based parser is
 *  overkill, but the option grammar matches exactly: --key value or
 *  --key=value, with --json as a bare flag. */
function parseListSkillsArgs(args: string[]): ListSkillsOpts {
  const out: ListSkillsOpts = { capability: null, search: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { out.json = true; continue; }
    let key: string | null = null;
    let val: string | null = null;
    if (a.startsWith('--') && a.includes('=')) {
      key = a.slice(2, a.indexOf('='));
      val = a.slice(a.indexOf('=') + 1);
    } else if (a.startsWith('--') && i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
      key = a.slice(2);
      val = args[i + 1]!;
      i++;
    }
    if (key === 'capability') out.capability = val;
    else if (key === 'search') out.search = val;
  }
  return out;
}
