/**
 * loader-pin.test.ts — end-to-end test for `loadRegistry({ pin: ... })`.
 *
 * Stands up an in-memory registry with TWO archived versions of the same
 * skill (1.0.0 and 1.1.0, intentionally different bundles). Verifies:
 *   1. No pin → loads the latest (1.1.0).
 *   2. Pin to 1.0.0 → loads the older bundle (and can tell the difference
 *      via the bundle's actual output).
 *   3. Pin to ^1.0.0 → loads the highest matching (1.1.0).
 *   4. Pin to nonexistent range → throws at exec time with a clear error.
 *   5. Tampered versioned bundle (sha256 mismatch in manifest) is rejected
 *      with the integrity-check error, same as the latest-bundle path.
 *   6. Different pins for the same slug across two loadRegistry calls
 *      don't share a stale cache (each loader instance has its own state).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bash } from 'just-bash';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../client/loader.ts';

let workDir: string;

const BUNDLE_V1_0 = `
async function h(input) {
  return { text: 'v1.0.0', echo: String(input.text ?? '') };
}
export { h as default };
`.trim();

const BUNDLE_V1_1 = `
async function h(input) {
  return { text: 'v1.1.0', echo: String(input.text ?? '').toUpperCase() };
}
export { h as default };
`.trim();

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loader-pin-'));
  mkdirSync(join(workDir, 'skills'), { recursive: true });

  // Two archived versions plus the "latest" copy (= 1.1.0 contents).
  writeFileSync(join(workDir, 'skills', 'echoer.mjs'),         BUNDLE_V1_1);
  writeFileSync(join(workDir, 'skills', 'echoer@1.0.0.mjs'),   BUNDLE_V1_0);
  writeFileSync(join(workDir, 'skills', 'echoer@1.1.0.mjs'),   BUNDLE_V1_1);

  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify({
    registryVersion: '1.0',
    generatedAt: 'test',
    commit: null,
    tools: [{
      slug: 'echoer',
      name: 'Echoer',
      summary: 'pin-test fixture',
      version: '1.1.0',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', description: 'echo input' } },
      },
      outputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          echo: { type: 'string' },
        },
      },
      source: 'skills/echoer.mjs',
      sha256: sha(BUNDLE_V1_1),
      versions: [
        { version: '1.1.0', source: 'skills/echoer@1.1.0.mjs', sha256: sha(BUNDLE_V1_1) },
        { version: '1.0.0', source: 'skills/echoer@1.0.0.mjs', sha256: sha(BUNDLE_V1_0) },
      ],
    }],
  }));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy paths

test('loader-pin: no pin → loads the latest (1.1.0) bundle', async () => {
  const { commands } = await loadRegistry({ registry: workDir });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echoer --text hello');
  assert.equal(r.exitCode, 0, `expected exit 0, got ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { text: string; echo: string };
  assert.equal(parsed.text, 'v1.1.0');
  assert.equal(parsed.echo, 'HELLO', '1.1.0 uppercases the echo');
});

test('loader-pin: pin to 1.0.0 → loads the older bundle (different behaviour)', async () => {
  const { commands } = await loadRegistry({ registry: workDir, pin: { echoer: '1.0.0' } });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echoer --text hello');
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout) as { text: string; echo: string };
  assert.equal(parsed.text, 'v1.0.0');
  assert.equal(parsed.echo, 'hello', '1.0.0 echoes verbatim, no uppercase');
});

test('loader-pin: pin to ^1.0.0 → resolves to the highest matching (1.1.0)', async () => {
  const { commands } = await loadRegistry({ registry: workDir, pin: { echoer: '^1.0.0' } });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echoer --text hi');
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout) as { text: string };
  assert.equal(parsed.text, 'v1.1.0');
});

test('loader-pin: pin to ~1.0.0 → patches only, locks to 1.0.0', async () => {
  // Tilde excludes minor bumps. Available is 1.0.0 and 1.1.0 → must pick 1.0.0.
  const { commands } = await loadRegistry({ registry: workDir, pin: { echoer: '~1.0.0' } });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echoer --text x');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /"text":"v1\.0\.0"/);
});

// ---------------------------------------------------------------------------
// Failure paths

test('loader-pin: pin to a range with no matching version surfaces a clear error', async () => {
  const { commands } = await loadRegistry({ registry: workDir, pin: { echoer: '^2.0.0' } });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echoer --text x');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /pin error/);
  assert.match(r.stderr, /\^2\.0\.0/);
  assert.match(r.stderr, /Available: 1\.1\.0, 1\.0\.0/);
});

test('loader-pin: tampered versioned bundle fails the integrity check', async () => {
  // Snapshot then tamper: mutate echoer@1.0.0.mjs but keep the manifest's
  // sha256 (the old one). Loader must refuse to load.
  const path = join(workDir, 'skills', 'echoer@1.0.0.mjs');
  const original = BUNDLE_V1_0;
  try {
    writeFileSync(path, original + '\n// malicious payload\n');
    const { commands } = await loadRegistry({ registry: workDir, pin: { echoer: '1.0.0' } });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('echoer --text hi');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /integrity check failed/i);
    assert.match(r.stderr, /sha256/i);
  } finally {
    writeFileSync(path, original);
  }
});

test('loader-pin: pin on a slug with no versions[] in manifest surfaces a clear error', async () => {
  // Build a manifest with no versions[] to confirm the "manifest predates
  // versioning" error path. This is the migration-window scenario.
  const oldDir = mkdtempSync(join(tmpdir(), 'loader-pin-old-'));
  try {
    mkdirSync(join(oldDir, 'skills'), { recursive: true });
    writeFileSync(join(oldDir, 'skills', 'old.mjs'), BUNDLE_V1_0);
    writeFileSync(join(oldDir, 'manifest.json'), JSON.stringify({
      registryVersion: '1.0',
      generatedAt: 'test',
      commit: null,
      tools: [{
        slug: 'old',
        name: 'Old',
        summary: 'no versions[]',
        version: '1.0.0',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string', description: 'in' } },
        },
        outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        source: 'skills/old.mjs',
        // No versions[] — pre-versioning manifest shape.
      }],
    }));

    const { commands } = await loadRegistry({ registry: oldDir, pin: { old: '^1.0.0' } });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('old --text x');
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /no versions\[\]/);
  } finally {
    rmSync(oldDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cache isolation

test('loader-pin: separate loadRegistry calls with different pins do not share state', async () => {
  // Two independent loaders with conflicting pins. Each must produce its
  // own bundle resolution; no cross-contamination.
  const lA = await loadRegistry({ registry: workDir, pin: { echoer: '1.0.0' } });
  const lB = await loadRegistry({ registry: workDir, pin: { echoer: '1.1.0' } });

  const bashA = new Bash({ customCommands: lA.commands as never });
  const bashB = new Bash({ customCommands: lB.commands as never });

  const rA = await bashA.exec('echoer --text z');
  const rB = await bashB.exec('echoer --text z');

  assert.match(rA.stdout, /"text":"v1\.0\.0"/);
  assert.match(rB.stdout, /"text":"v1\.1\.0"/);
});
