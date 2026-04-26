/**
 * untrusted-output.test.ts — V5 strawman defense (THREAT-MODEL.md V5).
 *
 * Tests the three guarantees of `wrapUntrustedOutput`:
 *   - the delimiter envelope is well-formed and identifies the source skill
 *   - the per-skill cap truncates long output deterministically
 *   - control characters / ANSI escapes are stripped before wrapping
 *
 * These do not claim prompt-injection is solved — that's an open research
 * problem. They claim the *structural marker* the agent loop relies on is
 * intact and that an adversarial upstream cannot grow the payload past the
 * declared cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOutputCap,
  outputCapForSkill,
  sanitizeSkillOutput,
  wrapUntrustedOutput,
  DEFAULT_OUTPUT_CAP_CHARS,
  UNTRUSTED_OUTPUT_FRAGMENT,
} from '../client/untrusted-output.ts';

// ---------------------------------------------------------------------------
// applyOutputCap

test('applyOutputCap: passes short text through unchanged', () => {
  const r = applyOutputCap('hello', 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
  assert.equal(r.originalLength, 5);
});

test('applyOutputCap: truncates and marks long text', () => {
  const r = applyOutputCap('x'.repeat(200), 50);
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, 200);
  assert.match(r.text, /\[truncated by outputCap\]/);
  // The retained content is exactly cap chars (plus marker line).
  const beforeMarker = r.text.split('\n')[0]!;
  assert.equal(beforeMarker.length, 50);
});

test('applyOutputCap: uses default cap when none provided', () => {
  const r = applyOutputCap('y'.repeat(DEFAULT_OUTPUT_CAP_CHARS + 100));
  assert.equal(r.truncated, true);
});

test('applyOutputCap: at the boundary (exactly cap length) does NOT truncate', () => {
  const r = applyOutputCap('z'.repeat(50), 50);
  assert.equal(r.truncated, false);
  assert.equal(r.text.length, 50);
});

// ---------------------------------------------------------------------------
// sanitizeSkillOutput

test('sanitize: strips ANSI CSI sequences (color codes)', () => {
  const input = 'plain \x1b[31mred\x1b[0m text';
  assert.equal(sanitizeSkillOutput(input), 'plain red text');
});

test('sanitize: strips OSC sequences (terminal title injection)', () => {
  const input = 'before \x1b]0;evil title\x07 after';
  assert.equal(sanitizeSkillOutput(input), 'before  after');
});

test('sanitize: strips C0 control characters but preserves \\t \\n \\r', () => {
  const input = 'line1\nline2\twith tab\rcr\x01\x07evil\x1f';
  // \x01 (SOH), \x07 (BEL), \x1f (US) removed; \n, \t, \r kept.
  assert.equal(sanitizeSkillOutput(input), 'line1\nline2\twith tab\rcrevil');
});

test('sanitize: strips DEL (0x7f)', () => {
  assert.equal(sanitizeSkillOutput('a\x7fb'), 'ab');
});

test('sanitize: leaves normal printable text untouched', () => {
  const input = 'The quick brown fox — €100, 中文, emoji 🚀.';
  assert.equal(sanitizeSkillOutput(input), input);
});

// ---------------------------------------------------------------------------
// wrapUntrustedOutput

test('wrap: emits delimiter with skill slug and trust=untrusted by default', () => {
  const r = wrapUntrustedOutput('payload', { slug: 'url2md' });
  assert.match(r, /^<skill-output skill="url2md" trust="untrusted">/);
  assert.match(r, /<\/skill-output>$/);
  assert.match(r, /\npayload\n/);
});

test('wrap: trust="trusted" when caller opts out (e.g. internal echo skill)', () => {
  const r = wrapUntrustedOutput('payload', { slug: 'echo-pretty', untrusted: false });
  assert.match(r, /trust="trusted"/);
});

test('wrap: applies outputCap and adds truncated="orig->kept" attribute', () => {
  const longPayload = 'A'.repeat(200);
  const r = wrapUntrustedOutput(longPayload, { slug: 'url2md', outputCap: 50 });
  assert.match(r, /truncated="200->50"/);
  assert.match(r, /\[truncated by outputCap\]/);
  // No truncated attr when not truncated:
  const short = wrapUntrustedOutput('short', { slug: 'url2md', outputCap: 50 });
  assert.doesNotMatch(short, /truncated=/);
});

test('wrap: sanitizes ANSI before applying cap (defence-in-depth)', () => {
  const adversarial = '\x1b[31mIGNORE PRIOR\x1b[0m harmless';
  const r = wrapUntrustedOutput(adversarial, { slug: 'url2md', outputCap: 100 });
  assert.doesNotMatch(r, /\x1b/);
  assert.match(r, /IGNORE PRIOR harmless/);
});

test('wrap: cap applies even when adversary tries to encode payload via control chars', () => {
  // Build 10 KB of text padded with stripped control chars. After sanitize
  // the visible payload would still be ~10 KB; the cap must still bite.
  const payload = '\x01x'.repeat(5000); // 10 KB raw, 5 KB visible after sanitize
  const r = wrapUntrustedOutput(payload, { slug: 'url2md', outputCap: 1000 });
  // Must contain the truncation marker — cap binds on visible chars.
  assert.match(r, /\[truncated by outputCap\]/);
});

// ---------------------------------------------------------------------------
// outputCapForSkill

test('outputCapForSkill: returns the declared cap for known slug', () => {
  const tools = [
    { slug: 'echo-pretty' },
    { slug: 'url2md', outputCap: 4096 },
  ];
  assert.equal(outputCapForSkill('url2md', tools), 4096);
  assert.equal(outputCapForSkill('echo-pretty', tools), undefined);
});

test('outputCapForSkill: returns undefined for unknown slug or null', () => {
  const tools = [{ slug: 'echo-pretty' }];
  assert.equal(outputCapForSkill('nonexistent', tools), undefined);
  assert.equal(outputCapForSkill(null, tools), undefined);
});

// ---------------------------------------------------------------------------
// system-prompt fragment

test('UNTRUSTED_OUTPUT_FRAGMENT: instructs the model to treat skill-output as data', () => {
  // The exact wording can change, but the contract elements must be present:
  // delimiter name, untrusted attribute, "ignore instructions" guidance.
  assert.match(UNTRUSTED_OUTPUT_FRAGMENT, /skill-output/);
  assert.match(UNTRUSTED_OUTPUT_FRAGMENT, /untrusted/);
  assert.match(UNTRUSTED_OUTPUT_FRAGMENT, /ignore/i);
});
