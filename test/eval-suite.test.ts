/**
 * eval-suite.test.ts — invariants on the bucketed query corpus
 * (client/eval-suite.ts) that guarantee compare.ts can run a coherent
 * benchmark without API calls.
 *
 * These run as part of `npm test` so that adding/editing queries during a
 * normal PR catches structural mistakes (wrong bucket label, broken
 * regex, duplicated id) before the queries ever reach a real model.
 *
 * The tests intentionally do NOT exercise the runner or call any model —
 * that's the user's call (full sweep ≈ 200 model calls × ~$0.05 total
 * across the 5 priced models). Validation here is purely structural.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERIES_BASIC,
  QUERIES_FULL,
  selectSuite,
  type Bucket,
  type Query,
} from '../client/eval-suite.ts';

const ALL_BUCKETS: Bucket[] = [
  'single', 'chain-2', 'chain-multi', 'error', 'discipline', 'ambiguous',
];

// ---------------------------------------------------------------------------
// QUERIES_FULL invariants

test('eval-suite: QUERIES_FULL has at least 20 queries (issue #3 minimum)', () => {
  assert.ok(QUERIES_FULL.length >= 20, `expected ≥20 queries, got ${QUERIES_FULL.length}`);
});

test('eval-suite: every bucket appears at least once in QUERIES_FULL', () => {
  const seen = new Set(QUERIES_FULL.map((q) => q.bucket));
  for (const b of ALL_BUCKETS) {
    assert.ok(seen.has(b), `bucket "${b}" missing from QUERIES_FULL`);
  }
});

test('eval-suite: every query.id is unique', () => {
  const ids = QUERIES_FULL.map((q) => q.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('eval-suite: every query.expect is a non-trivial RegExp', () => {
  for (const q of QUERIES_FULL) {
    assert.ok(q.expect instanceof RegExp, `${q.id}: expect must be a RegExp`);
    assert.ok(q.expect.source.length > 0, `${q.id}: expect regex is empty`);
    // Make sure it can run (no syntax-level surprises). new RegExp(source, flags)
    // is a strict round-trip — any bad construction throws here.
    new RegExp(q.expect.source, q.expect.flags);
  }
});

test('eval-suite: query.text is non-empty and ends with explicit reply guidance', () => {
  // Models reliably truncate / reformat unless told what shape to emit.
  // Each query must end with "Reply with just …" (or similar) so the
  // expectation regex has a fighting chance against a verbose model.
  for (const q of QUERIES_FULL) {
    assert.ok(q.text.length > 0, `${q.id}: empty text`);
    assert.match(
      q.text,
      /reply\s+with/i,
      `${q.id}: text must end with explicit reply guidance ("Reply with …")`,
    );
  }
});

test('eval-suite: expectNoTool=true is restricted to the discipline bucket', () => {
  // Mixing expectNoTool with other buckets has no defined meaning today —
  // either the bucket implies tool use (single/chain) or it implies
  // discipline. Keeping the flag scoped avoids accidental misuse.
  for (const q of QUERIES_FULL) {
    if (q.expectNoTool === true) {
      assert.equal(
        q.bucket,
        'discipline',
        `${q.id}: expectNoTool=true is only valid in the 'discipline' bucket`,
      );
    }
  }
});

test('eval-suite: every discipline-bucket query has expectNoTool=true', () => {
  // Inverse of the previous: the discipline bucket exists specifically to
  // measure WITHOUT_TOOL outcomes; any discipline query without
  // expectNoTool=true is a bug (the runner would score it backwards).
  for (const q of QUERIES_FULL) {
    if (q.bucket === 'discipline') {
      assert.equal(q.expectNoTool, true, `${q.id}: discipline query must set expectNoTool=true`);
    }
  }
});

// ---------------------------------------------------------------------------
// QUERIES_BASIC backward-compat

test('eval-suite: QUERIES_BASIC remains the original 3 queries', () => {
  assert.equal(QUERIES_BASIC.length, 3);
  assert.deepEqual(QUERIES_BASIC.map((q) => q.id), ['Q1-simple', 'Q2-extract', 'Q3-chain']);
});

test('eval-suite: QUERIES_BASIC items are present (verbatim) inside QUERIES_FULL', () => {
  // The README's prior numbers were captured with QUERIES_BASIC. The full
  // suite is a superset, so the original three must still be the same
  // queries (same id, same text, same regex) — comparing across runs
  // would otherwise require re-running the basic numbers.
  for (const basic of QUERIES_BASIC) {
    const full = QUERIES_FULL.find((q) => q.id === basic.id);
    assert.ok(full, `Q ${basic.id} missing from QUERIES_FULL`);
    assert.equal(full.text, basic.text);
    assert.equal(full.expect.source, basic.expect.source);
    assert.equal(full.expect.flags,  basic.expect.flags);
  }
});

// ---------------------------------------------------------------------------
// selectSuite (the env-driven selector compare.ts uses)

test('selectSuite: returns BASIC for "basic"', () => {
  const r = selectSuite('basic');
  assert.deepEqual(r?.map((q) => q.id), QUERIES_BASIC.map((q) => q.id));
});

test('selectSuite: returns FULL for "full"', () => {
  const r = selectSuite('full');
  assert.equal(r?.length, QUERIES_FULL.length);
});

test('selectSuite: returns just the matching bucket for a known bucket name', () => {
  for (const b of ALL_BUCKETS) {
    const r = selectSuite(b);
    assert.ok(r && r.length > 0, `bucket "${b}" should match at least one query`);
    assert.ok(r.every((q) => q.bucket === b), `selectSuite("${b}") must contain only ${b} queries`);
  }
});

test('selectSuite: case-insensitive (matches uppercase env vars too)', () => {
  const r = selectSuite('FULL');
  assert.equal(r?.length, QUERIES_FULL.length);
});

test('selectSuite: returns null for unknown identifiers', () => {
  assert.equal(selectSuite('unknown-bucket'), null);
  assert.equal(selectSuite(''), null);
});

// ---------------------------------------------------------------------------
// Per-bucket count documentation — locks in the issue #3 distribution so
// drift (e.g. "I'll just add 5 more discipline queries quickly") is a
// deliberate decision in code review, not an accident.

test('eval-suite: bucket distribution matches the issue #3 design', () => {
  const counts: Record<Bucket, number> = {
    single: 0, 'chain-2': 0, 'chain-multi': 0, error: 0, discipline: 0, ambiguous: 0,
  };
  for (const q of QUERIES_FULL) counts[q.bucket]++;
  // Issue #3 minimums: 4 single, 3 chain-2, 2 chain-multi, ≥3 error,
  // ≥4 discipline, ≥3 ambiguous.
  assert.ok(counts.single >= 4,        `single=${counts.single}, expected ≥4`);
  assert.ok(counts['chain-2'] >= 3,    `chain-2=${counts['chain-2']}, expected ≥3`);
  assert.ok(counts['chain-multi'] >= 2,`chain-multi=${counts['chain-multi']}, expected ≥2`);
  assert.ok(counts.error >= 3,         `error=${counts.error}, expected ≥3`);
  assert.ok(counts.discipline >= 4,    `discipline=${counts.discipline}, expected ≥4`);
  assert.ok(counts.ambiguous >= 3,     `ambiguous=${counts.ambiguous}, expected ≥3`);
});
