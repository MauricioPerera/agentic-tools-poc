/**
 * loader.ts — turns a remote registry manifest into just-bash custom commands.
 *
 * Trust model: phase 1 is "trusted" — bundles are imported via `data:` URL
 * and run in the host Node process with whatever capabilities we hand them
 * via `ctx`. This keeps the loader tiny and avoids QuickJS for the POC.
 * Phase 2 will swap import() for `js-exec` to sandbox community contributions.
 */
import { defineCommand } from 'just-bash';
import { parseArgvAgainstSchema, coerceArgvValue } from './arg-parser.ts';
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

export async function loadRegistry(opts: LoaderOptions = {}): Promise<LoadedRegistry> {
  const base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '');
  const r = await fetch(`${base}/manifest.json`);
  if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
  const manifest = (await r.json()) as Manifest;

  const handlerCache = new Map<string, SkillHandler>();

  const commands = manifest.tools.map((tool) =>
    defineCommand(tool.slug, async (args: string[], ctx: BashCommandContext): Promise<BashResult> => {
      try {
        const input = parseArgvAgainstSchema(args, ctx.stdin, tool.inputSchema);

        if (!handlerCache.has(tool.slug)) {
          const url = `${base}/${tool.source}`;
          const code = await fetch(url).then((res) => {
            if (!res.ok) throw new Error(`Bundle fetch failed: ${res.status}`);
            return res.text();
          });
          const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
          const mod = (await import(dataUrl)) as { default: SkillHandler };
          handlerCache.set(tool.slug, mod.default);
        }

        const handler = handlerCache.get(tool.slug)!;
        const toolCtx = makeToolCtx(tool, ctx);
        const output = await handler(input, toolCtx);
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
