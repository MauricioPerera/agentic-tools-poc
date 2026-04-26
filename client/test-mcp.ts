/**
 * test-mcp.ts — drives mcp-server.ts over stdio using the official Client
 * from the same SDK. This is exactly what Claude Code (or any MCP host) does
 * under the hood, so a green run here means the server is wire-compatible.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcp-server.ts');

const banner = (s: string) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, REGISTRY: process.env.REGISTRY ?? '' } as Record<string, string>,
});

const client = new Client({ name: 'agentic-tools-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

banner('1) tools/list');
const list = await client.listTools();
for (const t of list.tools) {
  console.log(`  • ${t.name}`);
  console.log(`    ${(t.description ?? '').split('\n')[0]}`);
}

banner('2) tool_schema for ip-info');
let r = await client.callTool({ name: 'tool_schema', arguments: { slug: 'ip-info' } });
for (const c of (r.content as Array<{ type: string; text: string }>)) console.log(c.text);

banner('3) bash: single registry tool');
r = await client.callTool({ name: 'bash', arguments: { command: 'echo-pretty --text "hello mcp" --upper' } });
for (const c of (r.content as Array<{ type: string; text: string }>)) console.log(c.text);

banner('4) bash: composable pipeline (the killer demo)');
r = await client.callTool({
  name: 'bash',
  arguments: {
    command: `ip-info | jq -r '.country' | xargs -I {} echo-pretty --text "{}" --upper --prefix "country=> "`,
  },
});
for (const c of (r.content as Array<{ type: string; text: string }>)) console.log(c.text);

banner('5) bash: error path (bad command)');
r = await client.callTool({ name: 'bash', arguments: { command: 'echo-pretty --text "missing required is fine here"' } });
for (const c of (r.content as Array<{ type: string; text: string }>)) console.log(c.text);
console.log('isError:', r.isError ?? false);

banner('6) bash: built-in unix tools work alongside registry tools');
r = await client.callTool({
  name: 'bash',
  arguments: {
    command: `echo-pretty --text "abc" --upper | jq -r '.text' | wc -c | tr -d ' '`,
  },
});
for (const c of (r.content as Array<{ type: string; text: string }>)) console.log(c.text);

banner('Done');
await client.close();
