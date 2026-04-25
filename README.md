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

## Validated against Cloudflare Workers AI / Granite 4.0 H Micro

The single-`bash` function-calling thesis tested live against
`@cf/ibm-granite/granite-4.0-h-micro` (3.4B params, on Cloudflare's free
inference tier).

Driver: `client/agent-granite.mjs` (full agent loop) and `client/exec-bash.mjs`
(local tool executor used by external loops).

### Results

| Scenario | Outcome | Tokens (total) |
|---|---|---|
| Sanity: "capital of Spain?" no tools | Final answer correct | 40 |
| Function-call: "convert phrase to uppercase" | tool_call → exec → JSON parse → final answer "AGENTIC TOOLS POC" | 400 (2 rounds) |
| Self-correction: ip lookup with bad jq path | Granite saw the jq error, pivoted to grep+awk on next turn | 462 (2 rounds, then went off-track) |

### What this proves

- Granite 4.0 H Micro **does** emit OpenAI-compatible `tool_calls` for our
  single `bash` tool — the registry pattern is consumable by small open-weights
  models, not just frontier ones.
- The agent loop (tool_call → local exec → observation → next turn) round-trips
  correctly. Workers AI `arguments` come back occasionally double-encoded;
  `agent-granite.mjs` handles both shapes.
- Self-correction works once when the model sees an explicit error, but a 3B
  model can't always validate the *content* of tool output (it accepted a
  malformed `"2001` as a country code). Larger models would.

## Smart contract: trade extra rounds for correctness on a small model

Hypothesis: a small model (Granite 4.0 H Micro at ~$0/free tier) doing 3
rounds with a richer tool-result contract is cheaper than calling a frontier
model once. Validated.

`client/smart-bash.mjs` wraps `bash.exec` and returns enriched observations
instead of raw `{stdout, stderr, exitCode}`:

- `tools_referenced[]` — which registry tools appear in the pipeline, each
  with its `output_schema`, a synthesized `example` value, and `jq_paths`
  (literal jq paths the model can copy-paste, generated from the schema)
- `schema_check` — when the pipeline ends in a registry tool, parses stdout
  and validates against `outputSchema`, returning `{validated, ok, errors}`
- `diagnostics[]` — pattern-matched hints for known antipatterns:
  - `jq: Cannot index string` → tells the model the upstream tool is flat,
    not nested, and points to `jq_paths` for valid options
  - `command not found` → lists available registry commands and standard tools
  - empty stdout despite exit 0 → suggests running the registry tool alone
  - escaped-quote stdout fragment → suggests the pipeline split on the wrong
    delimiter and recommends `jq -r .<field>` instead

### A/B test, same query, same first failed call

| Variant | Rounds | Total tokens | Outcome |
|---|---:|---:|---|
| **Raw observations** (`{stdout, stderr, exitCode}`) | 3 | ~1318 | ❌ Returned `"2001"` (wrong) |
| **Smart observations** (`+ tools_referenced + diagnostics + schema_check`) | 3 | ~1661 | ✅ Returned `MX` (correct) |
| **Overly directive** ("RULE: must use jq_paths") | 1 | ~499 | ⚠️ Hallucinated `US` — skipped tool call entirely |

### The takeaway

- Smart contract used **~26% more tokens** than raw, but went from **wrong**
  to **correct**. On the Workers AI free tier (10K neurons/day), both are $0.
- Granite is roughly 5 orders of magnitude cheaper per call than frontier
  paid models, so even +50% rounds is irrelevant cost-wise — what matters is
  whether convergence happens at all. With smart contracts, it does.
- Don't prescribe behavior in the system prompt ("you MUST use jq_paths"),
  just enrich the observation. Prescribing leads to skipped tool calls and
  hallucinated answers. The contract enriches; the model decides.

### Use it

```bash
# enriched observations (default)
node client/exec-bash.mjs "ip-info | jq -r '.country'"

# raw observations (baseline for A/B)
RAW=1 node client/exec-bash.mjs "ip-info | jq -r '.country'"

# agent loop with toggle
SMART=0 CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/agent-granite.mjs "your query"
```

### Run it

```bash
CF_ACCOUNT_ID=<your-account-id> CF_API_TOKEN=<token-with-Workers-AI-scope> \
  node client/agent-granite.mjs "convert 'agentic tools poc' to uppercase"
```

## Status

- ✅ Phase 1: trusted in-process execution via dynamic `import()` (current).
- ✅ MCP server with `bash` + `tool_schema` (current).
- ✅ End-to-end validated with Workers AI Granite 4.0 H Micro (current).
- ⏭ Phase 2: sandboxed execution via just-bash's `js-exec` (QuickJS) for
  community-contributed tools.
- ⏭ MCP `resources/` exposing tool READMEs as agent-readable docs.
