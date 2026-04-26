#!/usr/bin/env node
/**
 * mcp-server-classic.ts — the "traditional" MCP server: one MCP tool per
 * registry tool, each with its own JSONSchema. Counterpart to the composable
 * mcp-server.ts (single `bash` tool).
 *
 * Same registry, same execution path (under the hood we still shell out to
 * just-bash so behaviour is identical), but the MCP host sees N tool schemas
 * instead of 1. This is what conventional function-calling agents see.
 *
 *   {
 *     "mcpServers": {
 *       "agentic-tools-classic": {
 *         "command": "node",
 *         "args": ["<absolute path>/client/mcp-server-classic.ts"]
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
import { applyOverridesToManifest } from './skill-tuning.ts';
import { inputToArgv, argvToShellCommand } from './arg-parser.ts';
import { wrapUntrustedOutput } from './untrusted-output.ts';

const REGISTRY = process.env.REGISTRY;
const MODEL    = process.env.MODEL ?? '';

interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const { manifest: rawManifest, commands } = await loadRegistry({ registry: REGISTRY });
  // Apply per-model skill overrides if MODEL env identifies a target model.
  const manifest = applyOverridesToManifest(rawManifest, MODEL);
  const bash = new Bash({ customCommands: commands as never });

  const server = new Server(
    { name: 'agentic-tools-classic', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((t) => ({
      name: t.slug,
      description: t.summary,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params as CallToolParams;
    const tool = manifest.tools.find((t) => t.slug === name);
    if (!tool) return errorResult(`unknown tool: ${name}`);

    // Build the equivalent bash command: tool --k v --k2 v2 ...
    const cmd = `${tool.slug} ${argvToShellCommand(inputToArgv(args))}`.trim();
    try {
      const result = await bash.exec(cmd);
      // Classic mode: every call is a registry skill, so always wrap (V5).
      let stdout = (result.stdout ?? '').trim();
      if (stdout) {
        stdout = wrapUntrustedOutput(stdout, {
          slug: tool.slug,
          outputCap: tool.outputCap,
        });
      }
      return {
        content: [
          { type: 'text' as const, text: stdout || '(no stdout)' },
          ...(result.stderr ? [{ type: 'text' as const, text: `stderr:\n${result.stderr.trim()}` }] : []),
        ],
        isError: result.exitCode !== 0,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`crashed: ${msg}`);
    }
  });

  await server.connect(new StdioServerTransport());
  const tunedTools = manifest.tools
    .filter((t) => rawManifest.tools.find((r) => r.slug === t.slug && JSON.stringify(r) !== JSON.stringify(t)))
    .map((t) => t.slug);
  process.stderr.write(
    `[agentic-tools-classic mcp] ready — ${manifest.tools.length} skill(s) exposed individually` +
      (MODEL ? ` (MODEL=${MODEL}, tuned: ${tunedTools.length ? tunedTools.join(',') : 'none'})` : '') + '\n',
  );
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

main().catch((e: unknown) => {
  const err = e as Error;
  process.stderr.write(`[agentic-tools-classic mcp] fatal: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});
