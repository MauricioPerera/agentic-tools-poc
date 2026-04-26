#!/usr/bin/env node
/**
 * mcp-server-classic.mjs — the "traditional" MCP server: one MCP tool per
 * registry tool, each with its own JSONSchema. Counterpart to the composable
 * mcp-server.mjs (single `bash` tool).
 *
 * Same registry, same execution path (under the hood we still shell out to
 * just-bash so behaviour is identical), but the MCP host sees N tool schemas
 * instead of 1. This is what conventional function-calling agents see.
 *
 * Use both servers side-by-side in Claude Code or any MCP host to compare
 * round count, token usage, and convergence behaviour for the same tasks.
 *
 *   {
 *     "mcpServers": {
 *       "agentic-tools-classic": {
 *         "command": "node",
 *         "args": ["<absolute path>/client/mcp-server-classic.mjs"]
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
import { applyOverridesToManifest } from './skill-tuning.mjs';

const REGISTRY = process.env.REGISTRY;
const MODEL    = process.env.MODEL ?? '';

async function main() {
  const { manifest: rawManifest, commands } = await loadRegistry({ registry: REGISTRY });
  // Apply per-model skill overrides if MODEL env identifies a target model.
  // E.g. MODEL=hermes spawns a Hermes-tuned variant of the same registry.
  const manifest = applyOverridesToManifest(rawManifest, MODEL);
  const bash = new Bash({ customCommands: commands });

  const server = new Server(
    { name: 'agentic-tools-classic', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((t) => ({
      name: t.slug,
      description: t.summary,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const tool = manifest.tools.find((t) => t.slug === name);
    if (!tool) return errorResult(`unknown tool: ${name}`);

    // Build the equivalent bash command: tool --k v --k2 v2 ...
    // Reuses the exact same execution path as the composable server, so
    // any difference in agent behaviour is purely about tool surface, not
    // about runtime semantics.
    const cmd = [tool.slug, ...argvFromInput(args)].join(' ');
    try {
      const result = await bash.exec(cmd);
      return {
        content: [
          { type: 'text', text: (result.stdout || '').trim() || '(no stdout)' },
          ...(result.stderr ? [{ type: 'text', text: `stderr:\n${result.stderr.trim()}` }] : []),
        ],
        isError: result.exitCode !== 0,
      };
    } catch (e) {
      return errorResult(`crashed: ${e.message}`);
    }
  });

  await server.connect(new StdioServerTransport());
  const tunedTools = manifest.tools.filter((t) => rawManifest.tools.find((r) => r.slug === t.slug && JSON.stringify(r) !== JSON.stringify(t))).map((t) => t.slug);
  process.stderr.write(
    `[agentic-tools-classic mcp] ready — ${manifest.tools.length} skill(s) exposed individually` +
    (MODEL ? ` (MODEL=${MODEL}, tuned: ${tunedTools.length ? tunedTools.join(',') : 'none'})` : '') + '\n'
  );
}

function argvFromInput(args) {
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === false || v == null) continue;
    if (v === true) out.push(`--${k}`);
    else out.push(`--${k}`, JSON.stringify(String(v)));
  }
  return out;
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

main().catch((e) => {
  process.stderr.write(`[agentic-tools-classic mcp] fatal: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
