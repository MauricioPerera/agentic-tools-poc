/**
 * manifest-versioning.test.ts — covers the guarantees the manifest builder
 * makes for per-skill versioning (closes #2):
 *
 *   1. First-time build of a skill copies <slug>.mjs to <slug>@<v>.mjs
 *      (creates the archive entry).
 *   2. Second build with the same version + identical bundle is a no-op
 *      (idempotent — re-running the build doesn't churn the archive).
 *   3. Second build with the same version but DIFFERENT bundle is a hard
 *      error: "you bumped the bundle without bumping the version" — the
 *      whole point of the per-skill version-bump guard.
 *   4. Bumping the version + changing the bundle creates a new archive
 *      entry alongside the old one. Both end up in versions[], sorted
 *      highest first.
 *
 * Each test runs `node scripts/manifest.ts` against a synthetic
 * registry/dist pair on disk so the assertions exercise the actual file
 * I/O and child-process behaviour the CI sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  cpSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

interface Manifest {
  tools: Array<{
    slug: string;
    version: string;
    source: string;
    sha256: string;
    versions?: Array<{ version: string; source: string; sha256: string }>;
  }>;
}

/**
 * Build a self-contained workspace that scripts/manifest.ts can run against.
 * It needs `registry/skills/<slug>/tool.yaml` plus a built `dist/skills/<slug>.mjs`.
 * We don't run scripts/build.ts — we write the bundle directly so each test
 * controls the exact bytes.
 */
function makeWorkspace(): string {
  const work = mkdtempSync(join(tmpdir(), 'manifest-versioning-'));
  // We need scripts/, schema/, types/, client/ (manifest.ts imports from
  // ../client/semver-pin.ts and ../types/index.ts), package.json, and
  // tsconfig — but NOT the real registry (we install our own fixtures) and
  // NOT dist/ or node_modules/.
  cpSync(ROOT, work, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length).replace(/\\/g, '/');
      if (rel === '/node_modules' || rel.startsWith('/node_modules/')) return false;
      if (rel === '/dist' || rel.startsWith('/dist/')) return false;
      if (rel === '/.git' || rel.startsWith('/.git/')) return false;
      // Exclude the real registry/skills/ — each test populates its own
      // fixtures via writeSkill(). Without this, manifest.ts would iterate
      // over every shipped skill and fail on missing dist/skills/<slug>.mjs.
      if (rel === '/registry/skills' || rel.startsWith('/registry/skills/')) return false;
      return true;
    },
  });
  // Recreate the empty skills directory; tests fill it via writeSkill().
  mkdirSync(join(work, 'registry', 'skills'), { recursive: true });

  // Symlink node_modules from the host repo so the workspace's
  // scripts/manifest.ts can resolve `yaml` and friends. ESM resolution
  // ignores NODE_PATH (it's CommonJS-only), so this is the cross-platform
  // workaround that doesn't require copying ~200 MB of dependencies.
  // 'junction' on Windows behaves like a directory symlink without needing
  // admin rights; ignored on POSIX where the second arg is unused.
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');
  } catch {
    // POSIX: junction → 'dir'. Retry without the platform hint.
    symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
  }
  return work;
}

function writeSkill(work: string, slug: string, version: string, handlerBody: string): void {
  const dir = join(work, 'registry', 'skills', slug);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'tool.yaml'),
    `slug: ${slug}\n` +
    `name: Test\n` +
    `summary: A test skill for versioning\n` +
    `version: ${version}\n` +
    `inputSchema:\n` +
    `  type: object\n` +
    `  properties: {}\n` +
    `outputSchema:\n` +
    `  type: object\n` +
    `  properties:\n` +
    `    ok: { type: boolean }\n`,
  );
  // Generated types stub (the real codegen runs as a separate step; the
  // manifest builder doesn't touch this file).
  writeFileSync(join(dir, 'src', 'types.gen.ts'),
    `export interface Input {}\nexport interface Output { ok?: boolean; }\n`,
  );
  writeFileSync(join(dir, 'src', 'index.ts'), handlerBody);
}

function writeBundle(work: string, slug: string, body: string): void {
  const dir = join(work, 'dist', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.mjs`), body);
}

function runManifest(work: string): { stdout: string; stderr: string; status: number } {
  // Use the real node + manifest script. cwd = workspace root so path
  // resolution inside scripts/manifest.ts finds registry/ and dist/.
  // node_modules was symlinked into the workspace by makeWorkspace(),
  // so `import 'yaml'` etc. resolves normally via ESM rules.
  try {
    const stdout = execFileSync('node', ['scripts/manifest.ts'], {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

function readManifest(work: string): Manifest {
  return JSON.parse(readFileSync(join(work, 'dist', 'manifest.json'), 'utf8')) as Manifest;
}

// ---------------------------------------------------------------------------

test('manifest-versioning: first-time build creates <slug>@<v>.mjs and populates versions[]', () => {
  const work = makeWorkspace();
  try {
    writeSkill(work, 'demo', '1.0.0', 'export default async () => ({ ok: true });');
    writeBundle(work, 'demo', `export default async () => ({ ok: true, v: '1.0.0' });`);

    const r = runManifest(work);
    assert.equal(r.status, 0, `expected success, got: ${r.stderr}`);
    assert.ok(existsSync(join(work, 'dist', 'skills', 'demo@1.0.0.mjs')), 'archive file must be created');

    const m = readManifest(work);
    const tool = m.tools.find((t) => t.slug === 'demo');
    assert.ok(tool);
    assert.equal(tool.version, '1.0.0');
    assert.deepEqual(tool.versions?.map((v) => v.version), ['1.0.0']);
    assert.equal(tool.versions?.[0]?.source, 'skills/demo@1.0.0.mjs');
    assert.equal(tool.versions?.[0]?.sha256, tool.sha256, 'archive sha matches latest sha for v1.0.0');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('manifest-versioning: re-building the same version with identical bundle is idempotent', () => {
  const work = makeWorkspace();
  try {
    writeSkill(work, 'demo', '1.0.0', 'export default async () => ({ ok: true });');
    const bundleSrc = `export default async () => ({ ok: true });`;
    writeBundle(work, 'demo', bundleSrc);

    // First build
    const r1 = runManifest(work);
    assert.equal(r1.status, 0);
    const m1 = readManifest(work);

    // Second build, identical input
    const r2 = runManifest(work);
    assert.equal(r2.status, 0, `expected idempotent re-run, got: ${r2.stderr}`);
    const m2 = readManifest(work);

    // Same versions[], same sha — only `generatedAt` should differ.
    assert.deepEqual(
      m1.tools.find((t) => t.slug === 'demo')!.versions,
      m2.tools.find((t) => t.slug === 'demo')!.versions,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('manifest-versioning: bundle-changed-without-version-bump is a HARD ERROR', () => {
  // The headline guarantee: if a skill author edits the handler but forgets
  // to bump tool.yaml.version, consumers pinning the old version would get
  // different bytes than they verified. The build refuses.
  const work = makeWorkspace();
  try {
    writeSkill(work, 'demo', '1.0.0', 'export default async () => ({ ok: true });');
    writeBundle(work, 'demo', `export default async () => ({ ok: true, v: 1 });`);
    const r1 = runManifest(work);
    assert.equal(r1.status, 0, 'first build seeds the archive');

    // Now change the bundle WITHOUT changing the version. Re-run.
    writeBundle(work, 'demo', `export default async () => ({ ok: false, v: 2 });`);
    const r2 = runManifest(work);
    assert.equal(r2.status, 1, 'manifest build must fail on bundle-changed-without-bump');
    assert.match(r2.stderr, /differs from the archived copy/);
    assert.match(r2.stderr, /version was not bumped/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('manifest-versioning: bumping version + changing bundle creates a NEW archive entry', () => {
  const work = makeWorkspace();
  try {
    // First build at 1.0.0.
    writeSkill(work, 'demo', '1.0.0', 'export default async () => ({ ok: true });');
    const v1 = `export default async () => ({ ok: true, v: '1.0.0' });`;
    writeBundle(work, 'demo', v1);
    const r1 = runManifest(work);
    assert.equal(r1.status, 0, r1.stderr);

    // Bump to 1.1.0 with a new bundle.
    writeSkill(work, 'demo', '1.1.0', 'export default async () => ({ ok: true });');
    const v2 = `export default async () => ({ ok: true, v: '1.1.0' });`;
    writeBundle(work, 'demo', v2);
    const r2 = runManifest(work);
    assert.equal(r2.status, 0, r2.stderr);

    // Both archive files exist.
    assert.ok(existsSync(join(work, 'dist', 'skills', 'demo@1.0.0.mjs')), '1.0.0 archive preserved');
    assert.ok(existsSync(join(work, 'dist', 'skills', 'demo@1.1.0.mjs')), '1.1.0 archive added');

    // versions[] has both, highest first.
    const m = readManifest(work);
    const tool = m.tools.find((t) => t.slug === 'demo');
    assert.deepEqual(tool?.versions?.map((v) => v.version), ['1.1.0', '1.0.0']);

    // Top-level source/sha still point at the latest (1.1.0).
    assert.equal(tool?.version, '1.1.0');
    assert.equal(tool?.source, 'skills/demo.mjs');
    assert.equal(tool?.sha256, tool?.versions?.[0]?.sha256);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
