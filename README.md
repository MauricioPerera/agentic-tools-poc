# agentic-tools-poc

POC: AI agents discover and run tools whose **TypeScript source lives in
GitHub**, distributed via **jsDelivr** as a free global CDN, and executed by
[**just-bash**](https://github.com/vercel-labs/just-bash) — Vercel's virtual
bash environment for agents.

The agent talks to its tools through a regular bash shell, so they compose
with `jq`, `grep`, pipes and all the unix vocabulary it already knows.

## Distribution

Once committed to `main`, every build artefact is reachable on jsDelivr:

```
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@main/dist/manifest.json
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@main/dist/skills/echo-pretty.mjs
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@main/dist/skills/ip-info.mjs
```

Pin a version: replace `@main` with `@v0.1.0` once tagged.

## Repo layout

```
registry/skills/<slug>/
  tool.yaml      metadata + JSONSchema (input/output)
  src/index.mjs  default export: async (input, ctx) => output
  README.md      human + agent-facing docs
schema/skill.schema.mjs   shared validator (CI linter + runtime)
scripts/
  validate.mjs   lints every tool.yaml against SKILL_SCHEMA
  build.mjs      esbuild-bundles each src/ → dist/skills/<slug>.mjs
  manifest.mjs   emits dist/manifest.json
client/
  loader.mjs     fetches manifest, registers each tool as a just-bash command
  demo.mjs       runs a two-tool bash pipeline as proof
dist/            generated, committed, served by jsDelivr
```

## Local commands

```bash
npm install
npm run validate    # lint tool.yaml files
npm run build       # bundle skills
npm run manifest    # emit manifest.json
npm run all         # validate + build + manifest
npm run demo        # run the just-bash pipeline against published dist/
```

## How a tool looks

```js
// registry/skills/echo-pretty/src/index.mjs
export default async function handler(input, ctx) {
  let out = String(input.text ?? '');
  if (input.upper) out = out.toUpperCase();
  ctx.log(`produced ${out.length} chars`);
  return { text: out, length: out.length };
}
```

Every handler receives a curated `ctx` (`fetch` gated by the tool's
`networkPolicy`, scoped `env`, `log`). The loader is the trust boundary.

## MCP server

`client/mcp-server.mjs` is a stdio Model Context Protocol server that exposes
the registry to any MCP-compatible host (Claude Code, Cursor, Continue, etc).

It exposes **two** tools, not N:

- `bash` — run any bash command in a `just-bash` sandbox where every registry
  tool is callable as a unix command, alongside `jq`, `grep`, `awk`, `xargs`,
  `sed`, etc.
- `tool_schema` — returns the JSONSchema + metadata for any registry tool, so
  the agent can introspect on demand instead of paying for N tool definitions
  upfront.

The thesis: composing tools through unix pipes is dramatically more
token-efficient than discrete function calls, because intermediate values
never cross the model boundary. Example pipeline run via a single MCP tool
call:

```bash
ip-info | jq -r '.country' | xargs -I {} echo-pretty --text "{}" --upper --prefix "country=> "
# → {"text":"country=> MX","length":12}
```

### Add to Claude Code

`~/.claude/mcp.json` (or per-project `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "agentic-tools": {
      "command": "node",
      "args": ["<absolute path to repo>/client/mcp-server.mjs"]
    }
  }
}
```

To pin a specific registry version, add an env var:

```json
"env": { "REGISTRY": "https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@v0.1.0/dist" }
```

### Local testing

```bash
npm run mcp:test   # spawns the server + drives it as an MCP client
```

## Status

- ✅ Phase 1: trusted in-process execution via dynamic `import()` (current).
- ✅ MCP server with `bash` + `tool_schema` (current).
- ⏭ Phase 2: sandboxed execution via just-bash's `js-exec` (QuickJS) for
  community-contributed tools.
- ⏭ MCP `resources/` exposing tool READMEs as agent-readable docs.
