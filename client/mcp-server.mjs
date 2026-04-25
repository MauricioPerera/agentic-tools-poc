#!/usr/bin/env node
/**
 * mcp-server.mjs — stdio MCP server that exposes the registry as a single
 * `bash` tool plus a `tool_schema` introspection tool.
 *
 * The whole point: instead of giving the LLM N separate function-call tool
 * schemas (one per registry tool), give it ONE bash tool. The agent then
 * composes the registry tools through unix pipes (jq, grep, xargs, …) and
 * only the final pipeline output crosses back to the model. This is the
 * token-efficiency thesis the POC validates.
 *
 * Drop-in for Claude Code (~/.claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "agentic-tools": {
 *         "command": "node",
 *         "args": ["<absolute path>/client/mcp-server.mjs"]
 *       }
 *     }
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.mjs';

const REGISTRY = process.env.REGISTRY; // optional override; loader has a sensible default

async function main() {
  // 1. Load registry once at server startup. Cold start is amortized
  //    across the entire MCP session so per-call latency is just bash + handler.
  const { manifest, commands } = await loadRegistry({ registry: REGISTRY });
  const bash = new Bash({ customCommands: commands });

  const toolList = manifest.tools
    .map((t) => `  • ${t.slug} — ${t.summary}${t.networkPolicy?.allow?.length ? ' [net: ' + t.networkPolicy.allow.join(',') + ']' : ''}`)
    .join('\n');

  const server = new Server(
    { name: 'agentic-tools', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'bash',
        description:
          `Execute a bash command in a sandboxed environment with the following ` +
          `registry tools available as commands (in addition to standard unix ` +
          `commands like jq, grep, sed, awk, head, xargs, etc):\n\n${toolList}\n\n` +
          `Compose tools using pipes for token efficiency: only the final ` +
          `pipeline output is returned. Use \`tool_schema --slug <name>\` to ` +
          `introspect any registry tool's input/output JSONSchema.\n\n` +
          `Tool flags follow --key value or --key=value form. Boolean flags can ` +
          `be passed bare (--upper) or as --upper=true.`,
        inputSchema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string', description: 'The bash command line to execute.' },
          },
        },
      },
      {
        name: 'tool_schema',
        description:
          `Returns the JSONSchema for a registry tool's input and output, plus ` +
          `its capabilities, sideEffects, and networkPolicy. Call this before ` +
          `using a tool you have not used before.`,
        inputSchema: {
          type: 'object',
          required: ['slug'],
          properties: {
            slug: { type: 'string', description: 'The tool slug (e.g. "echo-pretty").' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    if (name === 'bash') {
      const cmd = String(args.command ?? '');
      if (!cmd) return errorResult('command is required');
      try {
        const result = await bash.exec(cmd);
        return {
          content: [
            { type: 'text', text: result.stdout || '(no stdout)' },
            ...(result.stderr ? [{ type: 'text', text: `stderr:\n${result.stderr}` }] : []),
            ...(result.exitCode !== 0 ? [{ type: 'text', text: `exitCode: ${result.exitCode}` }] : []),
          ],
          isError: result.exitCode !== 0,
        };
      } catch (e) {
        return errorResult(`bash crashed: ${e.message}`);
      }
    }

    if (name === 'tool_schema') {
      const slug = String(args.slug ?? '');
      const tool = manifest.tools.find((t) => t.slug === slug);
      if (!tool) return errorResult(`unknown tool: ${slug}`);
      const view = {
        slug:          tool.slug,
        name:          tool.name,
        summary:       tool.summary,
        version:       tool.version,
        capabilities:  tool.capabilities,
        sideEffects:   tool.sideEffects,
        inputSchema:   tool.inputSchema,
        outputSchema:  tool.outputSchema,
        networkPolicy: tool.networkPolicy,
      };
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    }

    return errorResult(`unknown tool: ${name}`);
  });

  await server.connect(new StdioServerTransport());

  // Note: stdout is reserved for the JSON-RPC protocol. Diagnostics → stderr.
  process.stderr.write(
    `[agentic-tools mcp] ready — ${manifest.tools.length} registry tool(s) loaded\n`
  );
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

main().catch((e) => {
  process.stderr.write(`[agentic-tools mcp] fatal: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
