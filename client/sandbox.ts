/**
 * sandbox.ts — runs untrusted handler bundles inside a QuickJS VM.
 *
 * THREAT-MODEL.md V2 (real, runtime). Phase 1 ran handlers via in-process
 * `import()` of a `data:` URL — they had full Node.js capabilities and the
 * `ctx` object was a convention, not a sandbox. This module replaces that
 * with `quickjs-emscripten`: handlers run in a WASM-isolated VM with no
 * Node API surface, no `process`, no `fs`, no raw socket. They can only
 * do what the curated bridge below exposes.
 *
 * The bridge surface (intentionally small):
 *   - `globalThis.fetch(url, init?)` — proxied to host with allowlist
 *   - `ctx.fetch` — alias of the same proxy (matches Phase 1 contract)
 *   - `ctx.log(msg)` — writes to stderr
 *   - `ctx.env[key]` — pre-filtered by `requiredEnv`
 *   - all standard ES2023 built-ins: JSON, URL, URLSearchParams, etc.
 *
 * Anything else a handler reaches for (`process`, `require`, `import('node:fs')`,
 * `Buffer`, `setImmediate`, etc.) is `undefined` in the VM. There is no
 * runtime escape hatch — that's the point.
 *
 * Performance note: a fresh VM is created per handler call. Measured cost on
 * a modern host: ~134 ms cold (one-time WASM module init, amortised across
 * the whole process), 7-8 ms warm per call (VM creation + bundle parse +
 * handler exec). `compileHandler` below caches the parsed/rewritten bundle
 * source so the second invocation of the same skill skips the regex pass;
 * the WASM module itself is a process-lifetime singleton (see `getModule`).
 */
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten';
import type {
  QuickJSAsyncContext,
  QuickJSAsyncWASMModule,
  QuickJSHandle,
} from 'quickjs-emscripten';
import type { ToolContext } from '../types/index.ts';

// ---------------------------------------------------------------------------
// Module-level singleton — initialising the WASM runtime is expensive (~100 ms
// the first time, observed 134 ms in practice), so we keep one instance alive
// for the lifetime of the process. Each handler call still gets its own
// isolated context.
//
// We clear the cached promise on failure so a transient init error (out of
// memory, fs error loading the .wasm) doesn't poison every subsequent call
// for the lifetime of the process. Without this, one bad start = permanent
// "sandbox unavailable" until the host restarts.

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
async function getModule(): Promise<QuickJSAsyncWASMModule> {
  if (!modulePromise) modulePromise = newQuickJSAsyncWASMModule();
  try {
    return await modulePromise;
  } catch (e) {
    modulePromise = null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Minimal URLSearchParams polyfill — QuickJS core does not ship it. Surface
// covers what real handlers in this registry actually use: construction from
// object/iterable/string, set/append/get/has/delete, toString(), iteration.
// `URL` itself is NOT polyfilled — no shipped handler uses `new URL(...)`. If
// a future handler needs it, add a polyfill here and a sandbox parity test;
// don't import a node URL implementation (would defeat the sandbox boundary).
const URL_POLYFILL = `
if (typeof URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = class URLSearchParams {
    constructor(init) {
      this._pairs = [];
      if (!init) return;
      if (typeof init === 'string') {
        const s = init.startsWith('?') ? init.slice(1) : init;
        if (!s) return;
        for (const p of s.split('&')) {
          const eq = p.indexOf('=');
          const k = decodeURIComponent((eq < 0 ? p : p.slice(0, eq)).replace(/\\+/g, ' '));
          const v = eq < 0 ? '' : decodeURIComponent(p.slice(eq + 1).replace(/\\+/g, ' '));
          this._pairs.push([k, v]);
        }
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this._pairs.push([String(k), String(v)]);
      } else if (typeof init === 'object') {
        for (const k of Object.keys(init)) this._pairs.push([k, String(init[k])]);
      }
    }
    set(k, v)    { this._pairs = this._pairs.filter(([kk]) => kk !== k); this._pairs.push([String(k), String(v)]); }
    append(k, v) { this._pairs.push([String(k), String(v)]); }
    get(k)       { const p = this._pairs.find(([kk]) => kk === k); return p ? p[1] : null; }
    has(k)       { return this._pairs.some(([kk]) => kk === k); }
    delete(k)    { this._pairs = this._pairs.filter(([kk]) => kk !== k); }
    toString()   { return this._pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
    *entries()   { for (const p of this._pairs) yield p; }
    [Symbol.iterator]() { return this.entries(); }
  };
}
`;

// ---------------------------------------------------------------------------
// Bridge JS that runs inside the sandbox and wires `__hostFetch` (an
// asyncified host function) into a Response-like that handlers expect.
//
// We read the response body eagerly on the host side so the bridge needs only
// ONE async crossing per fetch — bridging .json()/.text() lazily would require
// asyncifying every method call, which is slower and more complex.
const FETCH_SHIM = `
globalThis.fetch = async function fetch(url, init) {
  const u = typeof url === 'string' ? url
           : (url && typeof url.toString === 'function') ? url.toString() : String(url);
  const initSerialised = init ? JSON.stringify({
    method: init.method || 'GET',
    headers: init.headers || {},
    body: typeof init.body === 'string' ? init.body : null,
  }) : null;
  const raw = await __hostFetch(u, initSerialised);
  // raw = { ok, status, headers, body, contentType }
  const r = JSON.parse(raw);
  const headersMap = r.headers || {};
  return {
    ok: r.ok,
    status: r.status,
    headers: {
      get: (k) => headersMap[String(k).toLowerCase()] ?? null,
    },
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
};
`;

// ---------------------------------------------------------------------------
// Public API

export interface SandboxResult<T> {
  ok: true;
  value: T;
}
export interface SandboxError {
  ok: false;
  error: string;
  isViolation: boolean; // true if the failure was a security boundary violation
}

/**
 * Compile a handler bundle into a string of JS suitable for the sandbox. We
 * accept either pure ESM (`export default async function …`) or a bundle that
 * sets `module.exports.default`. The compiled form is `(async () => { …;
 * return DEFAULT })()` so the sandbox can `evalCode` it and get a promise of
 * the handler back.
 *
 * Cached by source-hash because parsing is the dominant cost.
 */
const compiledCache = new Map<string, string>();
export function compileHandler(bundleSource: string): string {
  const cached = compiledCache.get(bundleSource);
  if (cached) return cached;

  // esbuild bundles use ESM `export default`. QuickJS in script mode does
  // not understand `export`, so we strip the keyword and capture the default
  // value into a sentinel local. Module mode would work too but it requires
  // more plumbing for a single default export.
  // Patterns we handle:
  //   export default <expr>;
  //   export default function name(...) { ... }
  //   export default async function name(...) { ... }
  //   var <name>_default = <expr>;\nexport { <name>_default as default };
  let body = bundleSource;

  // esbuild's typical output for a default export ends with:
  //   export { <name>_default as default };
  // and earlier defines `var <name>_default = ...;`. We rewrite the export
  // statement into an assignment of __defaultExport.
  body = body.replace(
    /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}\s*;?\s*$/m,
    'globalThis.__defaultExport = $1;',
  );
  // Direct `export default <expr>` form
  body = body.replace(
    /export\s+default\s+/g,
    'globalThis.__defaultExport = ',
  );
  // Strip any other `export { ... }` (named exports, irrelevant in sandbox)
  body = body.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  // Strip stray `export ` keyword in front of declarations (esbuild rarely emits these)
  body = body.replace(/^\s*export\s+/gm, '');

  const wrapped =
    `(function(){\n${body}\n;return globalThis.__defaultExport;})()`;
  compiledCache.set(bundleSource, wrapped);
  return wrapped;
}

/**
 * Run a single handler call in a fresh sandbox.
 *
 * This is the trust boundary. A return value here was produced by code that
 * could not touch the host filesystem, environment, network (except via the
 * allowlisted ctx.fetch), or process state.
 */
export async function runHandlerSandboxed<T = unknown>(
  bundleSource: string,
  input: unknown,
  ctx: ToolContext,
  opts: { timeoutMs?: number } = {},
): Promise<SandboxResult<T> | SandboxError> {
  const mod = await getModule();
  const vm = mod.newContext();
  const disposables: QuickJSHandle[] = [];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  // Interrupt handler — fires periodically while VM code runs. Returning
  // truthy throws InternalError inside the VM, breaking out of any loop
  // (including `while(true){}` which executePendingJobs cannot preempt).
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);

  try {
    // ─── Bridge: __hostFetch ──────────────────────────────────────────────
    // Asyncified host function. Receives (url, initJson) as VM strings,
    // returns a JSON string the in-VM shim parses into a Response-like.
    const fetchFn = vm.newAsyncifiedFunction('__hostFetch', async (urlH, initH) => {
      const url = vm.getString(urlH);
      const initJson = initH ? vm.getString(initH) : null;
      const init = initJson ? (JSON.parse(initJson) as RequestInit) : undefined;
      // Allowlist enforcement happens inside ctx.fetch (loader's makeToolCtx).
      const res = await ctx.fetch(url, init);
      const body = await res.text();
      const headersOut: Record<string, string> = {};
      res.headers.forEach((v, k) => { headersOut[k.toLowerCase()] = v; });
      const payload = JSON.stringify({
        ok: res.ok,
        status: res.status,
        headers: headersOut,
        body,
      });
      return vm.newString(payload);
    });
    fetchFn.consume((h) => vm.setProp(vm.global, '__hostFetch', h));

    // ─── Bridge: ctx.log ──────────────────────────────────────────────────
    const logFn = vm.newFunction('__hostLog', (msgH) => {
      ctx.log(vm.getString(msgH));
      return vm.undefined;
    });
    logFn.consume((h) => vm.setProp(vm.global, '__hostLog', h));

    // ─── Bridge: env (a plain object with the pre-filtered subset) ────────
    const envH = vm.newObject();
    for (const [k, v] of Object.entries(ctx.env)) {
      const valH = vm.newString(v);
      vm.setProp(envH, k, valH);
      valH.dispose();
    }
    vm.setProp(vm.global, '__hostEnv', envH);
    envH.dispose();

    // ─── Inject URL polyfill + fetch shim + assemble ctx ──────────────────
    // We do NOT delete __hostFetch / __hostLog / __hostEnv afterwards: the
    // fetch shim references __hostFetch by name (not by closure capture), so
    // removing it would break every later fetch call. The bridge fns enforce
    // their own constraints — networkPolicy.allow is checked on the host
    // side regardless of which name a handler calls them by.
    const setupCode =
      URL_POLYFILL +
      FETCH_SHIM +
      `
globalThis.ctx = {
  fetch: globalThis.fetch,
  log: __hostLog,
  env: __hostEnv,
};
`;
    const setupResult = vm.evalCode(setupCode);
    if (setupResult.error) {
      const err = vm.dump(setupResult.error);
      setupResult.error.dispose();
      return { ok: false, error: `sandbox setup failed: ${stringifyError(err)}`, isViolation: false };
    }
    setupResult.value.dispose();

    // ─── Compile + load the handler bundle ────────────────────────────────
    // We assemble one async IIFE that loads the bundle (which sets
    // globalThis.__defaultExport) and then awaits handler(input, ctx). Using
    // `evalCodeAsync` (rather than callFunction) lets the asyncified runtime
    // drive its own event loop while __hostFetch is in flight — without it
    // the VM would freeze waiting for a job-pump that never runs.
    const wrappedSrc = compileHandler(bundleSource);
    const inputJson = JSON.stringify(input ?? null);
    const driver = `
(async () => {
  ${wrappedSrc};
  const handler = globalThis.__defaultExport;
  if (typeof handler !== 'function') {
    throw new Error('bundle did not export a default function');
  }
  const input = ${inputJson};
  return await handler(input, globalThis.ctx);
})()
`;

    const evalResult = await Promise.race([
      vm.evalCodeAsync(driver),
      timeoutPromise(timeoutMs),
    ]);
    if (evalResult === '__sandbox_timeout__') {
      return { ok: false, error: `handler timed out after ${timeoutMs}ms`, isViolation: true };
    }
    if (evalResult.error) {
      const err = vm.dump(evalResult.error);
      evalResult.error.dispose();
      return classifyError(err, deadline, timeoutMs);
    }
    const promiseH = evalResult.value;
    disposables.push(promiseH);

    // We poll getPromiseState rather than vm.resolvePromise — the latter
    // hangs in this version of quickjs-emscripten when the asyncified
    // runtime's promise was created inside an async host fn return path.
    // executePendingJobs pumps any microtasks that landed since our last
    // check; getPromiseState returns the fulfilled/rejected/pending status.
    const settled = await pollUntilSettled(vm, promiseH, timeoutMs);
    if (settled.kind === 'timeout') {
      return { ok: false, error: `handler timed out after ${timeoutMs}ms`, isViolation: true };
    }
    if (settled.kind === 'rejected') {
      const err = vm.dump(settled.handle);
      settled.handle.dispose();
      return classifyError(err, deadline, timeoutMs);
    }
    const value = vm.dump(settled.handle) as T;
    settled.handle.dispose();
    return { ok: true, value };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      isViolation: false,
    };
  } finally {
    for (const h of disposables) {
      try { h.dispose(); } catch { /* ignore double-dispose */ }
    }
    try { vm.dispose(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers

function timeoutPromise(ms: number): Promise<'__sandbox_timeout__'> {
  return new Promise((resolve) => setTimeout(() => resolve('__sandbox_timeout__'), ms));
}

type SettledOutcome =
  | { kind: 'fulfilled'; handle: QuickJSHandle }
  | { kind: 'rejected';  handle: QuickJSHandle }
  | { kind: 'timeout' };

/**
 * Pump the asyncified runtime's job queue and inspect a promise's state until
 * it settles. quickjs-emscripten's `vm.resolvePromise` would normally be the
 * way; in the version we're pinned to it can hang when the in-VM promise
 * was created via an asyncified host fn return — so we drive it ourselves.
 */
async function pollUntilSettled(
  vm: QuickJSAsyncContext,
  promiseH: QuickJSHandle,
  timeoutMs: number,
): Promise<SettledOutcome> {
  const deadline = Date.now() + timeoutMs;
  // Tight initial loop; back off as time goes on so a long-running fetch
  // doesn't burn CPU but a fast handler still settles in <1ms total wall.
  let backoffMs = 0;
  while (Date.now() < deadline) {
    vm.runtime.executePendingJobs();
    const state = vm.getPromiseState(promiseH);
    if (state.type === 'fulfilled') return { kind: 'fulfilled', handle: state.value };
    if (state.type === 'rejected')  return { kind: 'rejected',  handle: state.error };
    // pending — yield to the host event loop so async host fns (fetch) advance.
    await new Promise((r) => setTimeout(r, backoffMs));
    if (backoffMs < 16) backoffMs = backoffMs === 0 ? 1 : Math.min(backoffMs * 2, 16);
  }
  return { kind: 'timeout' };
}

function stringifyError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as { name?: string; message?: string; stack?: string };
    return o.message ?? o.name ?? JSON.stringify(e);
  }
  return String(e);
}

/**
 * QuickJS reports interrupt-handler aborts as InternalError("interrupted").
 * Promote those to the timeout/violation classification — semantically they
 * are the deadline firing, not a handler-thrown error.
 */
function classifyError(err: unknown, deadline: number, timeoutMs: number): SandboxError {
  const msg = stringifyError(err);
  if (/interrupted/i.test(msg) || Date.now() > deadline) {
    return {
      ok: false,
      error: `handler timed out after ${timeoutMs}ms (interrupt)`,
      isViolation: true,
    };
  }
  return { ok: false, error: msg, isViolation: false };
}

// (jsToHandle removed — input now serialised as JSON inside the driver IIFE.)
