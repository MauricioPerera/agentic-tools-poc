#!/usr/bin/env node
/**
 * codegen-types.ts — emits `Input` / `Output` TypeScript types for every
 * skill, derived directly from its `tool.yaml` (`inputSchema` / `outputSchema`).
 *
 * Closes the last drift loop in the contract: previously a skill's handler
 * defined its own `interface Input`, which could silently diverge from the
 * inputSchema declared in tool.yaml. Now `tool.yaml` is the single source
 * of truth and the handler imports the generated types.
 *
 * Output: `registry/skills/<slug>/src/types.gen.ts`. The handler imports
 * `Input` and `Output` from there.
 *
 * Modes:
 *   `npm run codegen`        write generated files (default)
 *   `npm run codegen -- --check`   compare against committed files; exit 1
 *                                   if anything changed (CI drift detection)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { schemaToTypeScript } from '../client/jsonschema-to-ts.ts';
import type { JSONSchema, SkillDef } from '../types/index.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, 'registry', 'skills');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

const HEADER =
  `// ╔════════════════════════════════════════════════════════════════════╗\n` +
  `// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║\n` +
  `// ║ Run \`npm run codegen\` after changing inputSchema or outputSchema.  ║\n` +
  `// ║ CI runs \`npm run codegen:check\` to fail builds on drift.           ║\n` +
  `// ╚════════════════════════════════════════════════════════════════════╝\n`;

function emitFile(skill: SkillDef): string {
  const input = renderInterface('Input', skill.inputSchema, 'Skill input — ' + (skill.summary ?? ''));
  const output = renderInterface('Output', skill.outputSchema, 'Skill output');
  return `${HEADER}\n${input}\n\n${output}\n`;
}

function renderInterface(name: string, schema: JSONSchema | undefined, doc: string): string {
  if (!schema) {
    return [`/** ${doc} (no schema declared) */`, `export type ${name} = unknown;`].join('\n');
  }
  const ts = schemaToTypeScript(schema);
  // For object schemas, prefer `interface` so editor tooling shows them as
  // expandable types. For non-object roots (rare), use a type alias.
  if (schema.type === 'object') {
    return [`/** ${doc} */`, `export interface ${name} ${ts}`].join('\n');
  }
  return [`/** ${doc} */`, `export type ${name} = ${ts};`].join('\n');
}

const slugs = readdirSync(SKILLS_DIR);
let drifted = 0;
let written = 0;

for (const slug of slugs) {
  const yamlPath = join(SKILLS_DIR, slug, 'tool.yaml');
  if (!existsSync(yamlPath)) continue;

  const skill = parseYaml(readFileSync(yamlPath, 'utf8')) as SkillDef;
  const generated = emitFile(skill);
  const targetPath = join(SKILLS_DIR, slug, 'src', 'types.gen.ts');

  if (checkOnly) {
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
    // Normalize line endings before comparison: codegen always emits LF,
    // but git's autocrlf or a Windows editor might have rewritten the file
    // with CRLF. We only care about semantic drift, not whitespace bytes.
    const normExisting  = existing.replace(/\r\n/g, '\n');
    const normGenerated = generated.replace(/\r\n/g, '\n');
    if (normExisting !== normGenerated) {
      drifted++;
      console.error(`✗ ${slug}: types.gen.ts is out of date with tool.yaml`);
    } else {
      console.log(`✓ ${slug}`);
    }
    continue;
  }

  writeFileSync(targetPath, generated);
  written++;
  console.log(`✓ ${slug} → src/types.gen.ts`);
}

if (checkOnly) {
  if (drifted > 0) {
    console.error(`\n${drifted} skill(s) have stale generated types. Run \`npm run codegen\`.`);
    process.exit(1);
  }
  console.log(`\nAll generated types are up-to-date.`);
} else {
  console.log(`\nGenerated ${written} types.gen.ts file(s).`);
}
