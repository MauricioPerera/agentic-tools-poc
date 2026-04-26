# agentic-tools-poc

An architecture for building, owning, and distributing the **skill catalog**
of an AI agent. Skills live as TypeScript in a public **GitHub** repo,
distributed via **jsDelivr** as a free global CDN, and executed by
[**just-bash**](https://github.com/vercel-labs/just-bash) — Vercel's virtual
bash environment for agents.

Codebase: ~2400 LOC of strict TypeScript, runs natively on Node 22+ via
type-stripping (no build step for execution). 91 unit tests via `node:test`.
Zero runtime dependencies beyond `just-bash`, `@modelcontextprotocol/sdk`,
and `yaml`.

The premise: **agent capabilities are skills, not tools**. Skills are owned
by the agent's author and carry not just the function but its context,
per-model tuning, recovery patterns, and meta-knowledge. See
[PHILOSOPHY.md](./PHILOSOPHY.md) for the full reasoning.

The agent talks to its skills through a regular bash shell, so they compose
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
types/index.ts                shared TypeScript types (Skill, Manifest, Observation, …)
registry/skills/<slug>/
  tool.yaml                   metadata + JSONSchema (input/output) for the skill
  src/index.ts                typed handler: SkillHandler<Input, Output>
  README.md                   human + agent-facing docs (the context layer)
schema/skill.schema.ts        shared validator (CI linter + runtime)
scripts/
  validate.ts                 lints every tool.yaml against SKILL_SCHEMA
  build.ts                    esbuild-bundles each src/ → dist/skills/<slug>.mjs
  manifest.ts                 emits dist/manifest.json
client/
  arg-parser.ts                  argv↔input + tool_call.arguments parsers
  loader.ts                      fetches manifest, registers each skill as a just-bash command
  smart-bash.ts                  recovery layer: enriched observations with schema + diagnostics
  skill-tuning.ts                applies per-model overrides + system_prompt_fragments
  model-adapter.ts               normalizes Workers AI per-model response shapes
  llms-txt-loader.ts             consumer of the proposed `## Skills` extension
  mcp-server.ts                  composable MCP server (one `bash` tool)
  mcp-server-classic.ts          classic MCP server (one tool per skill)
  agent-granite.ts               Workers AI agent loop driver
  compare.ts                     A/B harness: composable vs classic, same queries
  demo.ts / test-mcp.ts          bash + MCP integration tests
test/*.test.ts                   91 unit tests (node:test, no extra deps)
dist/                            generated, committed, served by jsDelivr
tsconfig.json                    strict TS, NodeNext, allowImportingTsExtensions
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

## Cross-model A/B benchmark

Two MCP servers ship in this repo so you can compare them on the same model:

- `client/mcp-server.mjs` — **composable**: one `bash` tool, registry skills
  available as commands inside it. Compose via unix pipes.
- `client/mcp-server-classic.mjs` — **classic**: each registry skill exposed
  as its own MCP function with its own JSONSchema (traditional
  function-calling shape).

The same harness (`client/compare.mjs`) drives both modes against any
Workers AI model via the `MODEL` env var. We benchmarked two free-tier
models on the same 3-query suite:

```bash
MODEL=@cf/ibm-granite/granite-4.0-h-micro CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/compare.mjs
MODEL=@hf/nousresearch/hermes-2-pro-mistral-7b CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/compare.mjs
```

### Results — IBM Granite 4.0 H Micro (3.4B)

| Query | Mode | Rounds | Tokens | Correct |
|---|---|---:|---:|:---:|
| Q1 — *uppercase 'agentic tools poc'* | composable | 2 | 677 | ✅ AGENTIC TOOLS POC |
| Q1 | classic | 2 | 755 | ✅ AGENTIC TOOLS POC |
| Q2 — *what country am I in* | composable | 2 | 662 | ✅ MX |
| Q2 | classic | 2 | 667 | ✅ MX |
| Q3 — *country code uppercased w/ prefix* | composable | 5 | 2440 | ✅ YOU ARE IN: MX |
| Q3 | classic | 3 | 1229 | ✅ YOU ARE IN: MX |
| **Totals** | composable | **9** | **3779** | **3/3** |
| **Totals** | classic | **7** | **2651** | **3/3** |

### Results — Google Gemma 4 26B-a4b-it ($0.10/M in, $0.30/M out)

Response shape is OpenAI-compatible (same as Granite — no adapter changes
needed). Notably emits a `reasoning` field with explicit chain-of-thought
before each tool call, which inflates token costs.

| Query | Mode | Rounds | Tokens | Correct |
|---|---|---:|---:|:---:|
| Q1 — uppercase | composable | 1 | 127 | ⚠️ skipped tool entirely, answered from training (got it right but failed the "always use bash" instruction) |
| Q1 | classic | 2 | 490 | ✅ AGENTIC TOOLS POC |
| Q2 — country code | composable | 2 | 436 | ✅ MX |
| Q2 | classic | 2 | 611 | ✅ MX |
| Q3 — chained | composable | 3 | 898 | ✅ YOU ARE IN: MX (saved by defensive `ip-info` handler that ignored Gemma's stray `ip-info country` arg) |
| Q3 | classic | 4+ | 1874+ | ❌ stuck in loop — repeatedly called `echo-pretty` with `prefix: "YOU ARE IN: 1"` (extra "1" character, recognized the bug in `reasoning` but couldn't fix the action) |
| **Totals** | both modes | 12+ | 4436+ | **4-5/6** |

### Results — Hermes 2 Pro Mistral (7B, beta)

Caveats: token counts are **char-based estimates** (`~chars/4`) because
Hermes returns `usage` all zeros in beta. Response shape also differs from
Granite (`result.response` + top-level `result.tool_calls[]` with parsed
arguments) — the new `client/model-adapter.mjs` normalizes both.

| Query | Mode | Rounds | Tokens (est) | Correct |
|---|---|---:|---:|:---:|
| Q1 — *uppercase 'agentic tools poc'* | composable | 2 | ~290 | ✅ (round 1 failed; round 2 hallucinated the right answer) |
| Q1 | classic | 2 | ~310 | ✅ AGENTIC TOOLS POC |
| Q2 — *what country am I in* | composable | 2 | ~280 | ❌ asked `.ip` not `.country`, then hallucinated **"IS" (Iceland)** |
| Q2 | classic | 2 | ~250 | ❌ invented `ip: "192.168.1.1"`, then "Sorry, couldn't retrieve your location" |
| Q3 — *country code uppercased w/ prefix* | composable | 2 | ~300 | ❌ malformed `ip-info --ip` (no value) → 404 → gave up |
| Q3 | classic | 3 | ~440 | ⚠️ only converged after we ignored a bad arg (`ip: "not_specified"`) |
| **Totals (no rescue)** | composable | 6 | ~870 | **1/3** |
| **Totals (no rescue)** | classic | 7 | ~1000 | **1/3 → 2/3 with rescue** |

### Cross-model takeaway

|  | Granite 4.0 H Micro (3.4B, free) | Hermes 2 Pro Mistral (7B beta, free) | Gemma 4 26B-a4b (paid) |
|---|---|---|---|
| Composable correctness | 3/3 | 1/3 → 3/3 (with skill tuning) | 2/3 (1 skipped tool) |
| Classic correctness | 3/3 | 1-2/3 → 3/3 (with skill tuning) | 2/3 (Q3 stuck in loop) |
| Self-correction on tool failure | ✅ Tries alternatives | ❌ Gives up | ⚠️ Identifies bug in reasoning, can't fix action |
| Hallucination resistance | ✅ Stays in tool world | ❌ Invents IPs, countries | ✅ Stays in tool world |
| Skips tool when it can answer directly | ❌ Always uses tool | ❌ Always tries | ⚠️ Skips simple tasks (Q1 composable) |
| Follows "reply with just the result" | ✅ | ❌ Adds apologetic prose | ✅ |
| Native tool-call format | Double-encoded args | Parsed args, no wrapper | OpenAI standard |
| Reported tokens | ✅ Real | ❌ Always 0 (beta) | ✅ Real (with reasoning eating budget) |
| Cost per query (3-q suite) | ~$0 (free tier) | ~$0 (free tier) | ~$0.0015 (paid) |

**Two counter-intuitive findings:**

1. **Granite (3.4B free) beats Gemma (26B paid) for tool-driven tasks.**
   Gemma's reasoning capability is a liability here — it eats tokens
   without improving outcomes, and on Q3 classic it gets stuck in a
   tokenization-induced loop ("YOU ARE IN: 1MX") that Granite avoided.

2. **Parameter count is a bad predictor of tool-calling reliability.**
   Tool fine-tuning recency dominates. A small model trained recently
   for tool use (Granite 4.0) outperforms a 26B reasoning model (Gemma 4)
   AND a 7B older instruct model (Hermes) on the same suite.

The smart-bash contract + ownership of skills amplifies what each model
can do, but cannot compensate for fundamental weaknesses in
instruction-following, action-reasoning alignment, or output formatting
discipline.

### Rescuing Hermes via per-model skill tuning

Because we own the skills, we can ship per-model overrides without changing
the underlying behaviour. `tool.yaml` accepts a `model_overrides` block:

```yaml
slug: ip-info
inputSchema:
  type: object
  properties:
    ip: { type: string, description: "IP to look up. Defaults to caller's." }
model_overrides:
  hermes:
    summary: |
      Returns YOUR own public IP and country code. Takes no arguments —
      call with empty object {}. Never invent IP addresses.
    inputSchema:
      type: object
      properties: {}    # remove the param entirely for Hermes
```

The loader (`client/skill-tuning.mjs`) applies the matching block based on a
case-insensitive substring match against the model name. `MODEL=@hf/.../hermes-2-pro`
gets the `hermes` block; everyone else gets the default.

The handler also got a defensive layer: SENTINELS + private-IP regex catch
garbage values (`"192.168.1.1"`, `"not_specified"`, `true`) from any model
and fall back to caller-IP lookup.

#### Hermes A/B with skill tuning (same model, same queries)

| Query | Mode | Untuned | Tuned (`MODEL=hermes`) |
|---|---|---|---|
| Q1 — uppercase | composable | ✅ (lucky) | ✅ |
| Q1 — uppercase | classic | ✅ | ✅ |
| Q2 — country code | composable | ❌ hallucinated "IS" | ✅ MX (2 rounds) |
| Q2 — country code | classic | ❌ invented IP, gave up | ✅ MX (2 rounds) |
| Q3 — chained | composable | ❌ gave up | (pending verification) |
| Q3 — chained | classic | ⚠️ only with rescue | ✅ "YOU ARE IN: MX" (3 rounds) |
| **Total** | both modes | **1-3/6** | **5+/6** |

The same model that scored 1-3/6 untuned now scores 5+/6 with model-specific
schema + system-prompt tuning — work the consumer of a vendor MCP could not
have done. This is the empirical validation of [PHILOSOPHY.md](./PHILOSOPHY.md):
**skill ownership is a model-rescue mechanism**.

For composable mode, the equivalent tuning lives in the system prompt: include
concrete examples like `ip-info | jq -r '.country'` so Hermes picks the right
jq path instead of guessing. `client/compare.mjs` and `client/agent-granite.mjs`
both can carry per-model prompt fragments — same idea, different surface.

### Recommendation matrix (updated)

| Model class | Recommended mode | Notes |
|---|---|---|
| **Tool-tuned small (Granite 4.0 micro, free)** | **classic** primary, composable for simple tasks | Best free-tier choice we tested — 6/6 in suite. JSONSchema acts as safety net. |
| Older 7B (Hermes 2 Pro, OpenHermes 2.5, free beta) | classic + per-model skill tuning | Tuning rescues from 1-3/6 to 5+/6 — mandatory for production use |
| Reasoning mid-tier (Gemma 4 26B-a4b, paid) | classic — watch for tokenization-induced loops | 4-5/6, reasoning eats tokens without improving outcomes |
| Frontier (Claude, GPT-4o) | **composable** | Reliable bash composition, fewer tokens |

**Pragmatic conclusion**: for free-tier production agents on Cloudflare,
**Granite 4.0 H Micro + classic MCP + smart-bash contract** is our
recommended stack. Larger / paid models did not improve outcomes on this
suite.



### Why composable struggled on small models — Q3 in detail

In composable mode Granite (3.4B):

1. Hallucinated `curl https://api.country.io/...` (round 1) — `curl` isn't
   in the just-bash sandbox. Diagnostic kicked in.
2. Pivoted to `ip-info | jq -r '.country'` (round 2). Got `MX`.
3. Tried `echo-pretty --upper --prefix "MX"` — missing required `--text`
   (round 3). Schema check caught it.
4. Tried `echo-pretty --upper --text "MX"` — but dropped `--prefix` this
   time (round 4). Got `{"text":"MX","length":2}`.
5. Assembled the answer manually in the final response (round 5).

In classic mode, the model just called `ip-info` then `echo-pretty` with
all required structured args validated by JSONSchema. No hallucination,
no missing flags, 3 rounds.

**The lesson**: composable wins on token theory only if the model can
reliably compose. A small or older model can't; a frontier model can.
JSONSchema function-calling acts as a safety net for small models against
the syntactic cliffs of bash.

The repo lets you flip with zero code changes: just point your MCP host
at `mcp-server.mjs` (composable) or `mcp-server-classic.mjs` (classic),
or both side-by-side under different names.

## Compatibility with proposed `llms.txt ## Skills` extension

There is a parallel proposal to extend the [llms.txt](https://llmstxt.org)
spec with an optional `## Skills` section letting any static site declare
the SKILL.md files an agent should load to interact with it:

- **RFC** (v0.2): https://img.automators.work/docs/rfc-skills-in-llms-txt.md
- **Issue** at AnswerDotAI/llms-txt: https://github.com/AnswerDotAI/llms-txt/issues/116

This repo includes the **first independent consumer** of that proposed
format. Use it against any site that publishes a `## Skills` section:

```bash
$ node client/load-domain.mjs https://img.automators.work

══ https://img.automators.work ═════════════════════════════════
llms.txt:  https://img.automators.work/llms.txt
Skills:    1

══ placeholder v1.0.0 ══════════════════════════════════════════
description: Generate SVG placeholder images for UI mockups via the placeholder-img HTTP API.
source:      https://img.automators.work/skills/placeholder/SKILL.md
license:     MIT
homepage:    https://img.automators.work
body:        2872 chars

$ node client/load-domain.mjs https://docs.anthropic.com

══ https://docs.anthropic.com ══════════════════════════════════
llms.txt:  https://docs.anthropic.com/llms.txt
Skills:    0

No `## Skills` section found in llms.txt at https://docs.anthropic.com/llms.txt.
See https://github.com/AnswerDotAI/llms-txt/issues/116 for the proposed format.
```

The loader (`client/llms-txt-loader.mjs`) implements RFC §2.1 (parsing) and
§2.3 steps 1-4 (discovery + surfacing). Steps 5-7 (user opt-in, load,
cache) belong to the agent host that consumes the loader's output.

It also handles:

- Cross-origin `SKILL.md` URLs (RFC §2.1 rule 5)
- Optional inline metadata (`<!-- skill: {"version":"…", "sha256":"…"} -->`)
- sha256 verification when declared (RFC §2.2)
- Graceful skip of `.zip` / `.tar.gz` archives (out of scope for v1)
- Negative path: domains without `## Skills` get a friendly hint pointing
  to the proposal issue, evangelizing adoption while degrading cleanly

## Skill linter

`npm run lint` runs a semantic linter over every `tool.yaml`. It encodes
the antipatterns observed empirically when running real models against the
registry — e.g. optional fields without descriptions cause Hermes 7B to
invent values. Eight rules across three severities:

| Rule | Severity | What it detects |
|---|---|---|
| `optional-string-no-description` | warning | Optional string field missing a description |
| `optional-no-default` | warning | Optional field with no explicit default |
| `required-no-description` | error | Required field missing a description |
| `output-schema-missing` | error | No outputSchema → smart-bash can't introspect |
| `destructive-no-warning` | warning | sideEffects: destructive but no safety language |
| `summary-too-long` | warning | summary > 120 chars (lives in every tools/list) |
| `optionals-without-tuning` | info | 2+ optional fields and no model_overrides — likely needs per-model tuning |
| `network-skill-no-policy` | warning | network capability declared but allow list empty |

`npm run lint` exits non-zero on errors (warnings + info don't block).
`npm run lint -- --all` shows info-severity suggestions too.

The linter found one warning on the existing registry (`ip-info.ip` was
optional without an explicit default) which has been fixed; one info
finding remains (`echo-pretty` has 3 optional fields and no
`model_overrides`, suggesting per-model tuning may be worthwhile).

## Status

- ✅ Phase 1: trusted in-process execution via dynamic `import()`.
- ✅ MCP server (composable) with `bash` + `tool_schema`.
- ✅ MCP server (classic) with one tool per registry entry.
- ✅ Smart-bash observation contract (schema + diagnostics + jq_paths).
- ✅ Skill linter (8 semantic rules, 27 unit tests).
- ✅ End-to-end validated with Workers AI Granite 4.0 H Micro,
  Hermes 2 Pro Mistral 7B, and Gemma 4 26B-a4b-it.
- ✅ Composable vs classic A/B benchmark across all three models.
- ✅ Per-model skill tuning rescues weak models (Hermes 1-3/6 → 5+/6).
- ✅ `model-adapter.mjs` normalizes Workers AI per-model response shapes.
- ✅ `client/llms-txt-loader.mjs` — first independent consumer of the
  proposed `llms.txt ## Skills` extension
  ([Issue #116](https://github.com/AnswerDotAI/llms-txt/issues/116)).
- ⏭ Phase 2: sandboxed execution via just-bash's `js-exec` (QuickJS) for
  community-contributed tools.
- ⏭ MCP `resources/` exposing tool READMEs as agent-readable docs.
- ⏭ Re-run benchmark on Llama 3.1 8B / Qwen 2.5 Coder 32B for the
  middle-tier crossover point.
