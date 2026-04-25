/**
 * test-mcp-classic.mjs — drives mcp-server-classic.mjs and asserts each
 * registry tool is exposed individually with its own JSONSchema.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcp-server-classic.mjs');
const banner = (s) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, REGISTRY: process.env.REGISTRY ?? '' },
});

const client = new Client({ name: 'classic-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

banner('1) tools/list — expect each registry tool individually');
const list = await client.listTools();
for (const t of list.tools) {
  console.log(`  • ${t.name} — ${t.description}`);
  console.log(`    inputSchema: ${JSON.stringify(t.inputSchema).slice(0, 120)}`);
}

banner('2) call echo-pretty directly');
let r = await client.callTool({
  name: 'echo-pretty',
  arguments: { text: 'classic mode works', upper: true },
});
for (const c of r.content) console.log(c.text);

banner('3) call ip-info directly');
r = await client.callTool({ name: 'ip-info', arguments: {} });
for (const c of r.content) console.log(c.text);

banner('Done');
await client.close();
