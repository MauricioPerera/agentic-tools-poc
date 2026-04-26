/**
 * jsonschema-to-ts.test.ts — covers the codegen converter rule by rule.
 *
 * Each TS construct (primitive, enum, array, object, optional vs required,
 * nested, descriptions) gets a focused test. A future change that subtly
 * mishandles one shape is caught here, not via "the build broke" downstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaToTypeScript } from '../client/jsonschema-to-ts.ts';
import type { JSONSchema } from '../types/index.ts';

// ---------------------------------------------------------------------------
// Primitives

test('primitives: string', () => {
  assert.equal(schemaToTypeScript({ type: 'string' }), 'string');
});

test('primitives: number / integer collapse to number', () => {
  assert.equal(schemaToTypeScript({ type: 'number' }), 'number');
  assert.equal(schemaToTypeScript({ type: 'integer' }), 'number');
});

test('primitives: boolean', () => {
  assert.equal(schemaToTypeScript({ type: 'boolean' }), 'boolean');
});

test('primitives: null', () => {
  assert.equal(schemaToTypeScript({ type: 'null' }), 'null');
});

test('primitives: undefined schema → unknown', () => {
  assert.equal(schemaToTypeScript(undefined), 'unknown');
});

test('primitives: unrecognized type → unknown', () => {
  assert.equal(schemaToTypeScript({ type: 'foo' as JSONSchema['type'] }), 'unknown');
});

// ---------------------------------------------------------------------------
// Enum (wins over type)

test('enum: single value', () => {
  assert.equal(schemaToTypeScript({ type: 'string', enum: ['only'] }), '"only"');
});

test('enum: multiple values become a union', () => {
  assert.equal(
    schemaToTypeScript({ type: 'string', enum: ['low', 'medium', 'high'] }),
    '"low" | "medium" | "high"',
  );
});

test('enum: numeric values', () => {
  assert.equal(
    schemaToTypeScript({ type: 'integer', enum: [1, 2, 3] }),
    '1 | 2 | 3',
  );
});

// ---------------------------------------------------------------------------
// Array

test('array: of primitives → T[]', () => {
  assert.equal(
    schemaToTypeScript({ type: 'array', items: { type: 'string' } }),
    'string[]',
  );
});

test('array: of unions → Array<T> (parens-safe)', () => {
  assert.equal(
    schemaToTypeScript({
      type: 'array',
      items: { type: 'string', enum: ['a', 'b'] },
    }),
    'Array<"a" | "b">',
  );
});

// ---------------------------------------------------------------------------
// Object

test('object: empty → Record<string, never>', () => {
  assert.equal(schemaToTypeScript({ type: 'object', properties: {} }), 'Record<string, never>');
});

test('object: required + optional fields rendered with `?`', () => {
  const result = schemaToTypeScript({
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string' },
      upper: { type: 'boolean' },
    },
  });
  assert.match(result, /text: string;/);
  assert.match(result, /upper\?: boolean;/);
});

test('object: descriptions become JSDoc above the field', () => {
  const result = schemaToTypeScript({
    type: 'object',
    properties: {
      ip: { type: 'string', description: 'IPv4 or IPv6' },
    },
  });
  assert.match(result, /\/\*\* IPv4 or IPv6 \*\/\s*\n\s*ip\?: string;/);
});

test('object: nested objects', () => {
  const result = schemaToTypeScript({
    type: 'object',
    required: ['user'],
    properties: {
      user: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  });
  assert.match(result, /user: \{/);
  assert.match(result, /id: string;/);
  assert.match(result, /name\?: string;/);
});

test('object: array of objects', () => {
  const result = schemaToTypeScript({
    type: 'array',
    items: {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' }, votes: { type: 'integer' } },
    },
  });
  assert.match(result, /^{/);
  assert.match(result, /title: string;/);
  assert.match(result, /votes\?: number;/);
});

test('object: weird key names get quoted', () => {
  const result = schemaToTypeScript({
    type: 'object',
    properties: {
      'kebab-key': { type: 'string' },
      '123start': { type: 'string' },
      validKey: { type: 'string' },
    },
  });
  assert.match(result, /"kebab-key"\?: string;/);
  assert.match(result, /"123start"\?: string;/);
  assert.match(result, /\bvalidKey\?: string;/);
});

// ---------------------------------------------------------------------------
// Real-world fixtures (mirrors what each registry skill emits)

test('fixture: ip-info-style schema', () => {
  const result = schemaToTypeScript({
    type: 'object',
    properties: {
      ip: { type: 'string', default: '', description: "IP to look up. Empty string (default) → caller's public IP." },
    },
  });
  assert.match(result, /ip\?: string;/);
  assert.match(result, /caller's public IP/);
});

test('fixture: echo-pretty-style schema', () => {
  const result = schemaToTypeScript({
    type: 'object',
    required: ['text'],
    properties: {
      text:   { type: 'string', description: 'Text to echo back' },
      upper:  { type: 'boolean', default: false, description: 'Uppercase output' },
      lower:  { type: 'boolean', default: false, description: 'Lowercase output' },
      prefix: { type: 'string',  default: '',    description: 'Optional prefix' },
    },
  });
  // text required, others optional
  assert.match(result, /\btext: string;/);
  assert.match(result, /upper\?: boolean;/);
  assert.match(result, /lower\?: boolean;/);
  assert.match(result, /prefix\?: string;/);
});
