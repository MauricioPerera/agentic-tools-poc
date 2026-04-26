#!/usr/bin/env node
/**
 * manifest.ts — emits dist/manifest.json: the single artefact a client needs
 * to discover every available tool. Each entry references the bundled .mjs
 * by relative path so the same manifest works under jsDelivr, Pages, R2, etc.
 *
 * Per-skill versioning (closes #2):
 *
 *   - For each skill, the freshly-built `dist/skills/<slug>.mjs` (latest)
 *     gets a sibling copy `dist/skills/<slug>@<version>.mjs` keyed by the
 *     `version` field in tool.yaml.
 *   - If `<slug>@<version>.mjs` ALREADY exists (preserved across builds via
 *     the dist branch / CI workflow) and its sha256 differs from the new
 *     bundle's, we abort with a clear error: the author bumped the bundle
 *     contents without bumping the version. This is the bump-without-bump
 *     guard the issue calls for.
 *   - If the versioned file exists with matching sha, we leave it alone
 *     (idempotent — re-running the build is a no-op).
 *   - The manifest's `tools[].versions[]` lists every `<slug>@<v>.mjs` in
 *     `dist/skills/`, semver-sorted highest-first. The loader uses this
 *     for `pin` resolution (see client/loader.ts).
 *
 * The top-level `tools[].source` + `sha256` always point at the latest
 * version (current behaviour) so existing consumers see no change.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'node:child_process';
import { compareVersions, parseVersion } from '../client/semver-pin.ts';
import type { Manifest, SkillDef, SkillVersionEntry } from '../types/index.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');
const DIST       = join(ROOT, 'dist');
const DIST_SKILLS = join(DIST, 'skills');

const commitSha = ((): string | null => {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
})();

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Find every `<slug>@<version>.mjs` under dist/skills/ for a given slug. */
function listVersionedFiles(slug: string): Array<{ version: string; file: string }> {
  if (!existsSync(DIST_SKILLS)) return [];
  const prefix = `${slug}@`;
  const out: Array<{ version: string; file: string }> = [];
  for (const f of readdirSync(DIST_SKILLS)) {
    if (!f.startsWith(prefix) || !f.endsWith('.mjs')) continue;
    const version = f.slice(prefix.length, -'.mjs'.length);
    // Validate the embedded version parses; skip silently if not (avoids
    // accidentally pulling in a malformed file someone dropped manually).
    try { parseVersion(version); } catch { continue; }
    out.push({ version, file: f });
  }
  return out;
}

const tools: SkillDef[] = [];
let hadBumpWithoutBump = false;

for (const slug of readdirSync(SKILLS_DIR)) {
  const meta = parseYaml(readFileSync(join(SKILLS_DIR, slug, 'tool.yaml'), 'utf8')) as Partial<SkillDef>;
  const version = meta.version!;
  const bundle = `skills/${slug}.mjs`;
  const bundlePath = join(DIST, bundle);
  if (!existsSync(bundlePath)) {
    console.error(`! ${slug}: missing ${bundle} — run \`npm run build\` first`);
    process.exit(1);
  }

  const latestSha = sha256OfFile(bundlePath);

  // ─── Per-version file management ────────────────────────────────────────
  // Path the versioned file should live at if/when it's preserved.
  const versionedFile = `${slug}@${version}.mjs`;
  const versionedPath = join(DIST_SKILLS, versionedFile);

  if (existsSync(versionedPath)) {
    // A previous build already wrote a versioned bundle for this exact
    // <slug>@<version>. Verify the new build's contents match — if they
    // don't, the skill changed without bumping the version in tool.yaml,
    // which is the exact failure mode this guard exists for.
    const archivedSha = sha256OfFile(versionedPath);
    if (archivedSha !== latestSha) {
      console.error(
        `\n✗ ${slug}: bundle for v${version} differs from the archived copy.\n` +
        `    archived sha256: ${archivedSha.slice(0, 16)}…\n` +
        `    new      sha256: ${latestSha.slice(0, 16)}…\n` +
        `    The bundle changed but tool.yaml.version was not bumped.\n` +
        `    Bump the version (semver: patch for fixes, minor for additions, major\n` +
        `    for breaking changes) so consumers pinning v${version} keep getting\n` +
        `    the bytes they're expecting.\n`,
      );
      hadBumpWithoutBump = true;
      continue;
    }
    // Sha matches — nothing to do, this version is already preserved.
  } else {
    // First time we see this version — copy the latest bundle to the
    // versioned path so the next build has the archive to compare against.
    copyFileSync(bundlePath, versionedPath);
  }

  // ─── Build the versions[] array ─────────────────────────────────────────
  // Lists everything currently on disk under dist/skills/<slug>@*.mjs,
  // semver-sorted highest-first. The current version is always present
  // because we either just copied it or verified it.
  const versionsRaw = listVersionedFiles(slug);
  versionsRaw.sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
  const versions: SkillVersionEntry[] = versionsRaw.map(({ version: v, file }) => ({
    version: v,
    source: `skills/${file}`,
    sha256: sha256OfFile(join(DIST_SKILLS, file)),
  }));

  tools.push({
    slug:            meta.slug!,
    name:            meta.name!,
    summary:         meta.summary!,
    version,
    capabilities:    meta.capabilities ?? [],
    sideEffects:     meta.sideEffects ?? 'none',
    inputSchema:     meta.inputSchema!,
    outputSchema:    meta.outputSchema,
    requiredEnv:     meta.requiredEnv ?? [],
    networkPolicy:   meta.networkPolicy ?? { allow: [] },
    model_overrides: meta.model_overrides ?? {},
    ...(meta.outputCap != null ? { outputCap: meta.outputCap } : {}),
    source:          bundle,
    sha256:          latestSha,
    ...(versions.length > 0 ? { versions } : {}),
  });
}

if (hadBumpWithoutBump) {
  console.error(`\nAborting manifest build — fix the version bumps above and re-run.\n`);
  process.exit(1);
}

const manifest: Manifest = {
  registryVersion: '1.0',
  generatedAt:     new Date().toISOString(),
  commit:          commitSha,
  tools,
};

writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
const versionsCount = tools.reduce((n, t) => n + (t.versions?.length ?? 0), 0);
console.log(
  `✓ manifest.json — ${tools.length} tool(s), ${versionsCount} archived version(s)` +
  (commitSha ? ` @ ${commitSha.slice(0, 7)}` : ''),
);
