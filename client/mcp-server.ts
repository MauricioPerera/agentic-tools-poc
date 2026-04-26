#!/usr/bin/env node
/**
 * mcp-server.ts — stdio MCP server that exposes the registry as a single
 * `bash` tool plus a `tool_schema` introspection tool.
 *
 * The whole point: instead of giving the LLM N separate function-call tool
 * schemas (one per registry tool), give it ONE bash tool. The agent then
 * composes the registry tools through unix pipes (jq, grep, xargs, …) and
 * only the final pipeline output crosses back to the model.
 *
 * Drop-in for Claude Code (~/.claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "agentic-tools": {
 *         "command": "node",
 *         "args": ["<absolute path>/client/mcp-server.ts"]
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
import { loadRegistry } from './loader.ts';
import { lastPipelineStage } from './smart-bash.ts';
import {
  wrapUntrustedOutput,
  outputCapForSkill,
  UNTRUSTED_OUTPUT_FRAGMENT,
} from './untrusted-output.ts';

const REGISTRY = process.env.REGISTRY;

interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const { manifest, commands } = await loadRegistry({ registry: REGISTRY });
  const bash = new Bash({ customCommands: commands as never });

  const toolList = manifest.tools
    .map((t) => `  • ${t.slug} — ${t.summary}${t.networkPolicy?.allow?.length ? ' [net: ' + t.networkPolicy.allow.join(',') + ']' : ''}`)
    .join('\n');

  const server = new Server(
    { name: 'agentic-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
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
          `be passed bare (--upper) or as --upper=true.\n\n` +
          UNTRUSTED_OUTPUT_FRAGMENT,
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
    const { name, arguments: args = {} } = req.params as CallToolParams;

    if (name === 'bash') {
      const cmd = String(args['command'] ?? '');
      if (!cmd) return errorResult('command is required');
      try {
        const result = await bash.exec(cmd);
        let stdout = result.stdout || '';

        // V5 strawman: when the pipeline ends in a registry skill, the
        // stdout is untrusted output. Wrap + cap before returning to the
        // host. Pure-shell pipelines (jq/grep/awk only) skip wrapping.
        const lastStage = lastPipelineStage(cmd);
        const lastSlug = manifest.tools.find(
          (t) => lastStage === t.slug || lastStage?.startsWith(t.slug + ' '),
        )?.slug ?? null;
        if (lastSlug && stdout) {
          stdout = wrapUntrustedOutput(stdout, {
            slug: lastSlug,
            outputCap: outputCapForSkill(lastSlug, manifest.tools),
          });
        }

        return {
          content: [
            { type: 'text', text: stdout || '(no stdout)' },
            ...(result.stderr ? [{ type: 'text' as const, text: `stderr:\n${result.stderr}` }] : []),
            ...(result.exitCode !== 0 ? [{ type: 'text' as const, text: `exitCode: ${result.exitCode}` }] : []),
          ],
          isError: result.exitCode !== 0,
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`bash crashed: ${msg}`);
      }
    }

    if (name === 'tool_schema') {
      const slug = String(args['slug'] ?? '');
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
    `[agentic-tools mcp] ready — ${manifest.tools.length} registry tool(s) loaded\n`,
  );
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

main().catch((e: unknown) => {
  const err = e as Error;
  process.stderr.write(`[agentic-tools mcp] fatal: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});
