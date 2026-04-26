/**
 * skill-tuning.test.ts — covers the per-model override layer:
 *   - applyModelOverrides (single tool)
 *   - applyOverridesToManifest (whole manifest)
 *   - getSystemPromptFragments (Phase C — aggregation across skills)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelOverrides,
  applyOverridesToManifest,
  getSystemPromptFragments,
} from '../client/skill-tuning.ts';
import type { Manifest, SkillDef } from '../types/index.ts';

// Test fixtures — only carry the fields the unit-under-test inspects.
// `as unknown as SkillDef` keeps the test readable while satisfying TS.
const TOOL_WITH_OVERRIDES = {
  slug: 'ip-info',
  summary: 'default summary',
  inputSchema: { type: 'object', properties: { ip: { type: 'string' } } },
  model_overrides: {
    hermes: {
      summary: 'hermes-tuned summary',
      inputSchema: { type: 'object', properties: {} },
      system_prompt_fragments: [
        'Never invent IPs.',
        'Retry instead of giving up.',
      ],
    },
    qwen: {
      summary: 'qwen-tuned summary',
    },
  },
} as unknown as SkillDef;

const TOOL_WITHOUT_OVERRIDES = {
  slug: 'echo-pretty',
  summary: 'plain summary',
  inputSchema: { type: 'object', properties: {} },
} as unknown as SkillDef;

const asManifest = (tools: SkillDef[], extra: Partial<Manifest> = {}): Manifest =>
  ({ registryVersion: '1.0', generatedAt: 'test', commit: null, tools, ...extra });

// ---------------------------------------------------------------------------
// applyModelOverrides

test('applyModelOverrides: no model passed → tool unchanged', () => {
  assert.deepEqual(applyModelOverrides(TOOL_WITH_OVERRIDES, ''), TOOL_WITH_OVERRIDES);
  assert.deepEqual(applyModelOverrides(TOOL_WITH_OVERRIDES, undefined), TOOL_WITH_OVERRIDES);
});

test('applyModelOverrides: no model_overrides → tool unchanged', () => {
  assert.deepEqual(
    applyModelOverrides(TOOL_WITHOUT_OVERRIDES, '@hf/.../hermes-2-pro'),
    TOOL_WITHOUT_OVERRIDES
  );
});

test('applyModelOverrides: substring match (case-insensitive)', () => {
  const t = applyModelOverrides(TOOL_WITH_OVERRIDES, '@hf/nousresearch/hermes-2-pro-mistral-7b');
  assert.equal(t.summary, 'hermes-tuned summary');
  assert.deepEqual((t.inputSchema as { properties: unknown }).properties, {});
});

test('applyModelOverrides: only OVERRIDABLE_FIELDS replace tool fields', () => {
  // system_prompt_fragments belongs to the AGGREGATED set, not the per-tool
  // overrides — it should NOT appear on the returned tool object.
  const t = applyModelOverrides(TOOL_WITH_OVERRIDES, 'hermes-foo');
  assert.equal((t as unknown as Record<string, unknown>)['system_prompt_fragments'], undefined);
});

test('applyModelOverrides: original tool not mutated', () => {
  const before = JSON.stringify(TOOL_WITH_OVERRIDES);
  applyModelOverrides(TOOL_WITH_OVERRIDES, 'hermes');
  assert.equal(JSON.stringify(TOOL_WITH_OVERRIDES), before);
});

// ---------------------------------------------------------------------------
// applyOverridesToManifest

test('applyOverridesToManifest: applies to every tool', () => {
  const manifest = asManifest([TOOL_WITH_OVERRIDES, TOOL_WITHOUT_OVERRIDES]);
  const out = applyOverridesToManifest(manifest, '@hf/.../hermes-2-pro');
  assert.equal(out.tools[0]?.summary, 'hermes-tuned summary');
  assert.equal(out.tools[1]?.summary, 'plain summary');
});

test('applyOverridesToManifest: keeps non-tools fields intact', () => {
  const manifest = asManifest([TOOL_WITH_OVERRIDES], { registryVersion: '1.0' });
  const out = applyOverridesToManifest(manifest, 'qwen');
  assert.equal(out.registryVersion, '1.0');
});

// ---------------------------------------------------------------------------
// getSystemPromptFragments (Phase C)

test('getSystemPromptFragments: returns matching fragments in order', () => {
  const manifest = asManifest([TOOL_WITH_OVERRIDES]);
  const fragments = getSystemPromptFragments(manifest, '@hf/.../hermes-2-pro');
  assert.deepEqual(fragments, [
    'Never invent IPs.',
    'Retry instead of giving up.',
  ]);
});

test('getSystemPromptFragments: empty when no model match', () => {
  const manifest = asManifest([TOOL_WITH_OVERRIDES]);
  assert.deepEqual(getSystemPromptFragments(manifest, '@cf/granite'), []);
});

test('getSystemPromptFragments: empty when override has no fragments', () => {
  const manifest = asManifest([TOOL_WITH_OVERRIDES]);
  // qwen override has summary but no system_prompt_fragments
  assert.deepEqual(getSystemPromptFragments(manifest, 'qwen-7b'), []);
});

test('getSystemPromptFragments: aggregates across multiple tools', () => {
  const a = { ...TOOL_WITH_OVERRIDES };
  const b = {
    slug: 'other',
    inputSchema: { type: 'object', properties: {} },
    model_overrides: {
      hermes: {
        system_prompt_fragments: ['Always validate before submitting.'],
      },
    },
  } as unknown as SkillDef;
  const fragments = getSystemPromptFragments(asManifest([a, b]), 'hermes');
  assert.equal(fragments.length, 3);
  assert.ok(fragments.includes('Always validate before submitting.'));
});

test('getSystemPromptFragments: deduplicates identical fragments', () => {
  const tool = (slug: string): SkillDef => ({
    slug,
    inputSchema: { type: 'object', properties: {} },
    model_overrides: {
      hermes: { system_prompt_fragments: ['Be terse.'] },
    },
  } as unknown as SkillDef);
  const fragments = getSystemPromptFragments(
    asManifest([tool('a'), tool('b'), tool('c')]),
    'hermes',
  );
  assert.deepEqual(fragments, ['Be terse.']);
});

test('getSystemPromptFragments: handles empty / missing manifest gracefully', () => {
  // Implementation accepts loose shapes; cast through unknown to exercise them.
  const sloppy = (m: unknown) => getSystemPromptFragments(m as Manifest | null, 'hermes');
  assert.deepEqual(sloppy({}), []);
  assert.deepEqual(sloppy({ tools: [] }), []);
  assert.deepEqual(sloppy(null), []);
  assert.deepEqual(sloppy(undefined), []);
});

test('getSystemPromptFragments: ignores non-string entries', () => {
  const t = {
    slug: 'x',
    inputSchema: { type: 'object', properties: {} },
    model_overrides: {
      hermes: {
        // Deliberately mixed types — runtime should keep only the strings.
        system_prompt_fragments: ['ok', 42, null, undefined, { not: 'a string' }] as unknown as string[],
      },
    },
  } as unknown as SkillDef;
  assert.deepEqual(getSystemPromptFragments(asManifest([t]), 'hermes'), ['ok']);
});
