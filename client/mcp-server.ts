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

  const server = new Server(
    { name: 'agentic-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Composable mode: the model sees ONE tool (`bash`). The catalog is NOT
  // enumerated in the system prompt — the model discovers what skills exist
  // by running `bash list_skills` (optionally filtered by --capability or
  // --search), and reads any specific skill's contract via
  // `bash tool_schema --slug <name>`. This is what makes the architecture
  // O(catalog-subset) instead of O(catalog-total) on the prompt: the model
  // only carries forward the schemas it actually needs.
  //
  // Without this, "discovery" is theatre — the model already has the full
  // list in the system prompt and `tool_schema` just confirms what it
  // already knows. The whole point is that `list_skills --capability X`
  // lets the model load a SUBSET, not the full registry.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'bash',
        description:
          `Execute a bash command in a sandboxed environment.\n\n` +
          `Discover available skills by running:\n` +
          `  bash list_skills                          → all skills (one slug + summary per line)\n` +
          `  bash list_skills --capability <tag>       → filter by capability tag (e.g. network, lookup, transform)\n` +
          `  bash list_skills --search <query>         → fuzzy search across slug, summary, capabilities\n` +
          `  bash list_skills --json                   → full metadata as JSON\n\n` +
          `Inspect a specific skill's contract before using it:\n` +
          `  bash tool_schema --slug <name>            → returns the full JSONSchema for input/output\n\n` +
          `Standard unix tools also available: jq, grep, sed, awk, xargs, head, wc, tr.\n\n` +
          `Compose tools with pipes for token efficiency — only the final pipeline output ` +
          `crosses back to you. Tool flags follow --key value or --key=value form; boolean ` +
          `flags can be passed bare (--upper) or as --upper=true.\n\n` +
          UNTRUSTED_OUTPUT_FRAGMENT,
        inputSchema: {
          type: 'object',
          required: ['command'],
          properties: {
            command: { type: 'string', description: 'The bash command line to execute.' },
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

    // tool_schema and list_skills are no longer separate MCP tools — they're
    // bash built-ins. The model invokes them as `bash list_skills ...` /
    // `bash tool_schema --slug ...` which keeps the function-calling surface
    // at exactly ONE tool (`bash`). See loader.ts for the implementations.
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
