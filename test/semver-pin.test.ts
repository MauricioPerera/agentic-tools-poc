/**
 * semver-pin.test.ts — pins the matcher's behaviour for the four range
 * forms we support (`X.Y.Z`, `^X.Y.Z`, `~X.Y.Z`, `*`/`latest`).
 *
 * The minimal surface is deliberate (see client/semver-pin.ts header). If
 * a future need adds range expressions or pre-release tags, those are new
 * tests + new code; they don't change what's here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  parseRange,
  compareVersions,
  isInRange,
  resolveBest,
} from '../client/semver-pin.ts';

// ---------------------------------------------------------------------------
// parseVersion / parseRange

test('parseVersion: round-trip simple semver', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('0.0.0'), { major: 0, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion('  10.20.30  '), { major: 10, minor: 20, patch: 30 });
});

test('parseVersion: rejects non-semver strings', () => {
  assert.throws(() => parseVersion('1.2'),       /invalid semver/);
  assert.throws(() => parseVersion('v1.2.3'),    /invalid semver/);
  assert.throws(() => parseVersion('1.2.3-beta'),/invalid semver/);
  assert.throws(() => parseVersion(''),          /invalid semver/);
});

test('parseRange: exact version becomes a single-version range', () => {
  const r = parseRange('1.2.3');
  assert.deepEqual(r.min, { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(r.maxExclusive, { major: 1, minor: 2, patch: 4 });
});

test('parseRange: ^X.Y.Z (caret) → >=X.Y.Z <(X+1).0.0', () => {
  const r = parseRange('^1.2.3');
  assert.deepEqual(r.min, { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(r.maxExclusive, { major: 2, minor: 0, patch: 0 });
});

test('parseRange: ^0.X.Y (caret on 0.x) → >=0.X.Y <0.(X+1).0  (npm-compat)', () => {
  // Matches npm's behaviour: under 0.x we treat the minor as the breaking-
  // change boundary, since 0.x APIs are explicitly unstable.
  const r = parseRange('^0.2.3');
  assert.deepEqual(r.min, { major: 0, minor: 2, patch: 3 });
  assert.deepEqual(r.maxExclusive, { major: 0, minor: 3, patch: 0 });
});

test('parseRange: ~X.Y.Z (tilde) → >=X.Y.Z <X.(Y+1).0', () => {
  const r = parseRange('~1.2.3');
  assert.deepEqual(r.min, { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(r.maxExclusive, { major: 1, minor: 3, patch: 0 });
});

test('parseRange: * and latest are unbounded', () => {
  for (const r of ['*', 'latest']) {
    const parsed = parseRange(r);
    assert.equal(parsed.maxExclusive, null);
  }
});

// ---------------------------------------------------------------------------
// compareVersions

test('compareVersions: respects major > minor > patch ordering', () => {
  assert.ok(compareVersions(parseVersion('2.0.0'), parseVersion('1.99.99')) > 0);
  assert.ok(compareVersions(parseVersion('1.2.0'), parseVersion('1.1.99')) > 0);
  assert.ok(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.4')) < 0);
  assert.equal(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
});

// ---------------------------------------------------------------------------
// isInRange

test('isInRange: exact match accepts only the literal version', () => {
  const r = parseRange('1.2.3');
  assert.ok( isInRange(parseVersion('1.2.3'), r));
  assert.ok(!isInRange(parseVersion('1.2.4'), r));
  assert.ok(!isInRange(parseVersion('1.2.2'), r));
});

test('isInRange: caret allows minor + patch but not major', () => {
  const r = parseRange('^1.2.3');
  assert.ok( isInRange(parseVersion('1.2.3'), r));
  assert.ok( isInRange(parseVersion('1.2.99'), r));
  assert.ok( isInRange(parseVersion('1.99.99'), r));
  assert.ok(!isInRange(parseVersion('2.0.0'), r));
  assert.ok(!isInRange(parseVersion('1.2.2'), r));
});

test('isInRange: tilde allows patch but not minor', () => {
  const r = parseRange('~1.2.3');
  assert.ok( isInRange(parseVersion('1.2.3'), r));
  assert.ok( isInRange(parseVersion('1.2.99'), r));
  assert.ok(!isInRange(parseVersion('1.3.0'), r));
});

// ---------------------------------------------------------------------------
// resolveBest — the function the loader actually calls

test('resolveBest: picks the highest matching version from a list', () => {
  const available = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];
  assert.equal(resolveBest(available, '^1.0.0'), '1.2.0');
  assert.equal(resolveBest(available, '~1.1.0'), '1.1.0');
  assert.equal(resolveBest(available, '1.0.0'),  '1.0.0');
  assert.equal(resolveBest(available, '*'),      '2.0.0');
});

test('resolveBest: returns null when nothing matches', () => {
  const available = ['1.0.0', '1.1.0'];
  assert.equal(resolveBest(available, '^2.0.0'), null);
  assert.equal(resolveBest(available, '0.9.0'),  null);
});

test('resolveBest: skips malformed entries silently', () => {
  // The manifest builder rejects bad versions, so this is a corner-case
  // safeguard rather than a primary code path. Documented so a future
  // refactor doesn't "fix" it by throwing.
  const available = ['1.0.0', 'not-a-version', '1.1.0'];
  assert.equal(resolveBest(available, '*'), '1.1.0');
});

test('resolveBest: empty available list returns null', () => {
  assert.equal(resolveBest([], '*'), null);
});
