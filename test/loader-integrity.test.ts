/**
 * loader-integrity.test.ts — verifies the sha256 integrity check in
 * client/loader.ts catches a tampered bundle.
 *
 * The threat: someone (or something) modifies a bundle on disk / in
 * the dist branch / in jsDelivr's cache. Without sha256 verification,
 * the loader silently imports the modified code. With it, the loader
 * refuses and surfaces a clear error.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bash } from 'just-bash';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../client/loader.ts';

let workDir: string;
let manifestPath: string;
let bundlePath: string;

const MINIMAL_BUNDLE = `export default async function handler(input, ctx) {
  return { ok: true, echoed: input.text };
}`;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'loader-integrity-'));
  mkdirSync(join(workDir, 'skills'), { recursive: true });
  bundlePath = join(workDir, 'skills', 'echo-test.mjs');
  writeFileSync(bundlePath, MINIMAL_BUNDLE);

  // Compute the real sha256 so the manifest is valid by default.
  const sha = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');

  manifestPath = join(workDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    registryVersion: '1.0',
    generatedAt: 'test',
    commit: null,
    tools: [{
      slug: 'echo-test',
      name: 'Echo Test',
      summary: 'Test fixture',
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      source: 'skills/echo-test.mjs',
      sha256: sha,
    }],
  }));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path

test('integrity: load succeeds when bundle sha256 matches manifest', async () => {
  const { manifest, commands } = await loadRegistry({ registry: workDir });
  assert.equal(manifest.tools.length, 1);
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echo-test');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /"ok":true/);
});

// ---------------------------------------------------------------------------
// Tampering — bundle modified after manifest was written

test('integrity: load FAILS with clear error when bundle has been tampered with', async () => {
  // Snapshot original content so we can restore
  const original = readFileSync(bundlePath, 'utf8');
  try {
    // Tamper: append a comment that changes the sha256
    writeFileSync(bundlePath, original + '\n// malicious payload\n');

    // Re-load — the manifest's sha256 still points at the original
    const { commands } = await loadRegistry({ registry: workDir });
    const bash = new Bash({ customCommands: commands as never });
    const r = await bash.exec('echo-test');

    // The handler import should have failed → exit 1, stderr explains
    assert.equal(r.exitCode, 1, 'expected exec to fail when bundle is tampered');
    assert.match(r.stderr, /integrity/i);
    assert.match(r.stderr, /sha256/i);
  } finally {
    writeFileSync(bundlePath, original);
  }
});

test('integrity: backwards-compatible — loads when manifest omits sha256', async () => {
  // Old manifests / registries without sha256 still work (no enforcement)
  const oldManifestPath = join(workDir, 'manifest-no-sha.json');
  const oldDir = join(workDir, 'no-sha-variant');
  mkdirSync(join(oldDir, 'skills'), { recursive: true });
  writeFileSync(join(oldDir, 'skills', 'echo-test.mjs'), MINIMAL_BUNDLE);
  writeFileSync(join(oldDir, 'manifest.json'), JSON.stringify({
    registryVersion: '1.0',
    generatedAt: 'test',
    commit: null,
    tools: [{
      slug: 'echo-test',
      name: 'Echo Test',
      summary: 'Test fixture without sha256',
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      source: 'skills/echo-test.mjs',
      // No sha256 field — older manifest
    }],
  }));

  const { commands } = await loadRegistry({ registry: oldDir });
  const bash = new Bash({ customCommands: commands as never });
  const r = await bash.exec('echo-test');
  assert.equal(r.exitCode, 0, 'expected backwards compatibility for manifests without sha256');
});
