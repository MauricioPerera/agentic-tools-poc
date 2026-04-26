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
import type {
  BashResult,
  Manifest,
  SkillDef,
  SkillHandler,
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

  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readResource(`${base}/manifest.json`)) as Manifest;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Manifest load failed: ${msg}`);
  }

  // Cache compiled-or-imported handlers per slug. For sandbox mode we cache
  // the raw bundle source (sandbox.ts has its own compile-cache that keys by
  // source). For trust mode we cache the imported module's default export.
  const trustCache = new Map<string, SkillHandler>();
  const bundleCache = new Map<string, string>();

  async function getBundle(tool: SkillDef): Promise<string> {
    if (bundleCache.has(tool.slug)) return bundleCache.get(tool.slug)!;
    const code = await readResource(`${base}/${tool.source}`);
    // Integrity check: when the manifest declares a sha256, refuse to load a
    // bundle whose contents don't match. Same defence-in-depth as Phase 1
    // (the sandbox doesn't replace the integrity check; it complements it).
    if (tool.sha256) {
      const actual = createHash('sha256').update(code, 'utf8').digest('hex');
      if (actual !== tool.sha256) {
        throw new Error(
          `bundle integrity check failed: ${tool.source} has sha256 ${actual.slice(0, 16)}… ` +
          `but manifest expected ${tool.sha256.slice(0, 16)}…. Refusing to load.`,
        );
      }
    }
    bundleCache.set(tool.slug, code);
    return code;
  }

  const commands = manifest.tools.map((tool) =>
    defineCommand(tool.slug, async (args: string[], ctx: BashCommandContext): Promise<BashResult> => {
      try {
        const input = parseArgvAgainstSchema(args, ctx.stdin, tool.inputSchema);
        const toolCtx = makeToolCtx(tool, ctx);
        const code = await getBundle(tool);

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
          if (!trustCache.has(tool.slug)) {
            const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
            const mod = (await import(dataUrl)) as { default: SkillHandler };
            trustCache.set(tool.slug, mod.default);
          }
          const handler = trustCache.get(tool.slug)!;
          output = await handler(input, toolCtx);
        }
        return { stdout: JSON.stringify(output) + '\n', stderr: '', exitCode: 0 };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { stdout: '', stderr: `${tool.slug}: ${msg}\n`, exitCode: 1 };
      }
    }),
  );

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
