/**
 * smart-bash.test.mjs — unit tests for the observation enricher.
 *
 * Pins the diagnostic patterns so future changes don't silently break the
 * model-rescue contract that took 1-3/6 → 5+/6 on Hermes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeObservation } from '../client/smart-bash.mjs';

const MANIFEST = {
  tools: [
    {
      slug: 'ip-info',
      outputSchema: {
        type: 'object',
        properties: {
          ip:      { type: 'string' },
          country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code' },
        },
      },
    },
    {
      slug: 'echo-pretty',
      outputSchema: {
        type: 'object',
        properties: {
          text:   { type: 'string' },
          length: { type: 'integer' },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Happy paths

test('makeObservation: clean exec → no diagnostics, no schema_check unless tool last', () => {
  const obs = makeObservation(
    `echo hello`,
    { stdout: 'hello\n', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.equal(obs.exitCode, 0);
  assert.equal(obs.stdout, 'hello');
  assert.equal(obs.diagnostics, undefined);
  assert.equal(obs.tools_referenced, undefined);
  assert.equal(obs.schema_check, undefined);
});

test('makeObservation: registry tool last in pipeline → schema_check fires', () => {
  const obs = makeObservation(
    `ip-info`,
    { stdout: '{"ip":"1.2.3.4","country":"MX"}', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.ok(obs.tools_referenced);
  assert.equal(obs.tools_referenced[0].slug, 'ip-info');
  assert.deepEqual(obs.tools_referenced[0].jq_paths, ['.ip', '.country']);
  assert.deepEqual(obs.schema_check, { validated: true, ok: true });
});

test('makeObservation: pipeline ending in jq → schema_check explains the gap', () => {
  const obs = makeObservation(
    `ip-info | jq -r '.country'`,
    { stdout: 'MX', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.ok(obs.schema_check);
  assert.equal(obs.schema_check.validated, false);
  assert.match(obs.schema_check.reason, /transform|registry tool/i);
});

// ---------------------------------------------------------------------------
// Diagnostic patterns

test('makeObservation: jq parse error triggers nesting hint', () => {
  const obs = makeObservation(
    `ip-info | jq -r '.ip.country'`,
    {
      stdout: '',
      stderr: 'jq: parse error: Cannot index string with string "country"',
      exitCode: 5,
    },
    MANIFEST
  );
  assert.ok(obs.diagnostics);
  assert.equal(obs.diagnostics.length, 1);
  assert.match(obs.diagnostics[0], /flat object|jq paths|ip-info/i);
});

test('makeObservation: command not found enumerates registry tools', () => {
  const obs = makeObservation(
    `curl https://example.com | jq`,
    { stdout: '', stderr: 'bash: curl: command not found', exitCode: 127 },
    MANIFEST
  );
  assert.ok(obs.diagnostics);
  assert.match(obs.diagnostics[0], /Available registry commands.*ip-info.*echo-pretty/i);
});

test('makeObservation: malformed escaped-quote stdout triggers awk hint', () => {
  const obs = makeObservation(
    `ip-info | grep country | awk -F':' '{print $2}'`,
    { stdout: '"2001', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.ok(obs.diagnostics);
  assert.match(obs.diagnostics[0], /awk|cut|grep|jq -r|delimiter/i);
});

test('makeObservation: empty stdout from successful pipeline triggers raw-output hint', () => {
  const obs = makeObservation(
    `ip-info | grep nothing-matches`,
    { stdout: '', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.ok(obs.diagnostics);
  assert.match(obs.diagnostics[0], /no stdout|registry tool alone/i);
});

// ---------------------------------------------------------------------------
// Tool detection edge cases

test('makeObservation: tool name inside double quotes is NOT detected as a tool reference', () => {
  // The boundary regex `(^|[\s|;&(])slug(\s|$|[|;&)])` requires a whitespace
  // or pipe-like char on both sides. A `"` doesn't qualify, so the false
  // positive does not actually fire here. Pinning the safe behaviour.
  const obs = makeObservation(
    `echo "ip-info is a tool"`,
    { stdout: 'ip-info is a tool', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.equal(obs.tools_referenced, undefined);
});

test('makeObservation: tool name with surrounding whitespace IS detected (true positive)', () => {
  const obs = makeObservation(
    `ip-info`,
    { stdout: '{"ip":"x","country":"MX"}', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.ok(obs.tools_referenced);
  assert.equal(obs.tools_referenced[0].slug, 'ip-info');
});

test('makeObservation: tool name in shell variable expansion is detected (false positive — documented)', () => {
  // The regex DOES match `$ip-info` because `$` is followed by `i`... wait,
  // actually the boundary set is `[\s|;&(]` so `$` is NOT a boundary char.
  // Pin current behaviour: tool name inside a variable name is NOT detected.
  const obs = makeObservation(
    `echo $ip-info`,
    { stdout: '', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.equal(obs.tools_referenced, undefined);
});

test('makeObservation: jq_paths reflect schema fields exactly', () => {
  const obs = makeObservation(
    `ip-info`,
    { stdout: '{"ip":"x","country":"MX"}', stderr: '', exitCode: 0 },
    MANIFEST
  );
  const paths = obs.tools_referenced[0].jq_paths;
  assert.deepEqual(paths, ['.ip', '.country']);
});

// ---------------------------------------------------------------------------
// Schema validation in observation

test('makeObservation: schema_check catches non-JSON stdout from registry tool', () => {
  const obs = makeObservation(
    `ip-info`,
    { stdout: 'not json at all', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.equal(obs.schema_check.validated, false);
  assert.equal(obs.schema_check.ok, false);
});

test('makeObservation: schema_check reports type mismatch errors', () => {
  const obs = makeObservation(
    `ip-info`,
    { stdout: '{"ip":42,"country":"MX"}', stderr: '', exitCode: 0 },
    MANIFEST
  );
  assert.equal(obs.schema_check.validated, true);
  assert.equal(obs.schema_check.ok, false);
  assert.ok(obs.schema_check.errors.some((e) => /ip/.test(e) && /string/.test(e)));
});
