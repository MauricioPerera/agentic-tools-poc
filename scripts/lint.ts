#!/usr/bin/env node
/**
 * lint.ts — runs the semantic skill linter over every registry/skills/<slug>.
 *
 * Exit codes:
 *   0 → no errors (warnings + info ok)
 *   1 → at least one error finding
 *   2 → bad invocation / unreadable file
 *
 * Flags:
 *   --all   → also print info-severity findings (default: errors + warnings)
 *   --json  → machine-readable output
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { lintSkill, summarize } from '../client/skill-linter.ts';
import type { LintResult, LintSeverity } from '../client/skill-linter.ts';
import type { SkillDef } from '../types/index.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');

const args = process.argv.slice(2);
const showInfo = args.includes('--all');
const json = args.includes('--json');

const slugs = readdirSync(SKILLS_DIR);
interface PerSkill {
  slug: string;
  results: LintResult[];
}

const allReports: PerSkill[] = [];
let hadErrors = false;

for (const slug of slugs) {
  const yamlPath = join(SKILLS_DIR, slug, 'tool.yaml');
  if (!existsSync(yamlPath)) continue;
  const skill = parseYaml(readFileSync(yamlPath, 'utf8')) as SkillDef;

  // Concatenate every .ts source file under registry/skills/<slug>/src
  // (excluding generated *.gen.ts) so forbidden-imports can scan them.
  const srcDir = join(SKILLS_DIR, slug, 'src');
  let handlerSource = '';
  if (existsSync(srcDir)) {
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts') || f.endsWith('.gen.ts')) continue;
      handlerSource += readFileSync(join(srcDir, f), 'utf8') + '\n';
    }
  }

  const results = lintSkill(skill, { handlerSource });
  allReports.push({ slug, results });
  if (results.some((r) => r.severity === 'error')) hadErrors = true;
}

if (json) {
  process.stdout.write(JSON.stringify(allReports, null, 2) + '\n');
  process.exit(hadErrors ? 1 : 0);
}

// Pretty output
const ICONS: Record<LintSeverity, string> = { error: '✗', warning: '⚠', info: 'ℹ' };

let printedAny = false;
for (const { slug, results } of allReports) {
  const visible = results.filter((r) => showInfo || r.severity !== 'info');
  if (!visible.length) {
    console.log(`✓ ${slug}`);
    continue;
  }
  printedAny = true;
  console.log(`\n${slug}:`);
  for (const r of visible) {
    console.log(`  ${ICONS[r.severity]} ${r.rule}  ${r.field}`);
    console.log(`    ${r.message}`);
    if (r.suggestion) {
      const lines = r.suggestion.split(/\s*\n\s*/).filter(Boolean);
      for (const line of lines) console.log(`    → ${line}`);
    }
  }
}

// Totals
const all = allReports.flatMap((r) => r.results);
const counts = summarize(all);
console.log(
  `\n${slugs.length} skill(s) linted — ` +
    `${counts.error} error${counts.error === 1 ? '' : 's'}, ` +
    `${counts.warning} warning${counts.warning === 1 ? '' : 's'}, ` +
    `${counts.info} info${counts.info === 1 ? '' : 's'}` +
    (showInfo ? '' : ` (re-run with --all to see info findings)`),
);

if (hadErrors) {
  console.error(`\n✗ Lint failed: ${counts.error} error finding(s).`);
  process.exit(1);
}

if (!printedAny) {
  console.log(`\nAll skills clean${showInfo ? '' : ' (modulo info-level suggestions)'}.`);
}
