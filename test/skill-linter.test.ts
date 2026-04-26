/**
 * skill-linter.test.ts — one test per rule (positive + negative path).
 *
 * Each test constructs a minimal SkillDef that triggers (or doesn't trigger)
 * the rule under test, so a future change that silently disables a rule is
 * caught here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  optionalStringNoDescription,
  optionalNoDefault,
  requiredNoDescription,
  outputSchemaMissing,
  destructiveNoWarning,
  summaryTooLong,
  optionalsWithoutTuning,
  networkSkillNoPolicy,
  forbiddenImports,
  lintSkill,
  summarize,
  ALL_RULES,
} from '../client/skill-linter.ts';
import type { SkillDef } from '../types/index.ts';

/** Build a minimal valid skill, then override fields per test. */
function skill(over: Partial<SkillDef> = {}): SkillDef {
  return {
    slug: 'test',
    name: 'Test',
    summary: 'A short summary.',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    source: 'skills/test.mjs',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// R1 — optional-string-no-description

test('R1: fires when optional string field has no description', () => {
  const r = optionalStringNoDescription(skill({
    inputSchema: { type: 'object', properties: { ip: { type: 'string' } } },
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.rule, 'optional-string-no-description');
  assert.match(r[0]!.field, /\.ip$/);
});

test('R1: silent when optional string has a description', () => {
  const r = optionalStringNoDescription(skill({
    inputSchema: { type: 'object', properties: { ip: { type: 'string', description: 'use this' } } },
  }));
  assert.equal(r.length, 0);
});

test('R1: silent when string field is required (R3 covers that)', () => {
  const r = optionalStringNoDescription(skill({
    inputSchema: { type: 'object', required: ['ip'], properties: { ip: { type: 'string' } } },
  }));
  assert.equal(r.length, 0);
});

test('R1: silent for non-string optional fields', () => {
  const r = optionalStringNoDescription(skill({
    inputSchema: { type: 'object', properties: { upper: { type: 'boolean' } } },
  }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R2 — optional-no-default

test('R2: fires when optional field has no default', () => {
  const r = optionalNoDefault(skill({
    inputSchema: { type: 'object', properties: { upper: { type: 'boolean' } } },
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.rule, 'optional-no-default');
});

test('R2: silent when optional field has explicit default', () => {
  const r = optionalNoDefault(skill({
    inputSchema: { type: 'object', properties: { upper: { type: 'boolean', default: false } } },
  }));
  assert.equal(r.length, 0);
});

test('R2: silent for required fields', () => {
  const r = optionalNoDefault(skill({
    inputSchema: { type: 'object', required: ['ip'], properties: { ip: { type: 'string' } } },
  }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R3 — required-no-description

test('R3: ERROR when required field has no description', () => {
  const r = requiredNoDescription(skill({
    inputSchema: { type: 'object', required: ['ip'], properties: { ip: { type: 'string' } } },
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'error');
});

test('R3: silent when required field has description', () => {
  const r = requiredNoDescription(skill({
    inputSchema: {
      type: 'object', required: ['ip'],
      properties: { ip: { type: 'string', description: 'IP to look up' } },
    },
  }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R4 — output-schema-missing

test('R4: ERROR when outputSchema is missing', () => {
  const s = skill();
  delete (s as Partial<SkillDef>).outputSchema;
  const r = outputSchemaMissing(s);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'error');
});

test('R4: ERROR when outputSchema is empty object', () => {
  const r = outputSchemaMissing(skill({ outputSchema: {} }));
  assert.equal(r.length, 1);
});

test('R4: silent when outputSchema has properties', () => {
  const r = outputSchemaMissing(skill({
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  }));
  assert.equal(r.length, 0);
});

test('R4: ERROR when outputSchema declares type but has no properties', () => {
  // Regression test for the bug found in code review #2:
  // `Object.keys({ type: 'object' })` was 1 → rule passed silently.
  // Now we check `properties` specifically.
  const r = outputSchemaMissing(skill({ outputSchema: { type: 'object' } }));
  assert.equal(r.length, 1, 'expected error for outputSchema with no properties');
  assert.equal(r[0]!.severity, 'error');
});

test('R4: ERROR when outputSchema.properties is an empty object', () => {
  const r = outputSchemaMissing(skill({
    outputSchema: { type: 'object', properties: {} },
  }));
  assert.equal(r.length, 1);
});

// ---------------------------------------------------------------------------
// R5 — destructive-no-warning

test('R5: WARN when destructive but description is bland', () => {
  const r = destructiveNoWarning(skill({
    sideEffects: 'destructive',
    summary: 'Removes a record by id.',
    description: 'Pass the id and it goes away.',
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'warning');
});

test('R5: silent when destructive AND description warns', () => {
  const r = destructiveNoWarning(skill({
    sideEffects: 'destructive',
    summary: 'WARNING: deletes a record permanently. Cannot be undone.',
  }));
  assert.equal(r.length, 0);
});

test('R5: silent for non-destructive skills', () => {
  const r = destructiveNoWarning(skill({ sideEffects: 'read', summary: 'Reads data.' }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R6 — summary-too-long

test('R6: WARN when summary exceeds 120 chars', () => {
  const r = summaryTooLong(skill({ summary: 'x'.repeat(150) }));
  assert.equal(r.length, 1);
});

test('R6: silent when summary is concise', () => {
  const r = summaryTooLong(skill({ summary: 'Echo text with case transform.' }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R7 — optionals-without-tuning

test('R7: INFO when 2+ optional fields and no model_overrides', () => {
  const r = optionalsWithoutTuning(skill({
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'a' },
        b: { type: 'boolean', default: false },
      },
    },
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'info');
});

test('R7: silent when model_overrides exists', () => {
  const r = optionalsWithoutTuning(skill({
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    },
    model_overrides: { hermes: { summary: 'tuned' } },
  }));
  assert.equal(r.length, 0);
});

test('R7: silent when only one optional field', () => {
  const r = optionalsWithoutTuning(skill({
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R8 — network-skill-no-policy

test('R8: WARN when capabilities mention network but allow is empty', () => {
  const r = networkSkillNoPolicy(skill({
    capabilities: ['network', 'fetch'],
    networkPolicy: { allow: [] },
  }));
  assert.equal(r.length, 1);
});

test('R8: silent when networkPolicy.allow is populated', () => {
  const r = networkSkillNoPolicy(skill({
    capabilities: ['network'],
    networkPolicy: { allow: ['api.example.com'] },
  }));
  assert.equal(r.length, 0);
});

test('R8: silent when skill is not network-capable', () => {
  const r = networkSkillNoPolicy(skill({ capabilities: ['transform'] }));
  assert.equal(r.length, 0);
});

// ---------------------------------------------------------------------------
// R9 — forbidden-imports

test('R9: silent when no handler source provided (legacy callers)', () => {
  const r = forbiddenImports(skill());
  assert.deepEqual(r, []);
});

test('R9: silent for clean handler (only fetch + types)', () => {
  const src = `
    import type { SkillHandler } from '../../../../types/index.ts';
    const handler: SkillHandler = async (input, ctx) => {
      const r = await ctx.fetch('https://example.com');
      return await r.json();
    };
    export default handler;
  `;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.deepEqual(r, []);
});

test('R9: ERROR on static import of node:fs', () => {
  const src = `import { readFileSync } from 'node:fs';\nexport default async () => {};`;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.severity, 'error');
  assert.equal(r[0]!.rule, 'forbidden-imports');
  assert.match(r[0]!.message, /node:fs/);
});

test('R9: ERROR on dynamic import of node:child_process', () => {
  const src = `export default async () => { const cp = await import('node:child_process'); cp.execSync('whoami'); };`;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.equal(r.length, 1);
  assert.match(r[0]!.message, /node:child_process/);
});

test('R9: ERROR on require() of node:net', () => {
  const src = `const net = require("node:net");\nexport default async () => {};`;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.equal(r.length, 1);
  assert.match(r[0]!.message, /node:net/);
});

test('R9: ERROR on direct process.env access', () => {
  const src = `export default async () => { return { secret: process.env.SECRET }; };`;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.equal(r.length, 1);
  assert.match(r[0]!.message, /process\.env/);
});

test('R9: ERROR aggregates: multiple distinct forbidden imports', () => {
  const src = `
    import 'node:fs';
    import { spawn } from 'node:child_process';
    export default async () => { return process.env; };
  `;
  const r = forbiddenImports(skill(), { handlerSource: src });
  // 2 imports + 1 process.env = 3 findings
  assert.equal(r.length, 3);
  const messages = r.map((x) => x.message).join(' ');
  assert.match(messages, /node:fs/);
  assert.match(messages, /node:child_process/);
  assert.match(messages, /process\.env/);
});

test('R9: dedupes the same forbidden import seen multiple times', () => {
  const src = `
    import { readFileSync } from 'node:fs';
    import { writeFileSync } from 'node:fs';
    export default async () => { import('node:fs'); };
  `;
  const r = forbiddenImports(skill(), { handlerSource: src });
  // Three references to node:fs but only one finding for the module.
  assert.equal(r.length, 1);
  assert.match(r[0]!.message, /node:fs/);
});

test('R9: silent when string "node:fs" appears inside a comment but not imported', () => {
  // Heuristic limitation: the regex requires `import|from|require` context, so
  // a literal string mention in a comment shouldn't trip it. Documents the
  // false-negative boundary so a future stricter rule is a deliberate choice.
  const src = `
    // we deliberately avoid 'node:fs' here
    const note = 'do not import node:fs';
    export default async () => {};
  `;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.deepEqual(r, []);
});

test('R9: KNOWN false-positive: comment that quotes "import \'node:fs\'" trips the rule', () => {
  // The regex is text-based, not AST-based, so a comment that LITERALLY
  // contains the import syntax matches as if it were code. Documenting the
  // false-positive explicitly so a future contributor knows it's known and
  // understands the trade-off (regex catches more real bypass attempts;
  // AST would be precise but adds a parser dependency).
  //
  // Mitigation today: a reviewer who sees R9 fire on a comment-only line
  // can confirm and waive. The runtime sandbox (V2) is the actual
  // guarantee — R9 is PR-time defence-in-depth, so a false-positive is
  // higher-friction-but-safer than a false-negative.
  const src = `
    // Bad example to avoid: import 'node:fs' would bypass the sandbox
    export default async () => { return { ok: true }; };
  `;
  const r = forbiddenImports(skill(), { handlerSource: src });
  assert.equal(r.length, 1, 'documents the known false-positive on import-syntax in comments');
  assert.match(r[0]!.message, /node:fs/);
  // If a future change moves to AST-based scanning and this test breaks,
  // delete it (the precision is a strict improvement).
});

// ---------------------------------------------------------------------------
// Aggregator

test('lintSkill: runs all rules and returns combined results', () => {
  // A skill that fires multiple rules at once
  const s = skill({
    summary: 'a'.repeat(200), // R6
    inputSchema: {
      type: 'object',
      required: ['ip'],
      properties: {
        ip: { type: 'string' },              // R3 (required, no description)
        verbose: { type: 'boolean' },        // R2 (optional, no default)
        also: { type: 'string' },            // R1 + R2
      },
    },
  });
  const results = lintSkill(s);
  // Should fire R1, R2 (twice), R3, R6, R7
  assert.ok(results.length >= 4, `expected several findings, got ${results.length}`);
  const byRule = new Set(results.map((r) => r.rule));
  assert.ok(byRule.has('required-no-description'));
  assert.ok(byRule.has('optional-no-default'));
  assert.ok(byRule.has('optional-string-no-description'));
  assert.ok(byRule.has('summary-too-long'));
});

test('lintSkill: clean skill returns empty array', () => {
  const clean = skill({
    summary: 'Concise summary.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string', description: 'what to act on' } },
    },
  });
  assert.deepEqual(lintSkill(clean), []);
});

test('summarize: counts findings by severity', () => {
  const s = skill({
    sideEffects: 'destructive',
    summary: 'a'.repeat(200),
    inputSchema: {
      type: 'object',
      required: ['ip'],
      properties: { ip: { type: 'string' } },
    },
  });
  const counts = summarize(lintSkill(s));
  assert.ok(counts.error >= 1); // required-no-description
  assert.ok(counts.warning >= 2); // summary-too-long, destructive-no-warning
});

test('ALL_RULES: every rule is exported in the registry', () => {
  // Sanity check that the aggregator runs everything (R1..R9).
  assert.ok(ALL_RULES.length >= 9);
});

test('lintSkill: passes through ctx to context-aware rules', () => {
  const src = `import 'node:fs';\nexport default async () => {};`;
  const results = lintSkill(skill(), { handlerSource: src });
  const forbidden = results.filter((r) => r.rule === 'forbidden-imports');
  assert.equal(forbidden.length, 1);
});
