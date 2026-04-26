/**
 * pricing.test.ts — covers the per-model pricing lookups + cost math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPricing, computeCost, formatCost } from '../client/pricing.ts';

// ---------------------------------------------------------------------------
// getPricing — lookup by model id substring

test('getPricing: matches Granite by full id', () => {
  const p = getPricing('@cf/ibm-granite/granite-4.0-h-micro');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0.017);
  assert.equal(p.outputPerMUSD, 0.11);
});

test('getPricing: Llama 3.1 8B fp8 quant gets fp8 entry', () => {
  const p = getPricing('@cf/meta/llama-3.1-8b-instruct-fp8');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0.15);
  assert.equal(p.notes, 'fp8 quant');
});

test('getPricing: Llama 3.1 8B awq quant gets awq entry', () => {
  const p = getPricing('@cf/meta/llama-3.1-8b-instruct-awq');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0.12);
  assert.equal(p.notes, 'awq quant');
});

test('getPricing: bare Llama 3.1 8B falls through to default fp8 prices', () => {
  // The pattern order resolves the unspecified variant to the fp8 rate.
  const p = getPricing('@cf/meta/llama-3.1-8b-instruct');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0.15);
});

test('getPricing: Hermes is marked beta with zero price', () => {
  const p = getPricing('@hf/nousresearch/hermes-2-pro-mistral-7b');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0);
  assert.equal(p.outputPerMUSD, 0);
  assert.equal(p.beta, true);
});

test('getPricing: returns null for unknown model', () => {
  assert.equal(getPricing('@cf/some/unlisted-model'), null);
});

test('getPricing: case-insensitive', () => {
  const p = getPricing('@CF/Google/Gemma-4-26B-A4B-IT');
  assert.ok(p);
  assert.equal(p.inputPerMUSD, 0.10);
});

// ---------------------------------------------------------------------------
// computeCost — token counts × pricing

test('computeCost: zero tokens → zero cost', () => {
  const p = getPricing('@cf/ibm-granite/granite-4.0-h-micro')!;
  assert.equal(computeCost(0, 0, p), 0);
});

test('computeCost: 1M input + 1M output on Granite', () => {
  const p = getPricing('@cf/ibm-granite/granite-4.0-h-micro')!;
  // 1M × 0.017 + 1M × 0.11 = 0.127
  assert.equal(computeCost(1_000_000, 1_000_000, p), 0.127);
});

test('computeCost: realistic small query (500 in, 30 out) on Gemma', () => {
  const p = getPricing('@cf/google/gemma-4-26b-a4b-it')!;
  // 500 × 0.10/1e6 = 0.00005, 30 × 0.30/1e6 = 0.000009 → 0.000059
  assert.equal(computeCost(500, 30, p), 0.000059);
});

test('computeCost: rounding to 6 decimals stays sane', () => {
  const p = getPricing('@cf/ibm-granite/granite-4.0-h-micro')!;
  const c = computeCost(123, 7, p);
  // Should be rounded, not 0.0000020910000000000003 or similar floating noise
  const decimals = String(c).split('.')[1]?.length ?? 0;
  assert.ok(decimals <= 6, `expected ≤ 6 decimals, got ${decimals} (${c})`);
});

test('computeCost: beta model with zero pricing → zero cost', () => {
  const p = getPricing('@hf/nousresearch/hermes-2-pro-mistral-7b')!;
  assert.equal(computeCost(10000, 10000, p), 0);
});

// ---------------------------------------------------------------------------
// formatCost — human-readable rendering

test('formatCost: zero', () => {
  assert.equal(formatCost(0), '$0');
});

test('formatCost: sub-microcent values', () => {
  assert.equal(formatCost(0.0000005), '<$0.000001');
});

test('formatCost: micro-USD precision', () => {
  assert.equal(formatCost(0.000123), '$0.000123');
});

test('formatCost: cents range', () => {
  assert.equal(formatCost(0.0123), '$0.0123');
});

test('formatCost: dollar range', () => {
  assert.equal(formatCost(1.23), '$1.23');
});
