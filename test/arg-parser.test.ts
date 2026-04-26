/**
 * arg-parser.test.mjs — covers the parsers consolidated in client/arg-parser.mjs.
 *
 * The argv-side functions (parseArgvAgainstSchema, coerceArgvValue) are
 * already exhaustively tested via the loader.test.mjs re-exports. Here we
 * focus on the model-side ones (parseToolCallArguments, inputToArgv) plus
 * cross-roundtrip tests showing argv ↔ input conversion is consistent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgvAgainstSchema,
  coerceArgvValue,
  parseToolCallArguments,
  inputToArgv,
  argvToShellCommand,
} from '../client/arg-parser.ts';
import type { JSONSchema } from '../types/index.ts';

// ---------------------------------------------------------------------------
// parseToolCallArguments

test('parseToolCallArguments: null/undefined → {}', () => {
  assert.deepEqual(parseToolCallArguments(null), {});
  assert.deepEqual(parseToolCallArguments(undefined), {});
});

test('parseToolCallArguments: object passes through', () => {
  assert.deepEqual(parseToolCallArguments({ command: 'ls' }), { command: 'ls' });
});

test('parseToolCallArguments: single-encoded JSON string', () => {
  const raw = JSON.stringify({ command: 'ls -la' });
  assert.deepEqual(parseToolCallArguments(raw), { command: 'ls -la' });
});

test('parseToolCallArguments: double-encoded JSON string (Granite quirk)', () => {
  // Workers AI sometimes returns arguments wrapped twice. Real example:
  //   '"{\n  \\"command\\": \\"ip-info | jq -r .country\\"\n}"'
  const inner = JSON.stringify({ command: 'ip-info' });
  const outer = JSON.stringify(inner);
  assert.deepEqual(parseToolCallArguments(outer), { command: 'ip-info' });
});

test('parseToolCallArguments: malformed JSON → {}', () => {
  assert.deepEqual(parseToolCallArguments('not valid json'), {});
});

test('parseToolCallArguments: parsed-to-null → {}', () => {
  assert.deepEqual(parseToolCallArguments('null'), {});
});

// ---------------------------------------------------------------------------
// inputToArgv

test('inputToArgv: empty object → empty argv', () => {
  assert.deepEqual(inputToArgv({}), []);
});

test('inputToArgv: string fields produce clean --key value pairs', () => {
  assert.deepEqual(
    inputToArgv({ text: 'hello' }),
    ['--text', 'hello']
  );
});

test('inputToArgv: boolean true becomes bare --flag', () => {
  assert.deepEqual(
    inputToArgv({ upper: true, text: 'x' }),
    ['--upper', '--text', 'x']
  );
});

test('inputToArgv: boolean false is dropped (matches schema default semantics)', () => {
  assert.deepEqual(inputToArgv({ upper: false, text: 'x' }), ['--text', 'x']);
});

test('inputToArgv: null and undefined are dropped', () => {
  assert.deepEqual(inputToArgv({ a: null, b: undefined, c: 'v' }), ['--c', 'v']);
});

test('inputToArgv: numbers are stringified without quoting', () => {
  assert.deepEqual(inputToArgv({ n: 42 }), ['--n', '42']);
});

// ---------------------------------------------------------------------------
// argvToShellCommand — quoting added only when needed

test('argvToShellCommand: simple values are not quoted', () => {
  assert.equal(argvToShellCommand(['--text', 'hello']), '--text hello');
});

test('argvToShellCommand: values with spaces are double-quoted', () => {
  assert.equal(argvToShellCommand(['--text', 'hello world']), '--text "hello world"');
});

test('argvToShellCommand: values with shell metachars are quoted', () => {
  assert.equal(argvToShellCommand(['--text', 'a|b']), '--text "a|b"');
  assert.equal(argvToShellCommand(['--text', 'a;b']), '--text "a;b"');
});

test('argvToShellCommand: dollar signs and backticks are escaped', () => {
  assert.equal(
    argvToShellCommand(['--text', '$VAR or `cmd`']),
    '--text "\\$VAR or \\`cmd\\`"'
  );
});

test('argvToShellCommand: bare flags pass through unchanged', () => {
  assert.equal(argvToShellCommand(['--upper', '--lower']), '--upper --lower');
});

// ---------------------------------------------------------------------------
// Roundtrip: input → argv → input should be lossless for typical shapes

test('roundtrip: input → inputToArgv → parseArgvAgainstSchema yields original', () => {
  const schema: JSONSchema = {
    type: 'object',
    required: ['text'],
    properties: {
      text:   { type: 'string' },
      upper:  { type: 'boolean' },
      prefix: { type: 'string' },
    },
  };
  const input = { text: 'hello', upper: true, prefix: '>>' };
  const argv  = inputToArgv(input);
  const back  = parseArgvAgainstSchema(argv, '', schema);
  assert.deepEqual(back, input);
});

test('roundtrip: number coercion survives the loop', () => {
  const schema: JSONSchema = {
    type: 'object',
    required: ['n'],
    properties: { n: { type: 'integer' } },
  };
  // inputToArgv stringifies, parseArgv coerces back to number per schema.
  const argv = inputToArgv({ n: 42 });
  const back = parseArgvAgainstSchema(argv, '', schema);
  assert.deepEqual(back, { n: 42 });
});

// ---------------------------------------------------------------------------
// coerceArgvValue is also re-exported here — sanity check it's the same fn

test('coerceArgvValue exported here matches loader.coerce behaviour', async () => {
  const { coerce } = await import('../client/loader.ts');
  assert.equal(coerce, coerceArgvValue);
});
