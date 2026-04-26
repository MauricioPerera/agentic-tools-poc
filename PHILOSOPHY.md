# Philosophy

This project rests on a single architectural claim:

> **Agent capabilities are skills, not tools.**

The distinction is structural, not semantic, and it has consequences for how
you build, distribute, and own agent functionality. This document explains
the reasoning, the evidence, and what it prescribes.

## TL;DR

- A *tool* is an external object granted to a model: a function signature,
  maintained by someone else.
- A *skill* is an internal capability owned by the agent's author: function
  + context + model-specific tuning + recovery patterns + meta-knowledge,
  all under one roof.
- Vendor MCP servers expose tools. They are *recommendations* about how to
  consume an underlying API, packaged as runtime infrastructure.
- For agents that care about cost, quality, or longevity, ownership of the
  skill catalog wins. The vendor maintains the API; you maintain how your
  agent consumes it.

## The reframe: tool vs skill

Most of the AI tooling vocabulary talks about *tools*: discrete functions
a model can call. The metaphor is a hardware store — interchangeable parts
you pick up when needed. Pick up a hammer when you need to drive a nail.

But that's not what an agent capability actually is. A working capability
includes:

1. The function itself
2. The judgment of when to apply it
3. The model-specific tuning that makes it actually work
4. The recovery patterns when something goes wrong
5. The meta-knowledge of how it composes with others

Only item (1) fits the hardware-store metaphor. Items (2)–(5) are knowledge
embedded in *whoever owns the agent*. When all five live together as one
artifact, that artifact is no longer a tool. It is a **skill**.

| | Tool | Skill |
|---|---|---|
| Ownership | External | Internal |
| Composition | A function signature | Function + context + tuning + recovery + meta |
| Specialization | Generic ("works for any model") | Specific (this model, this use case) |
| Maintenance | Third party | Agent's author |
| Metaphor | "You have access to a hammer" | "You know how to frame a wall" |

This isn't gymnastics. It's an ontological distinction. A tool is an
*object* (separate from its user). A skill is a *property* (part of its
bearer).

## The five layers of a skill

What makes a skill more than a tool, layer by layer:

### 1. The function

What the skill does. Inputs, outputs, side effects. JSONSchema lives here.
This is the only layer a tool definition contains.

### 2. The context

When to apply the skill. Preconditions. Guarantees. The kinds of question
this answers. A skill knows it's the right answer for *"what country am I
in"* but not for *"what is the capital of Spain"* (which is training
knowledge, no skill needed).

### 3. The model-specific tuning

A 3.4B model needs descriptions with concrete examples and explicit flags.
A frontier model needs almost nothing — just the shape. The same
underlying capability exposes differently per model class. Tools are
written once for "any model"; skills carry their per-model specialization.

### 4. The recovery

When the skill fails, what does the failure communicate back to the model?
`jq: parse error: Cannot index string` is a tool's failure mode.
*"Upstream tool returns flat {ip, country}; use `.country` not
`.ip.country`"* is a skill's. The skill knows how to teach the model on
the way back up.

### 5. The meta-knowledge

How does this skill compose with others? What pipeline patterns are
idiomatic? What are the antipatterns? A skill catalog includes this; a
tool catalog rarely does.

## Why this matters now

Two forces are converging:

**Open-weights models are useful but fragile.** Granite 4.0 H Micro can
drive an agent for $0 on the Workers AI free tier — but only if its
capabilities come with the four extra layers. Without them, it
hallucinates, drops required arguments, or misreads outputs.

**The MCP marketplace is forming.** Vendors are racing to publish servers.
Each is presented as an interchangeable component. But agent capabilities
aren't interchangeable: they encode opinions about flow, granularity,
response shape, and acceptable failure modes. Those opinions should belong
to whoever builds the agent, not whoever provides the underlying API.

Together: **small models + ownership of skills wins economically and
qualitatively**. Large models + dependence on third-party tools loses on
cost; small models + dependence on third-party tools loses on quality.

## Three axioms about MCP servers

We can be precise about what an MCP server is, structurally:

### Axiom 1 — Every MCP server has an API underneath

The MCP code itself proves the endpoint exists (HTTP, RPC, SDK call, local
function). There is never a case where "only the MCP exists" — there is
always a layer below it that the MCP wraps. The MCP is therefore never the
*only* way to consume the service; it is one packaging of the consumption.

### Axiom 2 — An MCP tool is a curated workflow, not a single endpoint

`create_invoice_for_customer` is probably 4-5 API calls + business logic
+ response formatting. The packaging into one "tool" is what makes it
safe and ergonomic for an LLM. Without that curation the model would have
to orchestrate the raw API itself, which is slow, costly, and dangerous.

### Axiom 3 — The curation is opinion frozen into infrastructure

The vendor decided which calls to bundle, in what order, with which
defaults, returning which fields. That's their judgment. If you accept the
MCP server as a runtime dependency, you accept their judgment.

**Conclusion**: an MCP server from a vendor is *a recommendation about how
to consume their API, packaged as infrastructure*. It is reusable code
(like an SDK or an examples folder), not load-bearing infrastructure for
your agent. Treat it like you would treat any vendor's `examples/`
directory: useful as a starting point, not as a production dependency.

## What this prescribes

If you build agents with intent (not just prototypes), the architecture
should look like this:

```
APIs (the actual contracts, owned by vendors)
        ↓
Your skill registry (TS wrappers, owned by you, in your repo)
        ↓
Your runtime (composable bash + smart observations / classic / hybrid)
        ↓
Your agent (Granite / Llama / Claude / etc.)
```

Where:

- The vendor maintains the API. That is their responsibility.
- You maintain how your agent consumes that API. That is your
  responsibility.
- Vendor MCP servers, when they exist and when they help, are reference
  implementations you can fork into your registry — not runtime
  dependencies.

This inverts the usual stance. The default question becomes *"what skill
do I need?"* rather than *"what MCP server is available?"*. Skills are
first-class; MCP is one of several transport options for exposing them.

## Where vendor MCP servers do help

To be honest about it: there are real cases.

- **OAuth flows where the vendor handles refresh + session.**
  Reimplementing this per-vendor is real work.
- **APIs that aren't publicly documented but the vendor publishes an MCP.**
  Your only path.
- **Five-minute prototypes.** Speed beats ownership for throwaway code.
- **Highly standard tools** (e.g., filesystem, git, sqlite) where every
  consumer wants the same shape.

Outside these cases, the trade-off favors ownership.

## Evidence from this POC

We tested both modes against IBM Granite 4.0 H Micro on Workers AI
across three queries (see README → "Composable vs classic"):

| Mode | Rounds | Tokens | Correct |
|---|---:|---:|:---:|
| Composable (one `bash` skill, registry skills as commands) | 9 | 3779 | 3/3 |
| Classic (each skill exposed individually as MCP tool) | 7 | 2651 | 3/3 |

Classic won on this small model because JSONSchema validation acted as a
safety net against hallucinated commands and missing arguments. The
"intermediate values shouldn't cross the model boundary" thesis (which
favors composable) only holds when the model can reliably write the
composition. A 3.4B model can't, on chained tasks.

The point isn't that one mode wins universally — that depends on the
model. The point is: **we could measure this and tune accordingly because
we owned the skills**. With third-party MCP servers, we couldn't have run
this comparison, applied the `smart-bash` enrichment that made Granite
self-correct, or chosen between modes per task. The ownership unlocks
the optimization loop.

## Naming convention used in this repo

- **Skill** — a unit of capability owned by the agent's author. Lives in
  `registry/skills/<slug>/`. Includes the five layers above.
- **Tool** — used only when referring to the MCP protocol (where the
  word is fixed by the spec) or to function-calling APIs in general.
- **Workflow** — a skill that composes multiple API calls or other
  skills.
- **Registry** — the catalog of skills, distributed via GitHub +
  jsDelivr (or any CDN that serves a public Git repo).

If you're building on top of this project, prefer *skill* wherever you
mean an owned capability.

## What this project is and isn't

It is **not**:

- An "MCP alternative". MCP is a useful transport protocol, and we ship
  two MCP servers (composable + classic) as part of the runtime.
- A marketplace.
- A framework.
- An opinion about which model to use.

It is:

- An architecture for building, owning, and distributing the skill
  catalog of an agent — where each skill carries its function, context,
  per-model tuning, recovery patterns, and meta-knowledge as one
  artifact in your version-controlled repository.

## Related external work

This project converged independently on the same architectural posture as
two parallel proposals from the same author working from the **provider**
side of the same problem:

- **RFC: Publishing Agent Skills through `llms.txt`** —
  [img.automators.work/docs/rfc-skills-in-llms-txt.md](https://img.automators.work/docs/rfc-skills-in-llms-txt.md).
  Formalizes a `## Skills` section in `llms.txt` so any static site can
  declare which `SKILL.md` files an agent should load to interact with it.
  Argues the same case from the publisher angle: MCP is overkill for static
  sites; text files are sufficient; ownership of the consumption shape
  belongs to the agent author.
- **Issue #116** at AnswerDotAI/llms-txt —
  [github.com/AnswerDotAI/llms-txt/issues/116](https://github.com/AnswerDotAI/llms-txt/issues/116).
  The proposal upstream to the official llms.txt spec.

This repo is the **agent-side counterpart** of those two:

| Side | Concern | Artifact |
|---|---|---|
| Provider | "How do I declare what an agent can do with my site?" | RFC + Issue #116 |
| Consumer (us) | "How do I build an agent that owns its skill catalog and uses skills published this way?" | This repo |

`client/llms-txt-loader.ts` is the first independent consumer of the
proposed `## Skills` extension. Run `npm run discover <domain>` against
any compliant site to see discovery flow §2.3 in action.

## Further reading

- [README](./README.md) — usage, A/B benchmark numbers across **5 models**
  (Granite, Hermes, Gemma, Llama, Qwen-Coder), MCP host configuration,
  full repo layout.
- [THREAT-MODEL.md](./THREAT-MODEL.md) — honest answer to "what stops a
  malicious skill from compromising the host?". Documents V1–V5 attack
  vectors, current Phase 1 mitigations (sha256 integrity, network
  allowlist, code review), and the Phase 2 plan (manifest signing +
  QuickJS sandbox) that gates community contributions.
- [registry/skills/](./registry/skills/) — six skills demonstrating the
  five layers across diverse upstream APIs (echo-pretty, ip-info, url2md,
  github-repo-info, weather, dictionary).
- [client/smart-bash.ts](./client/smart-bash.ts) — the recovery layer
  in code: enriched observations (schema, jq_paths, diagnostics, required
  validation, fallback diagnostic when nothing else fires) that teach a
  small model how to self-correct.
- [client/model-adapter.ts](./client/model-adapter.ts) — normalises the
  three Workers AI response shapes (OpenAI-style, Hermes XML, Qwen
  `response.{name,arguments}` object) into a single `ToolCall` so the
  agent loop is shape-agnostic.
- [client/pricing.ts](./client/pricing.ts) — input/output token cost
  table from the Cloudflare catalog. Lets the A/B harness report USD per
  query, surfacing the 38× gap between Granite ($0.017/M in) and
  Qwen-Coder ($0.66/M in) that pure latency/quality numbers hide.
- [client/skill-tuning.ts](./client/skill-tuning.ts) — per-model overrides
  + `system_prompt_fragments` aggregation that rescue weak models
  without touching the underlying behaviour.
- [client/skill-linter.ts](./client/skill-linter.ts) — eight semantic
  rules derived from the empirical multi-model A/B; `npm run lint` runs
  them in CI.
- [client/loader.ts](./client/loader.ts) — registry loader with per-bundle
  sha256 verification (V1/V4 mitigation) + `file://` support so MCP
  integration tests don't need an HTTP server.
- [scripts/codegen-types.ts](./scripts/codegen-types.ts) +
  [client/jsonschema-to-ts.ts](./client/jsonschema-to-ts.ts) — closes
  the contract loop: `tool.yaml` is the single source of truth and
  `Input` / `Output` types are generated from it.
- [client/llms-txt-loader.ts](./client/llms-txt-loader.ts) — discovery of
  skills published via the proposed `## Skills` extension.
- [client/compare.ts](./client/compare.ts) — the measurement loop that
  ownership of the skill catalog enables.
- [examples/](./examples/) — five real raw-vs-smart observation diffs
  captured from live runs (clean success, schema-check rejection, jq
  recovery, missing-required diagnostic, classic-mode call shape).
- [test/](./test/) — 196 tests covering arg parsing, model adapters
  (all three shapes), loader integrity (sha256 tamper detection),
  smart-bash diagnostics, codegen drift, linter rules, and MCP
  wire-format integration suites that spawn the actual server
  subprocesses.
