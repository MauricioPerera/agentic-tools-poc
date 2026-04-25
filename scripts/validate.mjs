#!/usr/bin/env node
/**
 * validate.mjs — lints every registry/skills/<slug>/tool.yaml against SKILL_SCHEMA.
 * Exits non-zero on any error so CI blocks bad PRs.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SKILL_SCHEMA, validate } from '../schema/skill.schema.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');

let errors = 0;
const slugs = readdirSync(SKILLS_DIR);

for (const slug of slugs) {
  const dir = join(SKILLS_DIR, slug);
  const yamlPath = join(dir, 'tool.yaml');
  const srcPath  = join(dir, 'src', 'index.mjs');

  if (!existsSync(yamlPath)) { console.error(`✗ ${slug}: missing tool.yaml`); errors++; continue; }
  if (!existsSync(srcPath))  { console.error(`✗ ${slug}: missing src/index.mjs`); errors++; continue; }

  const meta = parseYaml(readFileSync(yamlPath, 'utf8'));

  if (meta.slug !== slug) {
    console.error(`✗ ${slug}: tool.yaml.slug "${meta.slug}" doesn't match dir name`);
    errors++;
  }

  const errs = validate(SKILL_SCHEMA, meta);
  if (errs.length) {
    console.error(`✗ ${slug}:`);
    for (const e of errs) console.error(`    ${e}`);
    errors += errs.length;
  } else {
    console.log(`✓ ${slug} v${meta.version}`);
  }
}

if (errors) {
  console.error(`\n${errors} error(s). Aborting.`);
  process.exit(1);
}
console.log(`\n${slugs.length} skill(s) valid.`);
