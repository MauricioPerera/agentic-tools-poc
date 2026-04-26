/**
 * mcp-server.test.ts — wire-format integration test for the composable MCP
 * server (`client/mcp-server.ts`).
 *
 * Spawns the actual server as a subprocess and drives it with the official
 * MCP Client SDK over stdio — the same path Claude Code (or any MCP host)
 * uses. A green run means the server's tool definitions, response shape,
 * and error handling all conform to the protocol contract.
 *
 * REGISTRY is set to the local dist/ via file:// so the test doesn't depend
 * on jsDelivr or network access. Build dist/ first (`npm run build`).
 *
 * Tool calls focus on echo-pretty (no network) for determinism. Network-
 * dependent skills are smoke-tested separately via `npm run smoke`.
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
const SERVER = join(ROOT, 'client', 'mcp-server.ts');
const DIST = resolve(ROOT, 'dist');

// dist/ is produced by the `pretest` npm hook before this suite runs.
// On any path that bypasses that hook (running test files directly with
// `node --test`), we surface a clear error instead of letting the loader
// throw a confusing "manifest fetch failed".
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
    env: {
      ...process.env,
      REGISTRY: DIST,
      // Avoid colored MCP server logs polluting the test output
      NO_COLOR: '1',
    } as Record<string, string>,
  });
  client = new Client(
    { name: 'mcp-server-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// tools/list contract — composable mode is ONE tool, period

test('mcp-server: tools/list returns exactly ONE tool — bash', async () => {
  // The composable claim depends on this. tool_schema and list_skills are
  // bash built-ins, NOT separate MCP tools — that's what keeps the
  // function-calling surface at O(1) regardless of registry size.
  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['bash']);
});

test('mcp-server: bash tool description does NOT enumerate the registry', async () => {
  // The composable promise is that the model discovers skills on-demand
  // via `bash list_skills`, not by being handed the catalog upfront. If
  // the bash description starts listing slugs again, the prompt grows
  // O(N) and the architectural distinction collapses. This test guards
  // against that regression.
  const list = await client.listTools();
  const bash = list.tools.find((t) => t.name === 'bash');
  assert.ok(bash, 'bash tool must be present');
  assert.ok(bash.description, 'bash tool needs a description');
  // The description MUST mention the discovery commands
  assert.match(bash.description, /list_skills/);
  assert.match(bash.description, /tool_schema/);
  // The description MUST NOT enumerate the actual skills — discovery
  // is the model's responsibility.
  assert.doesNotMatch(bash.description, /echo-pretty/);
  assert.doesNotMatch(bash.description, /ip-info/);
  assert.doesNotMatch(bash.description, /url2md/);
});

test('mcp-server: bash inputSchema requires `command`', async () => {
  const list = await client.listTools();
  const bash = list.tools.find((t) => t.name === 'bash')!;
  const schema = bash.inputSchema as { required?: string[] };
  assert.deepEqual(schema.required, ['command']);
});

// ---------------------------------------------------------------------------
// tools/call — bash success path

test('mcp-server: bash runs echo-pretty with text + upper, returns transformed JSON', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'echo-pretty --text "hello mcp" --upper' },
  });
  assert.equal(r.isError ?? false, false);
  const content = r.content as Array<{ type: string; text: string }>;
  assert.ok(content.length > 0, 'expected at least one content block');
  const stdout = content[0]!.text;
  // Pipeline ends in echo-pretty (a registry skill), so V5 wraps it.
  assert.match(stdout, /^<skill-output skill="echo-pretty" trust="untrusted">/);
  const inner = unwrapSkillOutput(stdout);
  assert.match(inner, /HELLO MCP/);
  const parsed = JSON.parse(inner) as { text: string; length: number };
  assert.equal(parsed.text, 'HELLO MCP');
  assert.equal(parsed.length, 9);
});

test('mcp-server: bash pure-shell pipeline (no registry tool last) is NOT wrapped', async () => {
  // V5 contract: only register-skill output is wrapped. A pure shell pipeline
  // produces data shaped by the agent itself — wrapping it would lie about
  // provenance and bloat token usage.
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: `echo "hello" | tr '[:lower:]' '[:upper:]'` },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  assert.doesNotMatch(text, /<skill-output/);
  assert.match(text, /HELLO/);
});

test('mcp-server: bash composes registry tool with unix pipeline', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: {
      command: `echo-pretty --text "abc" --upper | jq -r '.text' | wc -c | tr -d ' '`,
    },
  });
  assert.equal(r.isError ?? false, false);
  const content = r.content as Array<{ type: string; text: string }>;
  // "ABC\n" through wc -c is 4
  assert.match(content[0]!.text.trim(), /^4$/);
});

// ---------------------------------------------------------------------------
// tools/call — error paths (the safety net)

test('mcp-server: bash with missing required input returns isError', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'echo-pretty --upper' },   // text is required
  });
  // The bash tool exits 1 internally when echo-pretty rejects the input;
  // the MCP wrapper surfaces that as isError.
  assert.equal(r.isError, true, 'expected isError when bash command exits non-zero');
});

test('mcp-server: bash with empty command returns isError', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: '' },
  });
  assert.equal(r.isError, true);
});

test('mcp-server: unknown tool name returns isError, not throw', async () => {
  const r = await client.callTool({ name: 'nonexistent-tool', arguments: {} });
  assert.equal(r.isError, true);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /unknown tool/i);
});

// ---------------------------------------------------------------------------
// Discovery built-ins (list_skills + tool_schema) — invoked via bash, not as
// separate MCP tools. This is what makes the architectural promise actually
// hold: the model's function-calling surface is just `bash`, and discovery
// is opt-in (the model only loads schemas it asks for).

test('mcp-server: bash list_skills enumerates the registry one-line-per-skill', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'list_skills' },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  // Every shipped skill should appear on its own line
  for (const slug of ['echo-pretty', 'ip-info', 'url2md', 'github-repo-info', 'weather', 'dictionary']) {
    assert.match(text, new RegExp(`^${slug}:`, 'm'), `expected slug "${slug}" in list_skills output`);
  }
});

test('mcp-server: bash list_skills --capability network filters correctly', async () => {
  // Network-capable skills only — echo-pretty (transform) should be excluded.
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'list_skills --capability network' },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /^ip-info:/m);
  assert.match(text, /^url2md:/m);
  assert.doesNotMatch(text, /^echo-pretty:/m);
});

test('mcp-server: bash list_skills --search returns a narrowed subset', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'list_skills --search weather' },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /^weather:/m);
  // Other skills should not appear in a 'weather' search
  assert.doesNotMatch(text, /^echo-pretty:/m);
});

test('mcp-server: bash list_skills --json returns full metadata array', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'list_skills --json' },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  const arr = JSON.parse(text) as Array<{ slug: string; capabilities: string[] }>;
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length >= 6);
  const echo = arr.find((s) => s.slug === 'echo-pretty');
  assert.ok(echo);
  assert.ok(Array.isArray(echo.capabilities));
});

test('mcp-server: bash tool_schema --slug echo-pretty returns full schema', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'tool_schema --slug echo-pretty' },
  });
  assert.equal(r.isError ?? false, false);
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  const view = JSON.parse(text) as {
    slug: string;
    inputSchema: { required?: string[] };
    outputSchema: object;
  };
  assert.equal(view.slug, 'echo-pretty');
  assert.deepEqual(view.inputSchema.required, ['text']);
  assert.ok(view.outputSchema, 'outputSchema must be present');
});

test('mcp-server: bash tool_schema --slug returns isError for unknown slug', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'tool_schema --slug no-such-skill' },
  });
  assert.equal(r.isError, true);
  const content = r.content as Array<{ text: string }>;
  // The error should hint at the discovery mechanism so the model knows
  // how to recover.
  const all = content.map((c) => c.text).join(' ');
  assert.match(all, /list_skills/);
});

test('mcp-server: bash tool_schema with no --slug surfaces the discovery hint', async () => {
  const r = await client.callTool({
    name: 'bash',
    arguments: { command: 'tool_schema' },
  });
  assert.equal(r.isError, true);
  const text = ((r.content as Array<{ text: string }>).map((c) => c.text)).join(' ');
  assert.match(text, /requires --slug|list_skills/);
});
