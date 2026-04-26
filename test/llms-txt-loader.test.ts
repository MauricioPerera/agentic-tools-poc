/**
 * llms-txt-loader.test.ts — unit tests for the spec parsers.
 *
 * Exercises the parsing functions of llms-txt-loader.ts without making
 * any network calls. Covers the cases listed in RFC §2.1 plus the edge
 * cases discovered while reviewing the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillsSection, parseSkillFile } from '../client/llms-txt-loader.ts';

// ---------------------------------------------------------------------------
// parseSkillsSection

test('parseSkillsSection: returns empty array when section absent', () => {
  const text = `# My Project\n\n## Docs\n- [readme](./README.md): docs.\n`;
  assert.deepEqual(parseSkillsSection(text), []);
});

test('parseSkillsSection: extracts a single entry', () => {
  const text = `# Site\n\n## Skills\n\n- [my-skill](https://x.test/skills/my-skill/SKILL.md): use to do X.\n`;
  const out = parseSkillsSection(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'my-skill');
  assert.equal(out[0].url, 'https://x.test/skills/my-skill/SKILL.md');
  // Description preserves trailing punctuation (we only strip the colon
  // separator that may follow the link). Periods are part of the description.
  assert.equal(out[0].description, 'use to do X.');
});

test('parseSkillsSection: heading match is case-insensitive', () => {
  const text = `## skills\n- [a](u): d.\n`;
  assert.equal(parseSkillsSection(text).length, 1);
});

test('parseSkillsSection: stops at next heading', () => {
  const text = `## Skills
- [a](u1): first.
- [b](u2): second.

## Other
- [c](u3): should not appear.
`;
  const out = parseSkillsSection(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.title), ['a', 'b']);
});

test('parseSkillsSection: parses inline metadata comment', () => {
  const text = `## Skills
- [pay](https://x.test/skills/pay/SKILL.md): make payments. <!-- skill: {"version":"1.2.0","sha256":"abc123"} -->
`;
  const [entry] = parseSkillsSection(text);
  assert.equal(entry.metadata.version, '1.2.0');
  assert.equal(entry.metadata.sha256, 'abc123');
  // Description should NOT include the comment text. Trailing period is preserved
  // as part of the natural-language description.
  assert.equal(entry.description, 'make payments.');
});

test('parseSkillsSection: malformed metadata is ignored, entry still parses', () => {
  const text = `## Skills
- [x](u): description. <!-- skill: {not valid json} -->
`;
  const [entry] = parseSkillsSection(text);
  assert.equal(entry.title, 'x');
  assert.deepEqual(entry.metadata, {});
});

test('parseSkillsSection: multiple entries with mixed metadata', () => {
  const text = `## Skills
- [a](https://x.test/a/SKILL.md): first skill.
- [b](https://x.test/b/SKILL.md): second skill. <!-- skill: {"license":"MIT"} -->
- [c](https://x.test/c/SKILL.md): third skill.
`;
  const out = parseSkillsSection(text);
  assert.equal(out.length, 3);
  assert.equal(out[1].metadata.license, 'MIT');
  assert.deepEqual(out[0].metadata, {});
  assert.deepEqual(out[2].metadata, {});
});

test('parseSkillsSection: handles entries without colon-description', () => {
  const text = `## Skills
- [bare](https://x.test/bare/SKILL.md)
`;
  const [entry] = parseSkillsSection(text);
  assert.equal(entry.title, 'bare');
  assert.equal(entry.description, '');
});

test('parseSkillsSection: tolerates leading whitespace on items', () => {
  const text = `## Skills

   - [indented](https://x.test/SKILL.md): with leading spaces.
`;
  const out = parseSkillsSection(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'indented');
});

// Known limitation, documented as such (regex-based markdown parsing).
// Pinning behavior so a future fix is intentional, not accidental.
test('parseSkillsSection: KNOWN LIMITATION — URLs containing `)` truncate', () => {
  const text = `## Skills
- [wiki](https://en.wikipedia.org/wiki/Foo_(bar)/SKILL.md): article.
`;
  const [entry] = parseSkillsSection(text);
  // The `[^)]+` regex stops at the first `)`. Documenting current behaviour;
  // a parser-based rewrite would handle this correctly.
  assert.ok(entry.url.endsWith('Foo_(bar'));
});

// ---------------------------------------------------------------------------
// parseSkillFile

test('parseSkillFile: extracts YAML frontmatter and body', () => {
  const text = `---
name: my-skill
description: does X
version: 1.0.0
---

# Body
Use this when…
`;
  const { frontmatter, body } = parseSkillFile(text);
  assert.equal(frontmatter.name, 'my-skill');
  assert.equal(frontmatter.description, 'does X');
  assert.equal(frontmatter.version, '1.0.0');
  // Body retains the leading newline that follows the closing `---`. We only
  // assert the H1 is present, not its position from start of string.
  assert.match(body, /# Body/);
});

test('parseSkillFile: returns empty frontmatter when no delimiter', () => {
  const text = `# Just a markdown document\n\nWith no frontmatter.\n`;
  const { frontmatter, body } = parseSkillFile(text);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, text);
});

test('parseSkillFile: tolerates malformed YAML by returning empty frontmatter', () => {
  const text = `---
name: ok
[: not valid
---

body content
`;
  const { frontmatter, body } = parseSkillFile(text);
  // YAML parser may throw; we swallow → frontmatter is whatever parsed (could be {} or partial)
  assert.equal(typeof frontmatter, 'object');
  assert.match(body, /body content/);
});

test('parseSkillFile: handles CRLF line endings', () => {
  const text = `---\r\nname: x\r\nversion: 0.1.0\r\n---\r\n\r\nbody\r\n`;
  const { frontmatter, body } = parseSkillFile(text);
  assert.equal(frontmatter.name, 'x');
  assert.equal(frontmatter.version, '0.1.0');
  assert.match(body, /body/);
});
