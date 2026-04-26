#!/usr/bin/env node
/**
 * build.ts — bundles each registry/skills/<slug>/src/index.{ts,mjs} to
 * dist/skills/<slug>.mjs as a single ESM file (tree-shaken, minified).
 *
 * Output is a default-exporting ESM module that any ESM host can `import()`.
 */
import { readdirSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');
const DIST_DIR   = join(ROOT, 'dist', 'skills');

if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
mkdirSync(DIST_DIR, { recursive: true });

const slugs = readdirSync(SKILLS_DIR);
const results: Array<{ slug: string; size: number }> = [];

for (const slug of slugs) {
  // Prefer .ts when available; fall back to .mjs for legacy skills.
  const tsEntry  = join(SKILLS_DIR, slug, 'src', 'index.ts');
  const mjsEntry = join(SKILLS_DIR, slug, 'src', 'index.mjs');
  const entry = existsSync(tsEntry) ? tsEntry : mjsEntry;
  const out   = join(DIST_DIR, `${slug}.mjs`);

  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',     // no Node/browser globals assumed
    target: 'es2022',
    minify: true,
    sourcemap: false,
    treeShaking: true,
    legalComments: 'none',
  });

  const size = statSync(out).size;
  results.push({ slug, size });
  console.log(`✓ ${slug.padEnd(20)} ${(size / 1024).toFixed(2)} KB`);
}

console.log(`\nBuilt ${results.length} skill(s) → dist/skills/`);
