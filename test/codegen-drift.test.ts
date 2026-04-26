/**
 * codegen-drift.test.ts — integration test for `npm run codegen:check`.
 *
 * The unit tests in jsonschema-to-ts.test.ts cover the converter in
 * isolation, but the *guardrail* — that CI fails when tool.yaml changes
 * without re-running codegen — has no unit-level coverage. Without this
 * test, someone disabling the drift check is invisible until a real
 * schema diverges in production.
 *
 * We exercise it by:
 *   1. Spawning the CLI in `--check` mode against the current registry
 *      → must exit 0 (everything in sync).
 *   2. Snapshotting and corrupting one generated file, then re-running
 *      → must exit 1 with a clear "out of date" message.
 *   3. Restoring, verifying we're back to clean.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'codegen-types.ts');

// Pick a stable target file we can corrupt and restore.
const TARGET = join(ROOT, 'registry', 'skills', 'echo-pretty', 'src', 'types.gen.ts');

function runCheck(): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('codegen:check passes when generated files match tool.yaml', () => {
  const r = runCheck();
  assert.equal(r.code, 0, `expected exit 0; stderr was:\n${r.stderr}`);
  assert.match(r.stdout, /up-to-date/);
});

test('codegen:check FAILS when a generated file is corrupted', () => {
  // Snapshot the current contents so we can restore even if assertions throw.
  const snapshot = readFileSync(TARGET, 'utf8');
  let restored = false;
  const restore = () => { if (!restored) { writeFileSync(TARGET, snapshot); restored = true; } };
  // Belt + suspenders: also restore on test-process exit.
  after(restore);

  try {
    // Corrupt the file by appending a stale stray comment that codegen
    // would never produce.
    writeFileSync(TARGET, snapshot + '\n// drift test — should not be here\n');

    const r = runCheck();
    assert.equal(r.code, 1, `expected exit 1 on drift; got ${r.code}`);
    // The error message should name the affected skill and point at the fix.
    assert.match(
      r.stderr + r.stdout,
      /echo-pretty.*out of date|stale generated|Run.*codegen/i,
      `expected drift message mentioning the skill; got:\n${r.stderr}\n${r.stdout}`,
    );
  } finally {
    restore();
  }

  // Sanity: after restore, check should pass again.
  const after2 = runCheck();
  assert.equal(after2.code, 0, 'check should pass after restore');
});
