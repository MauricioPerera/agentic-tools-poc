/**
 * loader.mjs — turns a remote registry manifest into just-bash custom commands.
 *
 * Trust model: phase 1 is "trusted" — bundles are imported via `data:` URL
 * and run in the host Node process with whatever capabilities we hand them
 * via `ctx`. This keeps the loader tiny and avoids QuickJS for the POC.
 * Phase 2 will swap import() for `js-exec` to sandbox community contributions.
 */
import { defineCommand } from 'just-bash';
import { parseArgvAgainstSchema, coerceArgvValue } from './arg-parser.mjs';

const DEFAULT_REGISTRY = 'https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@main/dist';

// Re-exported for backwards compatibility with existing tests
// (test/loader.test.mjs imports parseArgs and coerce from this module).
export const parseArgs = parseArgvAgainstSchema;
export const coerce    = coerceArgvValue;

export async function loadRegistry(opts = {}) {
  const base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '');
  const r = await fetch(`${base}/manifest.json`);
  if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
  const manifest = await r.json();

  const handlerCache = new Map();
  const allowedHosts = new Set();
  for (const t of manifest.tools) {
    for (const h of t.networkPolicy?.allow ?? []) allowedHosts.add(h);
  }

  const commands = manifest.tools.map((tool) =>
    defineCommand(tool.slug, async (args, ctx) => {
      try {
        const input = parseArgvAgainstSchema(args, ctx.stdin, tool.inputSchema);

        if (!handlerCache.has(tool.slug)) {
          const url = `${base}/${tool.source}`;
          const code = await fetch(url).then((r) => {
            if (!r.ok) throw new Error(`Bundle fetch failed: ${r.status}`);
            return r.text();
          });
          const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
          const mod = await import(dataUrl);
          handlerCache.set(tool.slug, mod.default);
        }

        const handler = handlerCache.get(tool.slug);
        const toolCtx = makeToolCtx(tool, ctx);
        const output = await handler(input, toolCtx);
        return { stdout: JSON.stringify(output) + '\n', stderr: '', exitCode: 0 };
      } catch (e) {
        return { stdout: '', stderr: `${tool.slug}: ${e.message}\n`, exitCode: 1 };
      }
    })
  );

  return { manifest, commands };
}

function makeToolCtx(tool, bashCtx) {
  const allow = new Set(tool.networkPolicy?.allow ?? []);
  return {
    fetch: async (url, init) => {
      const host = new URL(url).host;
      if (!allow.has(host)) {
        throw new Error(`network: host "${host}" not allowed (tool ${tool.slug})`);
      }
      return globalThis.fetch(url, init);
    },
    env: filterEnv(bashCtx.env, tool.requiredEnv ?? []),
    log: (msg) => bashCtx.stderr?.write?.(`[${tool.slug}] ${msg}\n`)
      ?? process.stderr.write(`[${tool.slug}] ${msg}\n`),
  };
}

function filterEnv(env, allowed) {
  const out = {};
  for (const k of allowed) if (env[k] != null) out[k] = env[k];
  return out;
}

// parseArgvAgainstSchema and coerceArgvValue live in ./arg-parser.mjs.
// Re-exported above as `parseArgs` and `coerce` for the existing test suite.
