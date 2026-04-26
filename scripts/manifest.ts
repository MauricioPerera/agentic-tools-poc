#!/usr/bin/env node
/**
 * manifest.ts — emits dist/manifest.json: the single artefact a client needs
 * to discover every available tool. Each entry references the bundled .mjs by
 * relative path so the same manifest works under jsDelivr, Pages, R2, etc.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'node:child_process';
import type { Manifest, SkillDef } from '../types/index.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');
const DIST       = join(ROOT, 'dist');

const sha = ((): string | null => {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
})();

const tools: SkillDef[] = [];
for (const slug of readdirSync(SKILLS_DIR)) {
  const meta = parseYaml(readFileSync(join(SKILLS_DIR, slug, 'tool.yaml'), 'utf8')) as Partial<SkillDef>;
  const bundle = `skills/${slug}.mjs`;
  const bundlePath = join(DIST, bundle);
  if (!existsSync(bundlePath)) {
    console.error(`! ${slug}: missing ${bundle} — run \`npm run build\` first`);
    process.exit(1);
  }
  // Compute sha256 of the bundle so the loader can verify integrity before
  // importing. Catches tampering with dist branch, hostile commits that
  // jsDelivr cached, or accidental corruption mid-flight.
  const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  tools.push({
    slug:            meta.slug!,
    name:            meta.name!,
    summary:         meta.summary!,
    version:         meta.version!,
    capabilities:    meta.capabilities ?? [],
    sideEffects:     meta.sideEffects ?? 'none',
    inputSchema:     meta.inputSchema!,
    outputSchema:    meta.outputSchema,
    requiredEnv:     meta.requiredEnv ?? [],
    networkPolicy:   meta.networkPolicy ?? { allow: [] },
    model_overrides: meta.model_overrides ?? {},
    ...(meta.outputCap != null ? { outputCap: meta.outputCap } : {}),
    source:          bundle,
    sha256,
  });
}

const manifest: Manifest = {
  registryVersion: '1.0',
  generatedAt:     new Date().toISOString(),
  commit:          sha,
  tools,
};

writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`✓ manifest.json — ${tools.length} tool(s)${sha ? ` @ ${sha.slice(0, 7)}` : ''}`);
