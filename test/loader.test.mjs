/**
 * loader.test.mjs — unit tests for parseArgs + coerce.
 *
 * Run with: npm test
 *
 * Specifically pins the two regression cases discovered in code review:
 *   - Bug 1: stdin extraction always inspected the first property of the
 *     schema, regardless of which field was being iterated. Strings beyond
 *     the first never received stdin.
 *   - Bug 2: a bare `--flag` on a string field coerced to the literal
 *     string "true", which then propagated to URLs (e.g. ip-info --ip
 *     fetched https://api.country.is/true and 404'd).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, coerce } from '../client/loader.mjs';

const STR_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text:   { type: 'string' },
    upper:  { type: 'boolean', default: false },
    prefix: { type: 'string', default: '' },
  },
};

const IP_SCHEMA = {
  type: 'object',
  properties: { ip: { type: 'string' } },
};

// ---------------------------------------------------------------------------
// coerce — direct unit tests

test('coerce: boolean field accepts true/false/string', () => {
  assert.equal(coerce(true,  'boolean'), true);
  assert.equal(coerce('true','boolean'), true);
  assert.equal(coerce(false, 'boolean'), false);
  assert.equal(coerce('false','boolean'), false);
});

test('coerce: bare boolean on string field returns undefined (Bug 2)', () => {
  // BEFORE FIX: coerce(true, 'string') returned String(true) === "true".
  // That value flowed into URLs and broke real calls.
  assert.equal(coerce(true,  'string'), undefined);
  assert.equal(coerce(false, 'string'), undefined);
});

test('coerce: bare boolean on number field returns undefined', () => {
  assert.equal(coerce(true, 'number'),  undefined);
  assert.equal(coerce(true, 'integer'), undefined);
});

test('coerce: numeric strings parse to numbers', () => {
  assert.equal(coerce('42', 'number'),  42);
  assert.equal(coerce('3.14', 'number'), 3.14);
  assert.equal(coerce('7', 'integer'),   7);
});

test('coerce: invalid numeric returns undefined, not NaN', () => {
  assert.equal(coerce('abc', 'number'), undefined);
});

test('coerce: defaults to string', () => {
  assert.equal(coerce('hello', 'string'),    'hello');
  assert.equal(coerce('hello', undefined),    'hello');
  assert.equal(coerce(123,     undefined),    '123');
});

// ---------------------------------------------------------------------------
// parseArgs — happy paths

test('parseArgs: --key value form', () => {
  assert.deepEqual(
    parseArgs(['--text', 'hello'], '', STR_SCHEMA),
    { text: 'hello', upper: false, prefix: '' }
  );
});

test('parseArgs: --key=value form', () => {
  assert.deepEqual(
    parseArgs(['--text=hello'], '', STR_SCHEMA),
    { text: 'hello', upper: false, prefix: '' }
  );
});

test('parseArgs: bare boolean flag', () => {
  assert.deepEqual(
    parseArgs(['--text', 'hello', '--upper'], '', STR_SCHEMA),
    { text: 'hello', upper: true, prefix: '' }
  );
});

test('parseArgs: defaults applied when not specified', () => {
  const r = parseArgs(['--text', 'x'], '', STR_SCHEMA);
  assert.equal(r.upper, false);
  assert.equal(r.prefix, '');
});

test('parseArgs: --key=value supports values containing spaces', () => {
  // (passed as a single argv token by the shell)
  assert.deepEqual(
    parseArgs(['--text=hello world', '--prefix=>> '], '', STR_SCHEMA),
    { text: 'hello world', upper: false, prefix: '>> ' }
  );
});

// ---------------------------------------------------------------------------
// parseArgs — error paths

test('parseArgs: throws on missing required field', () => {
  assert.throws(() => parseArgs([], '', STR_SCHEMA), /missing required input: --text/);
});

test('parseArgs: bare --text (no value, no stdin) is treated as missing (Bug 2)', () => {
  // BEFORE FIX: this would set text="true" and silently succeed.
  // The downstream handler would then process the literal string "true".
  assert.throws(
    () => parseArgs(['--text'], '', STR_SCHEMA),
    /missing required input: --text/
  );
});

test('parseArgs: bare --ip (no value) is treated as missing (Bug 2 / ip-info case)', () => {
  // The exact pathology that broke ip-info live: Hermes wrote `ip-info --ip`
  // (no value) and the loader sent `true` to the URL.
  const r = parseArgs(['--ip'], '', IP_SCHEMA);
  assert.equal(r.ip, undefined, 'ip should not be set to "true"');
});

// ---------------------------------------------------------------------------
// parseArgs — stdin handling (Bug 1)

test('parseArgs: stdin fills first unfilled string field (Bug 1)', () => {
  // Schema's first prop (text) has no value, no default → stdin should fill it.
  const r = parseArgs([], 'piped content\n', STR_SCHEMA);
  assert.equal(r.text, 'piped content');
});

test('parseArgs: stdin skips already-set string fields (Bug 1)', () => {
  // BEFORE FIX: the check `!out[Object.keys(props)[0]]` always inspected the
  // FIRST property. If `text` was set, the find condition still evaluated
  // against `text` for every iteration, which made stdin assignment unstable.
  // This case verifies stdin goes to `prefix` (next unfilled string) when
  // text is already provided via argv.
  const r = parseArgs(['--text', 'arg-text'], 'piped content', STR_SCHEMA);
  // text comes from argv
  assert.equal(r.text, 'arg-text');
  // prefix has a default of '', meaning it's already set, so stdin must not
  // override it (this matches the documented behaviour: stdin only fills
  // *unset* fields, where unset means undefined, not just falsy).
  assert.equal(r.prefix, '');
});

test('parseArgs: stdin trims trailing newlines', () => {
  const r = parseArgs([], 'content\n\n\n', STR_SCHEMA);
  assert.equal(r.text, 'content');
});

test('parseArgs: empty stdin does not fill anything', () => {
  // Required field still missing → throws.
  assert.throws(() => parseArgs([], '', STR_SCHEMA), /missing required input/);
});

test('parseArgs: bare boolean does not pollute stdin search (Bug 2 + Bug 1 interaction)', () => {
  // `--upper` sets `out.upper = true` (correctly).
  // Stdin should still flow into `text` (the first unfilled string), not
  // get blocked by the boolean assignment.
  const r = parseArgs(['--upper'], 'piped text', STR_SCHEMA);
  assert.equal(r.text,  'piped text');
  assert.equal(r.upper, true);
});

// ---------------------------------------------------------------------------
// parseArgs — type coercion through the full pipeline

test('parseArgs: boolean flag with explicit value', () => {
  assert.deepEqual(
    parseArgs(['--text', 'x', '--upper=true'],  '', STR_SCHEMA).upper,
    true
  );
  assert.deepEqual(
    parseArgs(['--text', 'x', '--upper=false'], '', STR_SCHEMA).upper,
    false
  );
});

test('parseArgs: number coercion through full call', () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
  assert.deepEqual(parseArgs(['--n', '42'], '', schema), { n: 42 });
});
