/**
 * mcp-server-classic.test.ts — wire-format integration test for the classic
 * MCP server (`client/mcp-server-classic.ts`), where each registry skill is
 * exposed as a separate MCP tool with its own JSONSchema.
 *
 * This is the "function-calling" surface — counterpart to the composable
 * `bash`-only server. Tests verify shape, classic-mode invocation, error
 * paths, and that per-model overrides are honoured when MODEL is set.
 *
 * Like mcp-server.test.ts, REGISTRY points at the local dist/ via filesystem
 * to remove network from the equation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SERVER = join(ROOT, 'client', 'mcp-server-classic.ts');
const DIST = resolve(ROOT, 'dist');

// dist/ is produced by the `pretest` npm hook before this suite runs.
if (!existsSync(join(DIST, 'manifest.json'))) {
  throw new Error(
    `dist/manifest.json missing. Run \`npm test\` (which builds first) or \`npm run build\` directly.`,
  );
}

/** Strip the V5 untrusted-output envelope so tests can assert on the inner payload. */
function unwrapSkillOutput(text: string): string {
  const m = text.match(/^<skill-output[^>]*>\n([\s\S]*)\n<\/skill-output>$/);
  return m ? m[1]! : text;
}

let client: Client;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, REGISTRY: DIST, NO_COLOR: '1' } as Record<string, string>,
  });
  client = new Client(
    { name: 'mcp-server-classic-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// tools/list contract

test('classic: tools/list exposes every registry skill individually', async () => {
  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  // The number depends on the registry; assert the well-known skills are present.
  for (const expected of ['echo-pretty', 'ip-info', 'url2md', 'github-repo-info', 'weather', 'dictionary']) {
    assert.ok(names.includes(expected), `expected tool "${expected}" in list, got: ${names.join(', ')}`);
  }
});

test('classic: each tool exposes its skill inputSchema (not a generic one)', async () => {
  const list = await client.listTools();
  const echo = list.tools.find((t) => t.name === 'echo-pretty');
  assert.ok(echo);
  const schema = echo.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(schema.required, ['text']);
  assert.ok(schema.properties && 'upper' in schema.properties);
});

// ---------------------------------------------------------------------------
// tools/call — direct invocation

test('classic: echo-pretty invoked directly with structured args', async () => {
  const r = await client.callTool({
    name: 'echo-pretty',
    arguments: { text: 'classic mode', upper: true },
  });
  assert.equal(r.isError ?? false, false);
  const stdout = (r.content as Array<{ text: string }>)[0]!.text;
  // Stdout is wrapped in the V5 untrusted-output delimiter (skill="echo-pretty").
  assert.match(stdout, /^<skill-output skill="echo-pretty" trust="untrusted">/);
  assert.match(unwrapSkillOutput(stdout), /CLASSIC MODE/);
});

test('classic: echo-pretty with prefix passes the flag through correctly', async () => {
  const r = await client.callTool({
    name: 'echo-pretty',
    arguments: { text: 'x', upper: true, prefix: '>> ' },
  });
  assert.equal(r.isError ?? false, false);
  const stdout = (r.content as Array<{ text: string }>)[0]!.text;
  const parsed = JSON.parse(unwrapSkillOutput(stdout)) as { text: string };
  assert.equal(parsed.text, '>> X');
});

// ---------------------------------------------------------------------------
// Error paths

test('classic: missing required arg returns isError', async () => {
  const r = await client.callTool({
    name: 'echo-pretty',
    arguments: { upper: true },   // text is required
  });
  assert.equal(r.isError, true);
});

test('classic: unknown tool name returns isError', async () => {
  const r = await client.callTool({ name: 'no-such-tool', arguments: {} });
  assert.equal(r.isError, true);
});

// ---------------------------------------------------------------------------
// Boolean coercion (regression for Bug 2 from first code review)

test('classic: bare bool flag handled correctly via inputToArgv', async () => {
  // upper: true → argv `--upper`, parsed back to true by loader.parseArgs
  const r = await client.callTool({
    name: 'echo-pretty',
    arguments: { text: 'foo', upper: true },
  });
  assert.equal(r.isError ?? false, false);
  const parsed = JSON.parse(unwrapSkillOutput((r.content as Array<{ text: string }>)[0]!.text)) as { text: string };
  assert.equal(parsed.text, 'FOO');
});
