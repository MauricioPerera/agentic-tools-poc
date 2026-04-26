/**
 * loader-mode.test.ts — regression test for the loader's execution-mode
 * dispatch (`mode: 'sandbox' | 'trust'`).
 *
 * Why this exists: the trust-mode escape hatch in `client/loader.ts`
 * (Phase 1 in-process `import()` of a `data:` URL) is documented as
 * development-only, but it's still a code path that must work — debug
 * sessions and the perf-comparison tooling rely on it. Without an
 * explicit test, a future refactor that "tidies" the loader could
 * silently break trust mode and nobody notices until someone tries to
 * profile a hot-loop or repro a sandbox-only bug.
 *
 * The test stands up a tiny in-memory registry (manifest + bundle on
 * disk, no network) and runs the same input through both modes:
 *   - default (sandbox) — proves the new path still handles a basic call
 *   - mode: 'trust'    — proves the legacy path still handles the same
 *
 * Output equality across modes is the contract: same input → same JSON
 * output → handler is mode-agnostic from the caller's POV.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bash } from 'just-bash';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../client/loader.ts';

let workDir: string;

// A bundle that exercises the parts both modes have to handle: input
// arg use, ctx.log call, async return, JSON-shaped result.
const ECHO_BUNDLE = `
async function echoHandler(input, ctx) {
  ctx.log('echo: got ' + (input.text ?? '<empty>'));
  return { text: String(input.text ?? '').toUpperCase(), len: String(input.text ?? '').length };
}
export { echoHandler as default };
`.trim();

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loader-mode-'));
  mkdirSync(join(workDir, 'skills'), { recursive: true });
  writeFileSync(join(workDir, 'skills', 'echo-mode.mjs'), ECHO_BUNDLE);
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify({
    registryVersion: '1.0',
    generatedAt: 'test',
    commit: null,
    tools: [{
      slug: 'echo-mode',
      name: 'Echo Mode',
      summary: 'Test fixture',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', description: 'text to echo' } },
      },
      outputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          len:  { type: 'integer' },
        },
      },
      source: 'skills/echo-mode.mjs',
      // No sha256 — keeps the fixture editable without recomputing it
      // every time. Integrity check is exercised separately in
      // loader-integrity.test.ts.
    }],
  }));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('loader-mode: default (sandbox) produces expected output', async () => {
  const { commands } = await loadRegistry({ registry: workDir });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echo-mode --text hello');
  assert.equal(r.exitCode, 0, `expected exit 0, got: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { text: string; len: number };
  assert.equal(parsed.text, 'HELLO');
  assert.equal(parsed.len, 5);
});

test('loader-mode: trust mode produces the SAME output as sandbox', async () => {
  // Explicit opt-in via the loader option (matches what a debug session
  // would do via LOADER_MODE=trust env). The contract: any input that
  // works in sandbox must produce the identical output in trust mode.
  const { commands } = await loadRegistry({ registry: workDir, mode: 'trust' });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echo-mode --text hello');
  assert.equal(r.exitCode, 0, `expected exit 0, got: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { text: string; len: number };
  assert.equal(parsed.text, 'HELLO');
  assert.equal(parsed.len, 5);
});

test('loader-mode: trust mode honours ctx.log output', async () => {
  // ctx.log writes to bashCtx.stderr.write when present, falling back to
  // process.stderr. Either way, a successful run leaves stdout clean.
  const { commands } = await loadRegistry({ registry: workDir, mode: 'trust' });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echo-mode --text test');
  assert.equal(r.exitCode, 0);
  // Stdout should be ONLY the JSON result, not log noise.
  assert.match(r.stdout, /^{[\s\S]*}\s*$/);
});

test('loader-mode: env variable LOADER_MODE=trust takes effect when option not supplied', async () => {
  const prev = process.env['LOADER_MODE'];
  process.env['LOADER_MODE'] = 'trust';
  try {
    const { commands } = await loadRegistry({ registry: workDir });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('echo-mode --text envcheck');
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout) as { text: string };
    assert.equal(parsed.text, 'ENVCHECK');
  } finally {
    if (prev === undefined) delete process.env['LOADER_MODE'];
    else process.env['LOADER_MODE'] = prev;
  }
});

test('loader-mode: explicit option overrides LOADER_MODE env', async () => {
  // Caller-passed mode wins over env. Exercise the precedence path so a
  // future refactor that inverts it gets caught.
  const prev = process.env['LOADER_MODE'];
  process.env['LOADER_MODE'] = 'trust';
  try {
    const { commands } = await loadRegistry({ registry: workDir, mode: 'sandbox' });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('echo-mode --text precedence');
    assert.equal(r.exitCode, 0, `expected exit 0, got: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as { text: string };
    assert.equal(parsed.text, 'PRECEDENCE');
  } finally {
    if (prev === undefined) delete process.env['LOADER_MODE'];
    else process.env['LOADER_MODE'] = prev;
  }
});

test('loader-mode: handler error in trust mode surfaces as exit 1 with stderr', async () => {
  // Build a one-off bundle that throws. trust mode + sandbox mode should
  // both produce exit code 1 with the error message in stderr.
  const errDir = mkdtempSync(join(tmpdir(), 'loader-mode-err-'));
  try {
    mkdirSync(join(errDir, 'skills'), { recursive: true });
    writeFileSync(
      join(errDir, 'skills', 'boom.mjs'),
      `async function h(){ throw new Error('intentional boom'); }\nexport { h as default };`,
    );
    writeFileSync(join(errDir, 'manifest.json'), JSON.stringify({
      registryVersion: '1.0',
      generatedAt: 'test',
      commit: null,
      tools: [{
        slug: 'boom',
        name: 'Boom',
        summary: 'throws',
        version: '1.0.0',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        source: 'skills/boom.mjs',
      }],
    }));
    const { commands } = await loadRegistry({ registry: errDir, mode: 'trust' });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('boom');
    assert.equal(r.exitCode, 1, 'expected non-zero exit on handler throw');
    assert.match(r.stderr, /intentional boom/);
  } finally {
    rmSync(errDir, { recursive: true, force: true });
  }
});
