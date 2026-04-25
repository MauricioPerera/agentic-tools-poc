/**
 * loader.mjs — turns a remote registry manifest into just-bash custom commands.
 *
 * Trust model: phase 1 is "trusted" — bundles are imported via `data:` URL
 * and run in the host Node process with whatever capabilities we hand them
 * via `ctx`. This keeps the loader tiny and avoids QuickJS for the POC.
 * Phase 2 will swap import() for `js-exec` to sandbox community contributions.
 */
import { defineCommand } from 'just-bash';

const DEFAULT_REGISTRY = 'https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@main/dist';

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
        const input = parseArgs(args, ctx.stdin, tool.inputSchema);

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

/**
 * Parses argv + stdin into an `input` object that conforms to the JSONSchema.
 * Tiny but functional: --flag, --key=val, --key val, boolean coercion from
 * defaults, and stdin read into the first string field if no positional given.
 */
function parseArgs(args, stdin, schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const out = {};

  for (const [k, def] of Object.entries(props)) {
    if (def.default !== undefined) out[k] = def.default;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    let key, val;
    if (a.includes('=')) [key, val] = [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    else { key = a.slice(2); val = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : true; }
    out[key] = coerce(val, props[key]?.type);
  }

  if (stdin && stdin.length > 0) {
    const firstStringField = Object.entries(props).find(([, d]) => d.type === 'string' && !(out[Object.keys(props)[0]]));
    if (firstStringField && out[firstStringField[0]] === undefined) {
      out[firstStringField[0]] = stdin.replace(/\n$/, '');
    }
  }

  for (const k of required) {
    if (out[k] === undefined) throw new Error(`missing required input: --${k}`);
  }
  return out;
}

function coerce(val, type) {
  if (val === true || val === false) return val;
  if (type === 'boolean') return val === 'true' || val === true;
  if (type === 'integer' || type === 'number') return Number(val);
  return String(val);
}
