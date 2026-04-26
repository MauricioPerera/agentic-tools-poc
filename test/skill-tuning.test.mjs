/**
 * skill-tuning.test.mjs — covers the per-model override layer:
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
} from '../client/skill-tuning.mjs';

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
};

const TOOL_WITHOUT_OVERRIDES = {
  slug: 'echo-pretty',
  summary: 'plain summary',
  inputSchema: { type: 'object', properties: {} },
};

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
  assert.deepEqual(t.inputSchema.properties, {});
});

test('applyModelOverrides: only OVERRIDABLE_FIELDS replace tool fields', () => {
  // system_prompt_fragments belongs to the AGGREGATED set, not the per-tool
  // overrides — it should NOT appear on the returned tool object.
  const t = applyModelOverrides(TOOL_WITH_OVERRIDES, 'hermes-foo');
  assert.equal(t.system_prompt_fragments, undefined);
});

test('applyModelOverrides: original tool not mutated', () => {
  const before = JSON.stringify(TOOL_WITH_OVERRIDES);
  applyModelOverrides(TOOL_WITH_OVERRIDES, 'hermes');
  assert.equal(JSON.stringify(TOOL_WITH_OVERRIDES), before);
});

// ---------------------------------------------------------------------------
// applyOverridesToManifest

test('applyOverridesToManifest: applies to every tool', () => {
  const manifest = { tools: [TOOL_WITH_OVERRIDES, TOOL_WITHOUT_OVERRIDES] };
  const out = applyOverridesToManifest(manifest, '@hf/.../hermes-2-pro');
  assert.equal(out.tools[0].summary, 'hermes-tuned summary');
  assert.equal(out.tools[1].summary, 'plain summary');
});

test('applyOverridesToManifest: keeps non-tools fields intact', () => {
  const manifest = { registryVersion: '1.0', tools: [TOOL_WITH_OVERRIDES] };
  const out = applyOverridesToManifest(manifest, 'qwen');
  assert.equal(out.registryVersion, '1.0');
});

// ---------------------------------------------------------------------------
// getSystemPromptFragments (Phase C)

test('getSystemPromptFragments: returns matching fragments in order', () => {
  const manifest = { tools: [TOOL_WITH_OVERRIDES] };
  const fragments = getSystemPromptFragments(manifest, '@hf/.../hermes-2-pro');
  assert.deepEqual(fragments, [
    'Never invent IPs.',
    'Retry instead of giving up.',
  ]);
});

test('getSystemPromptFragments: empty when no model match', () => {
  const manifest = { tools: [TOOL_WITH_OVERRIDES] };
  assert.deepEqual(getSystemPromptFragments(manifest, '@cf/granite'), []);
});

test('getSystemPromptFragments: empty when override has no fragments', () => {
  const manifest = { tools: [TOOL_WITH_OVERRIDES] };
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
  };
  const fragments = getSystemPromptFragments({ tools: [a, b] }, 'hermes');
  assert.equal(fragments.length, 3);
  assert.ok(fragments.includes('Always validate before submitting.'));
});

test('getSystemPromptFragments: deduplicates identical fragments', () => {
  const tool = (slug) => ({
    slug,
    inputSchema: { type: 'object', properties: {} },
    model_overrides: {
      hermes: { system_prompt_fragments: ['Be terse.'] },
    },
  });
  const fragments = getSystemPromptFragments({ tools: [tool('a'), tool('b'), tool('c')] }, 'hermes');
  assert.deepEqual(fragments, ['Be terse.']);
});

test('getSystemPromptFragments: handles empty / missing manifest gracefully', () => {
  assert.deepEqual(getSystemPromptFragments({}, 'hermes'), []);
  assert.deepEqual(getSystemPromptFragments({ tools: [] }, 'hermes'), []);
  assert.deepEqual(getSystemPromptFragments(null, 'hermes'), []);
  assert.deepEqual(getSystemPromptFragments(undefined, 'hermes'), []);
});

test('getSystemPromptFragments: ignores non-string entries', () => {
  const t = {
    slug: 'x',
    inputSchema: { type: 'object', properties: {} },
    model_overrides: {
      hermes: {
        system_prompt_fragments: ['ok', 42, null, undefined, { not: 'a string' }],
      },
    },
  };
  assert.deepEqual(getSystemPromptFragments({ tools: [t] }, 'hermes'), ['ok']);
});
