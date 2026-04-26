#!/usr/bin/env node
/**
 * validate.ts — lints every registry/skills/<slug>/tool.yaml against SKILL_SCHEMA.
 * Exits non-zero on any error so CI blocks bad PRs.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SKILL_SCHEMA, validate } from '../schema/skill.schema.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');

let errors = 0;
const slugs = readdirSync(SKILLS_DIR);

for (const slug of slugs) {
  const dir = join(SKILLS_DIR, slug);
  const yamlPath = join(dir, 'tool.yaml');
  // Accept either index.mjs (legacy) or index.ts (post-migration) as the handler.
  const srcMjs = join(dir, 'src', 'index.mjs');
  const srcTs  = join(dir, 'src', 'index.ts');

  if (!existsSync(yamlPath)) {
    console.error(`✗ ${slug}: missing tool.yaml`);
    errors++;
    continue;
  }
  if (!existsSync(srcMjs) && !existsSync(srcTs)) {
    console.error(`✗ ${slug}: missing src/index.mjs or src/index.ts`);
    errors++;
    continue;
  }

  const meta = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;

  if (meta.slug !== slug) {
    console.error(`✗ ${slug}: tool.yaml.slug "${meta.slug as string}" doesn't match dir name`);
    errors++;
  }

  const errs = validate(SKILL_SCHEMA, meta);
  if (errs.length) {
    console.error(`✗ ${slug}:`);
    for (const e of errs) console.error(`    ${e}`);
    errors += errs.length;
  } else {
    console.log(`✓ ${slug} v${meta.version as string}`);
  }
}

if (errors) {
  console.error(`\n${errors} error(s). Aborting.`);
  process.exit(1);
}
console.log(`\n${slugs.length} skill(s) valid.`);
