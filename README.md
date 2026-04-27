# agentic-tools-poc

An architecture for building, owning, and distributing the **skill catalog**
of an AI agent. Skills live as TypeScript in a public **GitHub** repo,
distributed via **jsDelivr** as a free global CDN, and executed by
[**just-bash**](https://github.com/vercel-labs/just-bash) — Vercel's virtual
bash environment for agents.

Codebase: ~6,000 LOC of strict TypeScript, runs natively on Node 22+ via
type-stripping (no build step for execution). 196 tests via `node:test`
covering parsers, the codegen converter, the smart-bash observation
contract (incl. required-field validation + fallback diagnostic), per-model
overrides, the llms.txt skills consumer, MCP wire format (spawned
subprocesses), bundle integrity (corrupted-vs-clean fixtures), and pricing
math. Zero runtime dependencies beyond `just-bash`,
`@modelcontextprotocol/sdk`, and `yaml`.

The premise: **agent capabilities are skills, not tools**. Skills are owned
by the agent's author and carry not just the function but its context,
per-model tuning, recovery patterns, and meta-knowledge. See
[PHILOSOPHY.md](./PHILOSOPHY.md) for the full reasoning and
[THREAT-MODEL.md](./THREAT-MODEL.md) for the security posture (Phase 1
trusts skill authors; Phase 2 ships QuickJS sandboxing).

The agent talks to its skills through a regular bash shell, so they compose
with `jq`, `grep`, pipes and all the unix vocabulary it already knows.

## Distribution

`main` holds the source. Every push to `main` triggers a CI workflow that
runs the full pipeline (typecheck → tests → validate → lint → codegen
check → build → manifest) and publishes the built artefacts to a
dedicated `dist` branch. This keeps `main` free of generated files and
lets jsDelivr serve the registry from a clean URL:

```
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@dist/manifest.json
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@dist/skills/echo-pretty.mjs
https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@dist/skills/ip-info.mjs
```

Pin a release: replace `@dist` with `@<commit-sha>` (always available) or
`@v1.2.3` once tagged.

## Repo layout

```
PHILOSOPHY.md                   the architectural posture (skills > tools)
THREAT-MODEL.md                 5 threat vectors + Phase 1 mitigations + Phase 2 plan

types/index.ts                  shared TypeScript types (Skill, Manifest,
                                Observation, NormalizedReply, TokenUsage, …)
registry/skills/<slug>/
  tool.yaml                     metadata + JSONSchema (input/output) + model_overrides
  src/index.ts                  typed handler: SkillHandler<Input, Output>
  src/types.gen.ts              auto-generated Input/Output from tool.yaml
  README.md                     human + agent-facing docs (the context layer)

examples/                       real raw-vs-smart observation diffs captured
                                from `npm run exec` against local dist/
  01-clean-success.json         clean exec — schema_check + jq_paths
  02-jq-path-error.json         the .ip.country bug + diagnostic that fixes it
  03-command-not-found.json     curl hallucination + catalog enumeration
  04-pipeline-with-transform.json  schema_check explains why it was skipped
  05-classic-mode-call.json     same skill, function-call shape comparison

schema/skill.schema.ts          structural SKILL_SCHEMA + tiny validator
scripts/
  validate.ts                   structural lint of every tool.yaml
  lint.ts                       semantic lint (8 rules from empirical A/B)
  codegen-types.ts              tool.yaml → src/types.gen.ts (+ --check mode)
  build.ts                      esbuild-bundles each src/ → dist/skills/<slug>.mjs
  manifest.ts                   emits dist/manifest.json (incl. per-bundle sha256)
  smoke-test-skills.ts          live test of network-using skills (npm run smoke)

client/
  loader.ts                     fetches manifest, verifies sha256, registers each
                                skill as a just-bash command (file:// + http(s))
  arg-parser.ts                 argv↔input + tool_call.arguments parsers
  smart-bash.ts                 enriched observations: schema_check (incl.
                                required-field validation), jq_paths, diagnostics
                                (5 pattern-matched + fallback for unmatched stderr)
  skill-tuning.ts               per-model overrides + system_prompt_fragments
  skill-linter.ts               8 lint rules as pure functions
  jsonschema-to-ts.ts           the converter behind codegen
  model-adapter.ts              normalizes Workers AI shapes (OpenAI / Hermes /
                                Llama 3.1 fp8 / Qwen 2.5 Coder) → one shape
  pricing.ts                    per-model $/M in/out (live from Cloudflare catalog)
  llms-txt-loader.ts            consumer of the proposed `## Skills` extension
  mcp-server.ts                 composable MCP server (one `bash` tool)
  mcp-server-classic.ts         classic MCP server (one tool per skill)
  agent-granite.ts              Workers AI agent loop driver
  compare.ts                    A/B harness: composable vs classic, same queries,
                                input/output tokens + USD cost per query
  exec-bash.ts                  single-command CLI wrapper for external loops
  load-domain.ts                CLI for the llms.txt ## Skills consumer
  demo.ts                       local bash composition demo (no MCP)

test/*.test.ts                  196 tests (node:test, zero extra deps)
  arg-parser, codegen-drift, jsonschema-to-ts, llms-txt-loader, loader,
  loader-integrity, mcp-server, mcp-server-classic, model-adapter, pricing,
  skill-linter, skill-tuning, smart-bash

dist/                           generated by `npm run build`. Not tracked in
                                main; CI publishes to the `dist` branch.

.github/workflows/build.yml     runs `npm run all` on push to main and
                                publishes dist/ to the `dist` branch via
                                git worktree.
.github/workflows/validate-pr.yml  runs the same pipeline on every PR.

tsconfig.json                   strict TS, NodeNext, allowImportingTsExtensions
.gitattributes                  LF-only line endings; marks dist/ + types.gen.ts
                                as linguist-generated for cleaner GitHub diffs
```

## Local commands

```bash
npm install

# Pipeline (npm run all chains all 7 in order):
npm run typecheck       # tsc --noEmit
npm test                # 160 unit + integration tests
npm run validate        # structural lint of tool.yaml files
npm run lint            # semantic lint (8 rules) on every skill
npm run codegen         # regenerate src/types.gen.ts from tool.yaml
npm run codegen:check   # CI gate: fail if codegen would change anything
npm run build           # esbuild-bundle each skill into dist/skills/<slug>.mjs
npm run manifest        # emit dist/manifest.json
npm run all             # all of the above, in order

# Demos / one-shots:
npm run demo            # local just-bash pipeline against the published dist/
npm run smoke           # call every network-using skill against its real API
npm run discover <url>  # llms.txt ## Skills consumer (RFC §2.3)
npm run mcp:server      # start the composable MCP server (stdio)
npm run mcp:classic     # start the classic MCP server (one tool per skill)
```

## How a skill looks

```typescript
// registry/skills/echo-pretty/src/index.ts
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';   // ← auto-generated

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  let out = String(input.text ?? '');
  if (input.upper) out = out.toUpperCase();
  ctx.log(`produced ${out.length} chars`);
  return { text: out, length: out.length };
};

export default handler;
```

Every handler receives a curated `ctx` (`fetch` gated by the tool's
`networkPolicy`, scoped `env`, `log`). The loader is the trust boundary.

## MCP server

`client/mcp-server.ts` is a stdio Model Context Protocol server that exposes
the registry to any MCP-compatible host (Claude Code, Cursor, Continue, etc).

It exposes **two** tools, not N:

- `bash` — run any bash command in a `just-bash` sandbox where every registry
  tool is callable as a unix command, alongside `jq`, `grep`, `awk`, `xargs`,
  `sed`, etc.
- `tool_schema` — returns the JSONSchema + metadata for any registry tool, so
  the agent can introspect on demand instead of paying for N tool definitions
  upfront.

### How discovery works — filtered, on-demand, NOT preloaded

The bash tool's `description` field does **NOT** enumerate the registry.
The model sees only the count and the discovery commands. It loads
schemas only when it decides to use them, and can filter the listing by
capability or fuzzy search to keep the prompt small even with hundreds
of skills.

This is what makes the architecture genuinely O(catalog-subset) instead
of O(catalog-total) — both classic-MCP and the previous version of this
repo put the full catalog into every prompt regardless. Filtered
discovery is the only mechanism that lets the model ask *"what skills
handle networking?"* and load only those, rather than carrying every
weather + dictionary + github schema for every query.

```
Description of `bash` (the model receives this in tools/list):

  Execute a bash command in a sandboxed environment.

  Discover available skills by running:
    bash list_skills                          → all skills (one slug + summary per line)
    bash list_skills --capability <tag>       → filter by capability tag (e.g. network, lookup, transform)
    bash list_skills --search <query>         → fuzzy search across slug, summary, capabilities
    bash list_skills --json                   → full metadata as JSON

  Inspect a specific skill's contract before using it:
    bash tool_schema --slug <name>            → returns the full JSONSchema for input/output

  Standard unix tools also available: jq, grep, sed, awk, xargs, head, wc, tr.

  Compose tools with pipes for token efficiency …
```

`list_skills` and `tool_schema` are **bash built-ins**, not separate
MCP tools — that keeps the function-calling surface at exactly ONE
tool (`bash`) regardless of registry size. The implementation lives
in `client/loader.ts` (search for `defineCommand('list_skills', …)`).

#### Verified end-to-end (Gemma 4 26B on Workers AI)

Real trace of a model resolving "What ISO country code am I in?" with
**no upfront catalog** in the system prompt:

```
Round 1: bash → list_skills              → discovers: ip-info, weather, ...
Round 2: bash → list_skills              → re-reads (model double-checks)
Round 3: bash → tool_schema --slug ip-info  → loads ONLY that contract
Round 4: bash → ip-info                  → invokes
Round 5: → "AR"  ✅ correct
```

Token comparison, same model + same query, two architectures:

| Query | Old (catalog upfront) | New (filtered discovery) |
|---|---:|---:|
| "Capital of Spain" (no tool needed) | 403 input tokens | **291 input tokens (-28%)** |
| "What country am I in?" (needs ip-info) | 459 in / 1 round | 2,347 in / 5 rounds |

For the 6-skill registry, discovery wins on knowledge queries and
loses on tool-required queries (the rounds add up). For a 100-skill
registry the math flips — the old "catalog upfront" approach pays
~2,500 tokens **per query**, while filtered discovery pays only the
schemas the model actually inspects.

#### Caveat: small open-weights can't drive discovery

Discovery requires the model to reason "I need to find what's
available" then act. Granite 4.0 H Micro improvises with
`curl restcountries.com` instead. Qwen 2.5 Coder breaks the tool-call
format. Llama and Hermes get stuck. **Only Gemma 4 26B (and presumably
larger frontier models) successfully ran the discovery flow end-to-end
in our tests.**

For deployments targeting small open-weights, the older "catalog
upfront" composable mode is still available — see commits before
`<this-pr-sha>`. For Gemma 4 / frontier models, the filtered-discovery
mode is what `mcp-server.ts` ships today.

The thesis: composing tools through unix pipes is more token-efficient
than discrete function calls **when the model can reliably write the
composition**. Example pipeline run via a single MCP tool call:

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
      "args": ["<absolute path to repo>/client/mcp-server.ts"]
    }
  }
}
```

To pin a specific registry version, add an env var:

```json
"env": { "REGISTRY": "https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@v0.1.0" }
```

### Local testing

`npm test` includes wire-format integration tests for both MCP servers
(`test/mcp-server.test.ts` and `test/mcp-server-classic.test.ts`) that
spawn the server as a subprocess, drive it with the official MCP Client
SDK, and assert tool listings, call shapes, and error paths. They use
the local `dist/` (via the loader's `file://` support) so they run
offline and deterministically.

Run them by themselves:

```bash
node --test --test-reporter=spec test/mcp-server.test.ts test/mcp-server-classic.test.ts
```

## Validated against Cloudflare Workers AI / Granite 4.0 H Micro

The single-`bash` function-calling thesis tested live against
`@cf/ibm-granite/granite-4.0-h-micro` (3.4B params, on Cloudflare's free
inference tier).

Driver: `client/agent-granite.ts` (full agent loop) and `client/exec-bash.ts`
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
  `agent-granite.ts` handles both shapes.
- Self-correction has limits: in the **baseline** (raw `{stdout, stderr,
  exitCode}` observations), Granite accepted a malformed `"2001` as a
  country code because nothing in the observation flagged it as
  semantically wrong. The same model under the **smart-bash contract**
  (next section) converges correctly on the same query. The lesson: a
  3B model can't always validate the *content* of tool output by itself
  — but it can if the observation contract does it for it.

## Smart contract: trade extra rounds for correctness on a small model

Hypothesis: a small model (Granite 4.0 H Micro at ~$0/free tier) doing 3
rounds with a richer tool-result contract is cheaper than calling a frontier
model once. Validated.

`client/smart-bash.ts` wraps `bash.exec` and returns enriched observations
instead of raw `{stdout, stderr, exitCode}`:

- `tools_referenced[]` — which registry tools appear in the pipeline, each
  with its `output_schema`, a synthesized `example` value, and `jq_paths`
  (literal jq paths the model can copy-paste, generated from the schema)
- `schema_check` — when the pipeline ends in a registry tool, parses stdout
  and validates against `outputSchema`, including **missing-required checks**
  (catches handlers that omit a declared-required field, not just type drift)
- `diagnostics[]` — hints derived from the failure mode:
  - `jq: Cannot index string` → tells the model the upstream tool is flat,
    not nested, and points to `jq_paths` for valid options
  - `command not found` → lists available registry commands and standard tools
  - jq compile / parse error on non-JSON → suggests verifying upstream output
  - empty stdout despite exit 0 → suggests running the registry tool alone
  - escaped-quote stdout fragment → suggests the pipeline split on the wrong
    delimiter and recommends `jq -r .<field>` instead
  - **fallback** (none of the above): when an unrecognized error is observed,
    smart-bash emits a diagnostic listing the catalog of patterns it knows +
    the available registry commands, so the model knows what it has to work
    with even when the specific error is novel

Concrete example — the model wrote `ip-info | jq -r '.ip.country'` (wrong:
`country` is at the root, not nested under `ip`). Raw observation:

```json
{ "exitCode": 5, "stdout": "", "stderr": "jq: parse error: Cannot index string with string \"country\"" }
```

Smart observation for the same call:

```json
{
  "exitCode": 5,
  "stdout": "",
  "stderr": "jq: parse error: Cannot index string with string \"country\"",
  "tools_referenced": [{
    "slug": "ip-info",
    "jq_paths": [".ip", ".country"],
    "output_schema": { "type": "object", "properties": {
      "ip":      { "type": "string" },
      "country": { "type": "string", "description": "ISO 3166-1 alpha-2 country code" }
    }}
  }],
  "diagnostics": [
    "jq could not traverse the path you used. Upstream tool 'ip-info' returns a flat object {ip:string, country:string} — use jq paths that match THAT shape (e.g. `.ip` for a flat field), not nested paths."
  ]
}
```

The diff is: copy-pasteable jq_paths, the actual upstream schema, and a
sentence explaining what went wrong. Five JSON fields the model now sees
that it didn't before. See [examples/](./examples/) for more side-by-side
captures (clean success, command not found, pipeline-with-transform,
classic-mode call).

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
node client/exec-bash.ts "ip-info | jq -r '.country'"

# raw observations (baseline for A/B)
RAW=1 node client/exec-bash.ts "ip-info | jq -r '.country'"

# agent loop with toggle
SMART=0 CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/agent-granite.ts "your query"
```

### Run it

```bash
CF_ACCOUNT_ID=<your-account-id> CF_API_TOKEN=<token-with-Workers-AI-scope> \
  node client/agent-granite.ts "convert 'agentic tools poc' to uppercase"
```

## Cross-model A/B benchmark

Two MCP servers ship in this repo so you can compare them on the same model:

- `client/mcp-server.ts` — **composable**: one `bash` tool, registry skills
  available as commands inside it. Compose via unix pipes.
- `client/mcp-server-classic.ts` — **classic**: each registry skill exposed
  as its own MCP function with its own JSONSchema (traditional
  function-calling shape).

The same harness (`client/compare.ts`) drives both modes against any
Workers AI model via the `MODEL` env var. We benchmarked two free-tier
models on the same 3-query suite:

```bash
MODEL=@cf/ibm-granite/granite-4.0-h-micro CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/compare.ts
MODEL=@hf/nousresearch/hermes-2-pro-mistral-7b CF_ACCOUNT_ID=… CF_API_TOKEN=… node client/compare.ts
```

The same harness now also runs a 20-query suite organised into 6 buckets
(see [`client/eval-suite.ts`](./client/eval-suite.ts)) so the comparison
covers more than the original 3 queries. Pass it via `SUITE`:

```bash
# default — the original 3 queries (kept for back-compat with the tables below)
SUITE=basic MODEL=… node client/compare.ts

# the full 20-query suite across all 6 buckets
SUITE=full  MODEL=… node client/compare.ts

# just one bucket (handy for iterating on a single failure mode)
SUITE=discipline MODEL=… node client/compare.ts
```

The 6 buckets each measure a different dimension of agent behaviour:

| Bucket | What it stresses | Disciplined outcome |
|---|---|---|
| `single` (4 queries) | One skill invoked correctly | `via_tool` |
| `chain-2` (3) | Output of one skill piped into another | `via_tool` |
| `chain-multi` (2) | Composition discipline over 3+ steps | `via_tool` |
| `error` (3) | Recovery, schema discovery, graceful "I cannot" | `via_tool` |
| `discipline` (5) | **Answerable from training knowledge** — model should NOT call a tool | `without_tool` |
| `ambiguous` (3) | Two or more skills could plausibly answer | `via_tool` |

The `discipline` bucket inverts the success criterion: pass = answered
correctly *without* invoking any skill. A model that calls `dictionary`
to answer "what's 7 × 8?" is technically correct but disciplinarily
gapped — the table marks it `⚠ via_tool` instead of `✓`. This is the
distinction the previous A/B (3 queries, all via_tool desired) couldn't
measure.

The runner also emits a per-bucket pass-rate breakdown so a model's
strengths and weaknesses are visible at a glance without reading every
row:

```
Per-bucket pass rate (disciplined outcome):
Bucket       | Composable     | Classic        | Notes
-------------|----------------|----------------|----------------------------------
single       |  4/ 4 (100%)   |  4/ 4 (100%)   | pass = answered VIA a tool
chain-2      |  3/ 3 (100%)   |  2/ 3 ( 67%)   | pass = answered VIA a tool
chain-multi  |  1/ 2 ( 50%)   |  2/ 2 (100%)   | pass = answered VIA a tool
error        |  2/ 3 ( 67%)   |  3/ 3 (100%)   | pass = answered VIA a tool
discipline   |  4/ 5 ( 80%)   |  3/ 5 ( 60%)   | pass = answered WITHOUT calling a tool
ambiguous    |  2/ 3 ( 67%)   |  3/ 3 (100%)   | pass = answered VIA a tool
```

(numbers above are illustrative; real per-model bucket tables land
once the full sweep runs)

**Cost ballpark** for a full sweep (20 queries × 2 modes × ~5 rounds ×
~500 tokens per round) per model:

| Model | $/M in | $/M out | Sweep cost (rough) |
|---|---:|---:|---:|
| Granite 4.0 H Micro | $0.017 | $0.11 | ~$0.005 |
| Hermes 2 Pro 7B (beta) | free | free | $0 |
| Llama 3.1 8B fp8 | $0.15 | $0.29 | ~$0.04 |
| Gemma 4 26B-a4b-it | $0.10 | $0.30 | ~$0.04 |
| Qwen 2.5 Coder 32B | $0.66 | $1.00 | ~$0.20 |
| **Total per full 5-model sweep** | | | **~$0.30** |

Times: ~5–8 minutes per model on Workers AI free tier (latency-bound,
not throughput-bound). Run all five sequentially in under an hour.

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
arguments) — the new `client/model-adapter.ts` normalizes both.

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

### Cross-model takeaway (5 models, 3 queries — N is small, treat as anecdote)

| | Granite 4.0 H Micro (3.4B) | Hermes 2 Pro (7B beta) | Llama 3.1 8B (fp8) | Gemma 4 26B-a4b | Qwen 2.5 Coder (32B) |
|---|---|---|---|---|---|
| **Pricing** ($/M in / out) | $0.017 / $0.11 | free in beta | $0.15 / $0.29 | $0.10 / $0.30 | $0.66 / $1.00 |
| Composable correctness | 3/3 | 1/3 → 3/3 (tuned) | 1/3 (skipped tool, lucky) | 2/3 (1 skipped tool) | 1/3 (hallucinated curl + emitted `<tools>` text) |
| Classic correctness | 3/3 | 1-2/3 → 3/3 (tuned) | 0/3 (loop on tool output) | 2/3 (Q3 stuck) | 2/3 (Q3 hallucinated answer without tool) |
| Self-correction on failure | ✅ Tries alternatives | ❌ Gives up | ❌ Loops on bad path | ⚠️ Sees bug in reasoning, can't fix action | ❌ Pretends to call tool, hallucinates |
| Hallucination resistance | ✅ Stays in tool world | ❌ Invents IPs/countries | ❌ Reaches for `$LC_ALL`, `curl` | ✅ Stays in tool world | ❌ Hallucinated US, made up `<tools>` markup |
| Invents values for optional args | ✅ Doesn't | ❌ "192.168.1.1", "not_specified" | ❌ "caller" | ✅ Empty {} | ✅ Empty {} |
| Native tool-call format | OpenAI (double-encoded args quirk) | Hermes-style (top-level `tool_calls`, parsed args) | Hermes-style | OpenAI + `reasoning` field | Yet another (`response: {name, arguments}` object + empty `tool_calls`) |
| Reported usage tokens | ✅ Real | ❌ All zeros (beta) | ✅ Real | ✅ Real | ✅ Real |

**Honest claim** (narrow): across 5 model classes on the 3-query
basic suite, **Granite 4.0 H Micro is the only model that converged
correctly on every query in both modes** without per-model tuning. The
classic vs composable trade-off WITHIN each model is itself
model-specific — see the recommendation matrix below. The two patterns
worth highlighting from the data:

- **Granite + classic** is the most efficient combination on the chains
  we measured (3/3 in 7 rounds / 2,651 tokens, vs 9 rounds / 3,779
  composable). Classic gains ~30% tokens at no correctness cost.
- **Gemma 4 + composable** is more efficient than **Gemma 4 + classic**
  on the same chains (-50% tokens, fewer rounds, classic got stuck in a
  loop on Q3). The previous version of this README claimed "classic
  primary" for Gemma based on a discipline measurement; the chain data
  contradict that recommendation. Both observations are now reflected
  in the matrix.

This is **n=2 model classes showing different mode-preferences**, not
a validated rule. Size and reasoning capability are confounded in the
data (Gemma is both larger AND has a reasoning field) — the question
of WHY Gemma prefers composable while Granite prefers classic stays
open until we test a model that varies one dimension and not the other.

**Discipline note**: a "correct" answer can come from invoking the right
tool *or* from the model bypassing the tool entirely and answering from
training knowledge. `compare.ts` now distinguishes these via the `outcome`
column: `via_tool` (correct, used a tool), `without_tool` (correct, no
tool used — discipline gap), `wrong_with_tool`, `wrong_no_tool`. Q1
`uppercase` is the canonical "without_tool" trap — every model can answer
it from training knowledge, but Granite + Llama still go through the
registry, while Gemma sometimes skips it. The distinction matters because
"correct without tool" doesn't measure tool-use reliability — it measures
training-knowledge coverage. Tracking issue
[#3](https://github.com/MauricioPerera/agentic-tools-poc/issues/3) plans
a 6-bucket suite to make these dimensions separately measurable.

### Cost per query — same workload, same correct answer

For Q1 ("convert phrase to uppercase"), classic mode, 2 rounds, ~600 in
+ ~40 out tokens:

| Model | Input $/M | Output $/M | Cost per Q1 | × Granite |
|---|---:|---:|---:|---:|
| Granite 4.0 H Micro | $0.017 | $0.11 | **$0.0000158** | 1× (baseline) |
| Gemma 4 26B-a4b | $0.10 | $0.30 | $0.000072 | 4.6× |
| Llama 3.1 8B fp8 | $0.15 | $0.29 | $0.000102 | 6.5× |
| Qwen 2.5 Coder 32B | $0.66 | $1.00 | $0.000442 | 28× |

For tasks of this complexity, **Granite gives the same correct answer
~5-30× cheaper**. The obvious caveat: Granite would not handle complex
multi-step planning the way Qwen Coder might — but for the agent loop
of "use tools, return result", it's the dominant choice.

### Why output-vs-input asymmetry matters for mode choice

Output is 2-10× more expensive than input across these models. That changes
the composable-vs-classic story:

- **Composable** ships less input (1 tool definition), more output (the
  model writes longer bash commands).
- **Classic** ships more input (N tool definitions, ~50 lines each), less
  output (structured args are short).

For Granite (output is **6.5×** input price), each extra output token
costs disproportionately more — so composable's "longer commands" penalty
hits hardest there. For Qwen (output is **1.5×** input price), the
balance is closer.

The token-count alone hides this. Run `npm run compare` against any model
and the SUMMARY table now breaks out `In | Out | Cost` per query so you
can see which mode is actually cheaper in $ for your workload.

### Three findings consistent with the data

(These were rewritten when the recommendation matrix was reorganised
around the actual measurements — the previous version of this section
contained claims contradicted by the discipline-bucket table below.)

1. **Cost gap (38×) is enormous and uncorrelated with tool-use
   reliability.** Granite at $0.017/M input is 38× cheaper than Qwen
   at $0.66/M input. On the discipline measurement (5 queries, both
   modes), Granite scores 1-2/5 and Qwen scores 2/5 — basically tied.
   Param count and price tier predict cost cleanly but predict
   tool-use reliability poorly. Among the 5 models tested, the largest
   (Gemma 4 26B at 2-3/5) only modestly outperforms the smallest
   (Granite 3.4B at 1-2/5).

2. **Adding tools to an open-weights agent often DEGRADES behaviour
   on knowledge questions.** None of the 5 models we tested reaches
   60% discipline on the D1-D5 measurement. With tools in the prompt,
   every model over-reaches — pattern-matching on "tools present"
   before considering "is this a knowledge question". The
   system-prompt instruction "never answer from training knowledge for
   live data" is structurally insufficient. Cost compounds: when the
   model reaches for a tool spuriously it usually emits an empty
   content field, so you pay the tool-call tokens AND get no answer
   back. (Specifically: Granite, Hermes, Llama all empty-out on D1
   composable; Llama empty-outs on every discipline query in both
   modes.)

3. **Mode preference inverts across models — we have a hypothesis but
   no validated rule.** Granite + classic is most efficient on chains
   (7 vs 9 rounds, -30% tokens, same correctness). Gemma 4 +
   composable is most efficient on the same chains (-50% tokens, 2-3/3
   vs 2/3 with classic stuck in a loop on Q3). The plausible axis is
   "deliberate reasoning step before tool call" (Gemma 4 emits a
   `reasoning` field) vs "instruct directly" (Granite/Hermes/Llama),
   but size is **confounded** with reasoning here — Gemma 4 is also
   8× larger than Granite. Disambiguating would need either a large
   no-reasoning model (Llama 3.1 70B Instruct) or a small reasoning
   model (DeepSeek-R1-Distill). Neither has been tested in this repo.

   Claims about smart-bash specifically "amplifying" any model are
   **not yet supported** by data — the ablation isolating
   classic+smart from classic+raw has not been run. That experiment
   is the most direct way to attribute observed gains to either the
   schema-gateway shape of classic or the enriched observation contract
   of smart-bash.

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

The loader (`client/skill-tuning.ts`) applies the matching block based on a
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
jq path instead of guessing. `client/compare.ts` and `client/agent-granite.ts`
both can carry per-model prompt fragments — same idea, different surface.

### Discipline-bucket measurement (5 queries × 5 models, real data)

Actual results from `SUITE=discipline` against all 5 benchmark
models. The 5 queries are all answerable from training knowledge
alone ("capital of Spain", "7 × 8", "language of 'merci'", "past
tense of 'run'", "spell 'mississippi' in uppercase"). The disciplined
outcome is `without_tool` — a model that calls `dictionary` to spell
"mississippi" is wrong-shaped even when correct.

| Model | Composable disciplined | Classic disciplined | Pattern |
|---|:---:|:---:|---|
| Granite 4.0 H Micro (3.4B) | 1/5 (D2) | 2/5 (D2 + D3) | Reaches for tool, emits empty content when it does (`wrong_with_tool`, not `via_tool`) |
| Hermes 2 Pro 7B (beta) | 0/5 | 0/5 | Always reaches for tool; never produces a correct answer |
| Llama 3.1 8B fp8 | 0/5 | 0/5 | Always reaches for tool; never produces a correct answer |
| **Gemma 4 26B-a4b-it** | **2/5** (D2 + D5) | **3/5** (D1 + D2 + D5) | **Best discipline of the five in classic mode** — answers Madrid, 56, MISSISSIPPI directly |
| Qwen 2.5 Coder 32B | 2/5 (D2 + D5) | 2/5 (D2 + D5) | Math + spelling without reaching; over-reaches on language/verb questions |

Three findings the previous 3-query A/B couldn't surface:

1. **Best classic-mode discipline is 60% (Gemma 4 26B); best
   composable is 40% (Gemma 4 + Qwen).** With tools available in the
   prompt, every open-weights model in our suite under-resists —
   pattern-matching on "tools present" before considering "is this a
   knowledge question". The system-prompt instruction "never answer
   from training knowledge for live data" is structurally
   insufficient; the larger model (Gemma 4 26B) shows discipline
   scales with capacity but doesn't saturate at this size.

2. **D2-arithmetic ("7 × 8") is the universal discipline pass.** All
   models that have any discipline at all answer 56 directly without
   tool. D5-spell-uppercase is second-most disciplined.
   Capital-of-Spain, verb-conjugation, and language-of-loanword
   trigger spurious tool calls in most models — Gemma 4 classic is
   the only one that resists on D1-capital.

3. **Reaching for a tool on a discipline question usually produces
   empty content** (model emits `tool_calls` with no answer text).
   The outcome is `wrong_with_tool`, not `via_tool` — undisciplined
   AND wrong, not just undisciplined. The cost of over-reach
   compounds: tokens spent on the tool call AND no answer back.

This is exactly the failure mode the previous 3-query A/B couldn't
expose. Adding tools to a small open-weights agent often DEGRADES
behaviour on questions training knowledge would have handled — a
real architectural finding, not a quirk.

> **Cost note**: this measurement was 5 models × 5 queries × 2 modes
> = 50 model calls, ~$0.06 total (Granite + Hermes free, Llama
> ~$0.01, Gemma 4 ~$0.02, Qwen ~$0.04). The 15 remaining queries × 5
> models × 2 modes need tool execution against the live skills, which
> requires `CF_API_TOKEN` in env to run `client/compare.ts` properly.
> They are not in this table; the framework has been validated
> end-to-end via the discipline subset.

### Recommendation matrix (read with hedges)

> **Sample size caveat (read this first)**: the chain-correctness numbers
> in this matrix come from **3 queries** (Q1-Q3 in `client/eval-suite.ts`,
> selectable via `SUITE=basic`). The discipline numbers come from a
> separate **5 queries** (D1-D5, selectable via `SUITE=discipline`).
> The remaining 12 queries in the full 20-query suite (chain-multi,
> error, ambiguous buckets) have **not** been run against all 5 models —
> they require `CF_API_TOKEN` and a live tool-execution path the eval
> harness drives. The cells below are **directional observations on a
> small sample**, not validated recommendations.

> **Tuning asymmetry caveat**: only Hermes has `model_overrides` defined
> in the registry today (`ip-info` and `url2md`). For Hermes, both
> composable and classic modes ran with the same tuning applied —
> "classic + tuning vs composable + tuning" is the actual comparison
> behind that row, not "classic + tuning vs composable raw". For the
> other four models, both modes ran without per-model tuning. The
> matrix language has been corrected accordingly.

> **Confound caveat**: the model that did best on chain composition
> (Gemma 4, 26B with reasoning field) is also the **largest** model in
> our suite. We cannot from this data attribute Gemma's composable
> success to "reasoning capability" vs "raw scale". Disambiguating
> would need either a large no-reasoning model (Llama 3.1 70B Instruct)
> or a small reasoning model (DeepSeek-R1-Distill-Qwen-7B). Neither is
> in the current Workers AI catalog, so the question stays open.

| Model class | Tested with | Observation | Caveat |
|---|---|---|---|
| Tool-tuned small (**Granite 4.0 H Micro**, 3.4B, $0.017/M in) | Q1-Q3 chains + D1-D5 discipline (no per-model tuning) | **Classic wins on chains** (7 vs 9 rounds, 2,651 vs 3,779 tokens, 3/3 both modes). Discipline 1/5 composable, 2/5 classic. JSONSchema safety net helps when chains compose. | Only model in suite that converged on every chain query. Generalisation to other small instruct models untested. |
| Older 7B instruct (**Hermes 2 Pro**, beta) | Q1-Q3 chains + D1-D5 discipline (with `model_overrides` applied to BOTH modes) | Without tuning both modes fail (1/3). With tuning both reach 3/3 — tuning rescued **both** modes, not classic specifically. Discipline 0/5 in either mode. | Overrides are applied to both modes (nominally symmetric), but their *effect* may differ by mode — the tuning rewrites field descriptions and removes optional args, which is information classic mode reads from the JSONSchema directly while composable mode sees only via `tool_schema`. We have not measured "with-tuning composable vs with-tuning classic" head-to-head; we only know both reach 3/3. Token counts are estimates (Hermes beta returns zero usage). |
| Mid-size instruct (**Llama 3.1 8B fp8**, $0.15/M in) | Q1-Q3 chains (aggregated only) + D1-D5 discipline (no per-model tuning) | Aggregated chain correctness 1/3 composable, 0/3 classic (model loops on tool output in classic, gets lucky in composable by skipping). Discipline 0/5 either mode — never resists tool. | **Per-query detail pending** — only aggregated correctness exists in the cross-model takeaway above, not the rounds/tokens breakdown the other models have. The matrix recommendation cell is empty until that's measured. |
| Reasoning mid-tier (**Gemma 4 26B-a4b-it**, $0.10/M in) | Q1-Q3 chains + D1-D5 discipline (no per-model tuning) | **Composable wins on chains for this model** — 6 vs 8+ rounds, 1,461 vs 2,975+ tokens, 2-3/3 vs 2/3 (classic got stuck in loop on Q3). Discipline inverts: 2/5 composable, 3/5 classic. | This is the row where the previous matrix said "classic primary" but the data say composable. The trade-off is **chain efficiency vs discipline**, not a single best mode. |
| Coder mid-tier (**Qwen 2.5 Coder 32B**, $0.66/M in) | Q1-Q3 chains (aggregated only) + D1-D5 discipline (no per-model tuning) | Aggregated chain correctness 1/3 composable, 2/3 classic. Discipline 2/5 both modes. Hallucinated `<tools>{...}` as raw text on chains BEFORE the Qwen `response: {name, arguments}` shape was normalised in `client/model-adapter.ts` (added in commit [`efa209b`](https://github.com/MauricioPerera/agentic-tools-poc/commit/efa209b), 2026-04-26). Chain correctness has not been re-measured against the post-fix adapter. | **Per-query detail + post-fix re-measurement pending against ≥`efa209b`.** The 2/3 classic correctness number predates that commit and may improve. |
| Frontier (Claude, GPT-4o) | ❌ untested | No data. Received-wisdom expectation: composable should favour these, but we have not verified. | Pure speculation cell — would be removed in a stricter framing. |

**Pattern in n=2 instruct vs n=1 reasoning** (Granite + Hermes go better
in classic; Gemma 4 goes better in composable): **plausibly suggests**
that the relevant axis is "model emits a deliberate reasoning step
before tool call" vs "model goes straight to tool emission". But size
is **confounded** with reasoning in this dataset (see caveat above) —
so this pattern is a **hypothesis to test**, not a recommendation to
ship. The honest summary right now is:

> *On the 3 chain queries we measured, Granite + classic + smart-bash is
> the best cost/correctness combination ($0.000016/query). Gemma 4 +
> composable + smart-bash ran more efficiently on the same chains
> (-50% tokens) but at higher absolute cost due to Gemma's per-token
> price. Beyond these two data points, we don't know.*

Three concrete ways to strengthen any row above:

1. Run `SUITE=full` (the 20-query corpus in `client/eval-suite.ts`)
   against each model — fills the chain-multi, error, and ambiguous
   buckets that today have no per-model data.
2. Add `model_overrides` blocks for Llama 3.1 8B and Gemma 4 (today
   only Hermes has them) and re-measure to see if the gap closes.
3. Run an ablation isolating smart-bash's contribution from the
   schema-gateway: classic+raw vs classic+smart in at least 2 models
   (currently 0).



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
at `mcp-server.ts` (composable) or `mcp-server-classic.ts` (classic),
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
$ node client/load-domain.ts https://img.automators.work

══ https://img.automators.work ═════════════════════════════════
llms.txt:  https://img.automators.work/llms.txt
Skills:    1

══ placeholder v1.0.0 ══════════════════════════════════════════
description: Generate SVG placeholder images for UI mockups via the placeholder-img HTTP API.
source:      https://img.automators.work/skills/placeholder/SKILL.md
license:     MIT
homepage:    https://img.automators.work
body:        2872 chars

$ node client/load-domain.ts https://docs.anthropic.com

══ https://docs.anthropic.com ══════════════════════════════════
llms.txt:  https://docs.anthropic.com/llms.txt
Skills:    0

No `## Skills` section found in llms.txt at https://docs.anthropic.com/llms.txt.
See https://github.com/AnswerDotAI/llms-txt/issues/116 for the proposed format.
```

The loader (`client/llms-txt-loader.ts`) implements RFC §2.1 (parsing) and
§2.3 steps 1-4 (discovery + surfacing). Steps 5-7 (user opt-in, load,
cache) belong to the agent host that consumes the loader's output.

It also handles:

- Cross-origin `SKILL.md` URLs (RFC §2.1 rule 5)
- Optional inline metadata (`<!-- skill: {"version":"…", "sha256":"…"} -->`)
- sha256 verification when declared (RFC §2.2)
- Graceful skip of `.zip` / `.tar.gz` archives (out of scope for v1)
- Negative path: domains without `## Skills` get a friendly hint pointing
  to the proposal issue, evangelizing adoption while degrading cleanly

## The current registry

Six skills live in `registry/skills/`, each one a TypeScript handler
behind a `tool.yaml` contract:

| Skill | API wrapped | Demonstrates |
|---|---|---|
| `echo-pretty` | (none — pure text transform) | Trusted-execution path, no network |
| `ip-info` | `api.country.is` | Network gating, defensive arg handling, model_overrides |
| `url2md` | `url2md.automators.work` | Auto-recovery (422 → retry with raw=1), structured response |
| `github-repo-info` | `api.github.com` | Optional auth via requiredEnv, response trimming (~5KB → ~200B) |
| `weather` | `api.open-meteo.com` | Numeric coord validation, projection of nested upstream JSON |
| `dictionary` | `api.dictionaryapi.dev` | Nested array output (meanings[]), input format validation |

Each skill is ≤100 lines of TS. All wrap public APIs directly — no
vendor MCP servers. The full registry serves from jsDelivr at
`https://cdn.jsdelivr.net/gh/MauricioPerera/agentic-tools-poc@dist/manifest.json`
in ~150ms cold, sub-ms warm via Cache API.

`npm run smoke` runs every skill against its real upstream API as a
sanity check (network-dependent, not part of `npm run all`).

### Per-skill version pinning

The default load picks the latest version of every skill (current
behaviour, no API change). Consumers that want to lock a specific skill
at a known-good version pass a `pin` map:

```ts
import { loadRegistry } from 'agentic-tools-poc/client/loader';

const { manifest, commands } = await loadRegistry({
  pin: {
    'echo-pretty': '^1.0.0',     // accept any 1.x
    'url2md':      '~1.2.0',     // patches only — refuse 1.3.0
    'ip-info':     '1.1.0',      // exact match
    'weather':     'latest',     // explicit latest (same as omitting the entry)
  },
});
```

Range syntax follows the npm subset listed in `client/semver-pin.ts`:
`X.Y.Z` (exact), `^X.Y.Z` (compat with X.Y.Z, locks the major), `~X.Y.Z`
(only patches, locks the minor), `*` / `latest` (any).

How it works under the hood:

- `manifest.json` carries a `tools[].versions[]` array of every archived
  release, sorted highest-first, each with its own `sha256`.
- The loader resolves the pin against `versions[]`, fetches
  `skills/<slug>@<version>.mjs`, and verifies its sha256 against the
  versioned entry — not against the latest's. Different pins for the
  same skill across two `loadRegistry()` calls have isolated caches.
- The build pipeline copies each new release into
  `dist/skills/<slug>@<version>.mjs` and refuses to publish if a bundle
  changes without bumping `tool.yaml.version` (the bump-without-bump
  guard). Old archive files are preserved on the `dist` branch
  indefinitely — bundles are tiny (the full registry is ~5 KB), so
  retention costs nothing.

Pin errors surface at exec time with actionable messages:

```
$ MODEL=... node client/agent.ts
echoer: pin error: echoer pinned to "^2.0.0" but no archived version matches.
        Available: 1.1.0, 1.0.0.
```

If a pinned skill lives in a manifest that predates per-skill versioning
(no `versions[]`), the loader fails fast with a migration hint.

## Type generation from tool.yaml

`npm run codegen` reads each `registry/skills/<slug>/tool.yaml` and emits
`registry/skills/<slug>/src/types.gen.ts` containing TypeScript `Input` and
`Output` interfaces derived directly from the JSONSchema. The handler imports
those types instead of redeclaring them:

```typescript
// registry/skills/ip-info/src/index.ts
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';   // ← generated

const handler: SkillHandler<Input, Output> = async (input, ctx) => { … };
```

The generated file shows JSDoc descriptions inline:

```typescript
// registry/skills/ip-info/src/types.gen.ts (auto-generated)
export interface Input {
  /** IP to look up. Empty string (default) → caller's public IP. */
  ip?: string;
}

export interface Output {
  ip?: string;
  /** ISO 3166-1 alpha-2 country code */
  country?: string;
}
```

`tool.yaml` is now the **single source of truth** for the contract.
Modifying the schema regenerates the types; if a handler stops matching,
the TS compiler fails. The previous risk — "I changed `inputSchema` but
forgot to update the handler's `interface Input`" — is impossible.

CI runs `npm run codegen:check`, which regenerates and diffs against the
committed files. A stale generated file (someone changed the YAML but
forgot to run codegen) fails the build:

```
✗ ip-info: types.gen.ts is out of date with tool.yaml
1 skill(s) have stale generated types. Run `npm run codegen`.
```

The converter (`client/jsonschema-to-ts.ts`, ~50 lines, zero deps) handles
the JSONSchema subset we use: primitives, enums (as union literals), arrays,
nested objects, optional vs required, and JSDoc comments from `description`.

## Skill linter

> **Methodology note**: every rule below started as a real model doing
> the wrong thing in a reproducible way, then got codified at the
> strongest enforcement layer it could credibly live at. That loop
> (empirical observation → codified test → ratcheted enforcement) is
> the spine of how this repo evolves; see
> [PHILOSOPHY.md → Methodology](./PHILOSOPHY.md#methodology--how-the-catalog-hardens-over-time)
> for the full account, including the runtime extension via the QuickJS
> sandbox.

`npm run lint` runs a semantic linter over every `tool.yaml` (and the
handler source under `src/`). Eight of the rules encode antipatterns
observed empirically when running real models against the registry — e.g.
optional fields without descriptions cause Hermes 7B to invent values.
The ninth (R9) is the one security rule: it scans the handler bundle for
imports that bypass the loader's curated `ctx`. Nine rules across three
severities:

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
| `forbidden-imports` | error | Handler imports `node:fs`, `node:child_process`, `node:net`, `node:vm`, etc. or reads `process.env` directly (THREAT-MODEL.md V2 partial — static check, defeats accidents and lazy bypass; runtime guarantee waits on QuickJS sandbox) |

`npm run lint` exits non-zero on errors (warnings + info don't block).
`npm run lint -- --all` shows info-severity suggestions too.

The linter found one warning on the existing registry (`ip-info.ip` was
optional without an explicit default) which has been fixed; one info
finding remains (`echo-pretty` has 3 optional fields and no
`model_overrides`, suggesting per-model tuning may be worthwhile).
R9 catches zero findings on the current registry — handlers use only
`globalThis.fetch` and types — but the rule fires immediately on a PR
that imports `node:fs` (regression test in `test/skill-linter.test.ts`).

## Status

Source-of-truth + execution
- ✅ **Phase 2 sandboxed execution via QuickJS** (`client/sandbox.ts`,
   uses `quickjs-emscripten`). Handlers run inside a WASM-isolated VM
   with no Node API surface — `node:fs` is undefined, `process` is
   undefined, `globalThis.fetch` is the bridge that goes through
   `ctx.fetch` on the host (allowlist-gated). Interrupt handler kills
   runaway loops at the configured deadline. Performance: 134 ms cold
   start (one-time WASM init), 7.7 ms warm avg per call.
- ✅ Trust-mode escape hatch (`LOADER_MODE=trust`) for local debugging
   only; production / MCP servers default to sandbox.
- ✅ TypeScript end-to-end (handlers, scripts, tests; strict mode)
- ✅ Codegen: `tool.yaml` → `src/types.gen.ts` (handlers import generated types)
- ✅ Drift detection: `npm run codegen:check` gates CI
- ✅ **Bundle integrity: per-bundle sha256 in `manifest.json`, verified by
   loader before sandboxing** (see [THREAT-MODEL.md](./THREAT-MODEL.md) V1)

Runtime
- ✅ Composable MCP server (one `bash` tool + `tool_schema` introspection)
- ✅ Classic MCP server (one MCP tool per registry skill)
- ✅ smart-bash observation contract: schema, jq_paths, 5 pattern-matched
   diagnostics + fallback for unmatched stderr, required-field validation
- ✅ Per-model overrides (`model_overrides.<model>` rescues small models;
   `system_prompt_fragments` aggregates across skills)
- ✅ `model-adapter.ts` normalizes Workers AI shapes — OpenAI-style
   (Granite, Gemma), Hermes-style (Hermes, Llama 3.1 8B fp8), and Qwen
   `response: {name, arguments}` object shape
- ✅ Loader supports `https://`, `file://`, and bare paths
- ✅ `pricing.ts` — per-model $/M in/out from Cloudflare's live catalog,
   `compare.ts` reports input/output split + USD cost per query

Quality
- ✅ 290 tests (`node:test`, zero extra deps)
   — unit tests for every parser, converter, and lint rule
   — 18 MCP wire-format integration tests (spawn server subprocess)
   — codegen drift integration test (catches stale generated types in CI)
   — loader-integrity integration test (3 cases: clean, tampered, no-sha)
   — model-adapter test for every Workers AI response shape
   — pricing math + cost-formatting tests
   — V5 untrusted-output suite: ANSI strip, control-char strip, cap math,
     wrapper format, slug-aware lookup, XML-attr injection guard
   — **sandbox suite (14 tests)**: parity for all 6 shipped skills inside
     QuickJS, security boundary (node:fs undefined, process undefined,
     env-leak, infinite-loop interrupt, network policy), bridge
     correctness (ctx.log, error propagation, non-JSON return)
   — **versioning suite (27 tests)**: semver-pin range matching
     (^/~/exact/*), loader pin resolution end-to-end, manifest builder
     bump-without-bump detection, archive preservation across rebuilds
- ✅ Skill linter with 9 semantic rules derived from the empirical A/B
   (8 shape + 1 security: `forbidden-imports` blocks `node:fs`,
   `node:child_process`, `process.env`, etc. — defence-in-depth with the
   sandbox), 36 unit tests
- ✅ smoke-test-skills.ts hits live upstream APIs (5/5 passing today)

Distribution
- ✅ `dist/` published to a dedicated `dist` branch by CI; jsDelivr serves
   it directly. `main` stays free of generated artefacts.
- ✅ `.gitattributes` normalizes line endings (LF) so Windows contributors
   stop producing CRLF/LF churn
- ✅ **Per-skill versioning**: every release of a skill is archived as
   `dist/skills/<slug>@<version>.mjs` (preserved indefinitely on the
   `dist` branch). `manifest.json` exposes `tools[].versions[]` with the
   sha256 of each archive. Loader accepts a `pin` map
   (`loadRegistry({ pin: { 'echo-pretty': '^1.0.0' } })`) and resolves
   the highest matching version — verified against its own sha256, not
   the latest's. Build pipeline detects bundle-changed-without-version-
   bump and refuses to publish

Validated
- ✅ End-to-end against 5 Workers AI models: Granite 4.0 H Micro, Hermes
   2 Pro Mistral 7B, Llama 3.1 8B fp8, Gemma 4 26B-a4b-it, Qwen 2.5
   Coder 32B (3 queries × 2 modes per model — small N, see hedges in the
   recommendation matrix)
- ✅ Composable vs classic A/B with input/output token split + USD cost
   per query
- ✅ Per-model skill tuning rescues weak models (Hermes 1-3/6 → 5+/6)
- ✅ `client/llms-txt-loader.ts` — first independent consumer of the
   proposed `llms.txt ## Skills` extension
   ([Issue #116](https://github.com/AnswerDotAI/llms-txt/issues/116))
- ✅ `examples/` — real raw-vs-smart observation diffs, captured from
   `npm run exec` against the local registry

Security posture
- ✅ V1 (hostile bundle to dist branch): mitigated by sha256 + CI gates
- ✅ **V2 (malicious skill author): closed at runtime via QuickJS
   sandbox.** `import('node:fs')` returns undefined inside the VM;
   `process` is undefined; `globalThis.fetch` is the curated bridge
   that gates by `networkPolicy.allow`. Linter R9 `forbidden-imports`
   still runs at PR time as defence-in-depth. Interrupt handler kills
   handlers past `timeoutMs`. (Closes
   [#1](https://github.com/MauricioPerera/agentic-tools-poc/issues/1).)
- ✅ V3 (dependency confusion): `npm ci` + zero runtime deps in skills
- ⚠️ V4 (network attacker): TLS + sha256 protects bundles, manifest
   signing pending
- 🟡 V5 (prompt injection in skill output): **strawman shipped** —
   skill output wrapped in `<skill-output skill="X" trust="untrusted">`,
   per-skill `outputCap` (url2md → 4 KB), ANSI/control-char strip,
   system-prompt fragment teaches the model to treat wrapped content as
   data. Not full prompt-injection defense (open research problem) —
   raises cost of casual injection, bounds payload size, makes injection
   visible in traces

Not yet (with tracking issues)
- ⏭ Manifest signing (ed25519) — closes V4
- ⏭ Per-skill capability flags (`network`, `env`, future `crypto`) +
   memory cap per VM — Phase 3 hardening on top of the V2 sandbox
- ⏭ MCP `resources/` exposing tool READMEs as agent-readable docs
- ⏭ [#3](https://github.com/MauricioPerera/agentic-tools-poc/issues/3)
   Wider eval suite (N=3 → N=20+ across 6 buckets) — turns the cost
   matrix from "directional hypothesis" into "defendable recommendation"
- ⏭ Decide whether `outputSchema.required` should be enforced strictly
   in the codegen (today optional fields produce all-`?:` interfaces;
   tightening would catch more handler bugs at the cost of stricter
   skill authoring)
