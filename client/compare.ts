/**
 * compare.ts — runs the same set of queries against any Workers AI model in
 * both modes and prints a side-by-side cost / round / correctness table.
 *
 *   COMPOSABLE: model sees ONE `bash` tool. Composes via unix pipes.
 *   CLASSIC:    model sees N tools (one per registry tool). Function-calling.
 *
 * Both modes execute against the exact same underlying registry — the only
 * variable is the surface area the model is shown.
 *
 * Auth: CF_ACCOUNT_ID + CF_API_TOKEN (Workers AI scope) + REGISTRY (optional)
 *       + MODEL (optional, defaults to Granite 4.0 H Micro).
 */
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.ts';
import { makeObservation, lastPipelineStage } from './smart-bash.ts';
import { normalizeReply, tokensUsed, type TokenUsage } from './model-adapter.ts';
import { applyOverridesToManifest, getSystemPromptFragments } from './skill-tuning.ts';
import { parseToolCallArguments, inputToArgv, argvToShellCommand } from './arg-parser.ts';
import { computeCost, formatCost, getPricing } from './pricing.ts';
import {
  wrapUntrustedOutput,
  outputCapForSkill,
  UNTRUSTED_OUTPUT_FRAGMENT,
} from './untrusted-output.ts';
import { selectSuite, type Bucket, type Query } from './eval-suite.ts';
import type { ChatMessage, Manifest, NormalizedReply, ToolCall } from '../types/index.ts';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN   = process.env.CF_API_TOKEN;
const MODEL   = process.env.MODEL ?? process.env.GRANITE_MODEL ?? '@cf/ibm-granite/granite-4.0-h-micro';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 5);

if (!ACCOUNT || !TOKEN) {
  console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN env.');
  process.exit(2);
}

// Query corpus + bucket types live in client/eval-suite.ts so they're
// importable by structural tests without pulling in the model-call surface.
const SUITE = (process.env.SUITE ?? 'basic').toLowerCase();
const QUERIES = selectSuite(SUITE);
if (!QUERIES) {
  console.error(`! SUITE="${SUITE}" matched no queries. Use: basic | full | single | chain-2 | chain-multi | error | discipline | ambiguous.`);
  process.exit(2);
}

const { manifest: rawManifest, commands } = await loadRegistry({ registry: process.env.REGISTRY });
const manifest = applyOverridesToManifest(rawManifest, MODEL);
const promptFragments = getSystemPromptFragments(rawManifest, MODEL);
const bash = new Bash({ customCommands: commands as never });

const tuned = JSON.stringify(manifest) !== JSON.stringify(rawManifest);
const MODEL_PRICING = getPricing(MODEL);
console.log(`Model: ${MODEL}`);
console.log(`Skill tuning: ${tuned ? 'ON (model-specific overrides applied)' : 'OFF (default skill shape)'}`);
if (promptFragments.length) {
  console.log(`Prompt fragments: ${promptFragments.length} model-specific instruction(s) injected`);
}
if (MODEL_PRICING) {
  const beta = MODEL_PRICING.beta ? ' [BETA — currently free]' : '';
  console.log(
    `Pricing: $${MODEL_PRICING.inputPerMUSD}/M input, $${MODEL_PRICING.outputPerMUSD}/M output${beta}` +
    (MODEL_PRICING.notes ? ` (${MODEL_PRICING.notes})` : ''),
  );
}
console.log();

interface RunResult {
  rounds: number;
  /** Sum of usage.prompt_tokens across every round (or our estimate). */
  inputTokens: number;
  /** Sum of usage.completion_tokens across every round (or our estimate). */
  outputTokens: number;
  /** USD cost computed from per-model pricing × tokens. null if we don't price the model. */
  costUSD: number | null;
  /** True when usage.estimated was true on any round (Hermes beta). */
  anyEstimated: boolean;
  finalAnswer: string;
  /** Did the regex match? Says nothing about how the answer was produced. */
  correct: boolean;
  /** Number of tool_calls the model emitted across all rounds. 0 means the
   *  model answered without ever invoking a tool — disciplinarily distinct
   *  from "called the right tool and parsed the result", even if both pass
   *  the same expectation regex (e.g. Gemma Q1 used training knowledge). */
  toolCalls: number;
  /** Bucketed outcome: combines correctness with tool-use discipline.
   *   - 'via_tool'        — correct AND used at least one tool
   *   - 'without_tool'    — correct AND used zero tools (training-knowledge bypass)
   *   - 'wrong_with_tool' — wrong AND used at least one tool
   *   - 'wrong_no_tool'   — wrong AND used zero tools */
  outcome: 'via_tool' | 'without_tool' | 'wrong_with_tool' | 'wrong_no_tool';
}

interface RowResult {
  query: string;
  bucket: Bucket;
  expectNoTool: boolean;
  composable: RunResult;
  classic: RunResult;
}
const results: RowResult[] = [];

console.log(`Suite: ${SUITE} (${QUERIES.length} quer${QUERIES.length === 1 ? 'y' : 'ies'})`);

for (const q of QUERIES) {
  console.log(`\n${'='.repeat(70)}\n${q.id} [${q.bucket}]: ${q.text}\n${'='.repeat(70)}`);
  results.push({
    query: q.id,
    bucket: q.bucket,
    expectNoTool: q.expectNoTool ?? false,
    composable: await runComposable(q),
    classic:    await runClassic(q),
  });
}

// Pretty table — separate input/output and show $ cost so the cross-mode
// trade-off is honest. Composable typically ships less input but more
// output; classic is the opposite. With output usually 2-10× input price,
// the token-count alone hides which mode is actually cheaper.
// Outcome legend: ✓ via_tool / ◷ without_tool / ✗ wrong_with_tool / ✗⊘ wrong_no_tool.
// "Without_tool" is a separate marker because "answered correctly without
// invoking any tool" (training-knowledge bypass — Gemma did this on Q1)
// is disciplinarily different from "called the right tool and parsed the
// result", even though both pass the regex.
const OUTCOME_GLYPH: Record<RunResult['outcome'], string> = {
  via_tool:        '✓',
  without_tool:    '◷',
  wrong_with_tool: '✗',
  wrong_no_tool:   '✗⊘',
};

console.log(`\n${'═'.repeat(120)}\nSUMMARY (suite=${SUITE})\n${'═'.repeat(120)}`);
console.log('Bucket       | Query              | Mode       | Rounds | Calls |    In |   Out |   Total |    Cost  | Outcome      | Answer');
console.log('-------------|--------------------|------------|-------:|------:|------:|------:|--------:|---------:|--------------|---------');
let lastBucket: string | null = null;
for (const r of results) {
  // Insert a separator between buckets so the eye can group rows.
  if (r.bucket !== lastBucket) {
    if (lastBucket !== null) console.log('-'.repeat(120));
    lastBucket = r.bucket;
  }
  for (const mode of ['composable', 'classic'] as const) {
    const x = r[mode];
    const total = x.inputTokens + x.outputTokens;
    const cost = x.costUSD === null ? '   n/a' : formatCost(x.costUSD).padStart(9);
    // For discipline-bucket queries, swap glyph semantics: without_tool is
    // the desired outcome, via_tool is the discipline gap.
    const isDisciplined = r.expectNoTool
      ? (x.outcome === 'without_tool')
      : (x.outcome === 'via_tool');
    const baseGlyph = OUTCOME_GLYPH[x.outcome];
    const noteGlyph = r.expectNoTool && x.outcome === 'via_tool'
      ? '⚠'  // correct answer but reached for a tool unnecessarily
      : (r.expectNoTool && x.outcome === 'without_tool' ? '✓' : baseGlyph);
    const outcome = `${noteGlyph} ${x.outcome}${isDisciplined ? '' : ''}`.padEnd(13);
    console.log(
      `${r.bucket.padEnd(12)} | ${r.query.padEnd(18)} | ${mode.padEnd(10)} | ${String(x.rounds).padStart(6)} | ${String(x.toolCalls).padStart(5)} | ${String(x.inputTokens).padStart(5)} | ${String(x.outputTokens).padStart(5)} | ${String(total).padStart(7)} | ${cost} | ${outcome} | ${(x.finalAnswer || '').slice(0, 30)}`,
    );
  }
}
console.log(
  `\nLegend: ✓ disciplined outcome (via_tool for normal queries; without_tool for discipline-bucket)   ` +
  `⚠ tool used when training-knowledge would suffice (discipline bucket only)   ` +
  `✗ wrong answer.`,
);

interface ModeTotals {
  rounds: number; input: number; output: number; cost: number;
  via_tool: number; without_tool: number; wrong_with_tool: number; wrong_no_tool: number;
}
function emptyTotals(): ModeTotals {
  return { rounds: 0, input: 0, output: 0, cost: 0,
    via_tool: 0, without_tool: 0, wrong_with_tool: 0, wrong_no_tool: 0 };
}
function accumulate(acc: ModeTotals, r: RunResult): ModeTotals {
  return {
    rounds: acc.rounds + r.rounds,
    input:  acc.input  + r.inputTokens,
    output: acc.output + r.outputTokens,
    cost:   acc.cost   + (r.costUSD ?? 0),
    via_tool:        acc.via_tool        + (r.outcome === 'via_tool' ? 1 : 0),
    without_tool:    acc.without_tool    + (r.outcome === 'without_tool' ? 1 : 0),
    wrong_with_tool: acc.wrong_with_tool + (r.outcome === 'wrong_with_tool' ? 1 : 0),
    wrong_no_tool:   acc.wrong_no_tool   + (r.outcome === 'wrong_no_tool' ? 1 : 0),
  };
}
const totals = results.reduce<{ composable: ModeTotals; classic: ModeTotals }>(
  (acc, r) => ({
    composable: accumulate(acc.composable, r.composable),
    classic:    accumulate(acc.classic,    r.classic),
  }),
  { composable: emptyTotals(), classic: emptyTotals() },
);

console.log('\nTotals:');
for (const mode of ['composable', 'classic'] as const) {
  const t = totals[mode];
  const total = t.input + t.output;
  const cost = MODEL_PRICING ? formatCost(t.cost) : 'n/a';
  const correctAny = t.via_tool + t.without_tool;
  console.log(
    `  ${mode.padEnd(10)}  rounds=${t.rounds}  in=${t.input}  out=${t.output}  total=${total}  cost=${cost}  ` +
    `correct=${correctAny}/${results.length} (via_tool=${t.via_tool}, without_tool=${t.without_tool})  ` +
    `wrong=${t.wrong_with_tool + t.wrong_no_tool}`,
  );
}

// ─── Per-bucket pass-rate breakdown ────────────────────────────────────────
// "Pass" depends on the bucket's expectation:
//   - normal buckets: outcome === 'via_tool' (correct AND used a tool)
//   - discipline bucket: outcome === 'without_tool' (correct AND no tool used)
// Anything else is a fail of some kind (wrong, or right-but-undisciplined).

interface BucketScore {
  bucket: Bucket;
  total: number;
  composablePass: number;
  classicPass: number;
}

function isDisciplinedFor(r: RowResult, mode: 'composable' | 'classic'): boolean {
  const outcome = r[mode].outcome;
  return r.expectNoTool ? outcome === 'without_tool' : outcome === 'via_tool';
}

const bucketOrder: Bucket[] = ['single', 'chain-2', 'chain-multi', 'error', 'discipline', 'ambiguous'];
const bucketScores: BucketScore[] = bucketOrder
  .map<BucketScore | null>((bucket) => {
    const rows = results.filter((r) => r.bucket === bucket);
    if (rows.length === 0) return null;
    return {
      bucket,
      total: rows.length,
      composablePass: rows.filter((r) => isDisciplinedFor(r, 'composable')).length,
      classicPass:    rows.filter((r) => isDisciplinedFor(r, 'classic')).length,
    };
  })
  .filter((s): s is BucketScore => s !== null);

if (bucketScores.length > 1) {
  console.log('\nPer-bucket pass rate (disciplined outcome — see legend above):');
  console.log('Bucket       | Composable     | Classic        | Notes');
  console.log('-------------|----------------|----------------|----------------------------------');
  for (const s of bucketScores) {
    const cPct = ((s.composablePass / s.total) * 100).toFixed(0).padStart(3);
    const kPct = ((s.classicPass    / s.total) * 100).toFixed(0).padStart(3);
    const note = s.bucket === 'discipline'
      ? 'pass = answered WITHOUT calling a tool'
      : 'pass = answered VIA a tool';
    console.log(
      `${s.bucket.padEnd(12)} | ${String(s.composablePass).padStart(2)}/${s.total} (${cPct}%)    ` +
      `| ${String(s.classicPass).padStart(2)}/${s.total} (${kPct}%)    | ${note}`,
    );
  }
}

const anyEstimated = results.some((r) => r.composable.anyEstimated || r.classic.anyEstimated);
if (anyEstimated) {
  console.log(`\n  Note: at least one round had no model-reported usage; values include the chars/4 estimate.`);
}
if (!MODEL_PRICING) {
  console.log(`\n  Note: pricing for "${MODEL}" not in client/pricing.ts table — cost columns omitted.`);
}

// ────────────────────────────────────────────────────────────────────────────

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
type ExecFn = (tc: ToolCall) => Promise<unknown>;

async function runComposable(q: Query): Promise<RunResult> {
  const toolList = manifest.tools
    .map((t) => `- ${t.slug}: ${t.summary}. Output schema: ${JSON.stringify(t.outputSchema ?? {})}`)
    .join('\n');

  const baseSystem =
    `You have a single tool: \`bash\`. Compose registry commands with unix pipes.\n\n` +
    `Available registry commands inside bash:\n${toolList}\n\n` +
    `Standard tools also available: jq, grep, sed, awk, xargs, head, wc, tr.\n` +
    `Always use bash to act; never answer from training knowledge for live data. Be terse.\n` +
    `Tool observations include tools_referenced (output_schema, example, jq_paths) ` +
    `and diagnostics. Read them to fix mistakes.\n` +
    UNTRUSTED_OUTPUT_FRAGMENT;

  const messages: ChatMessage[] = [
    { role: 'system', content: appendFragments(baseSystem, promptFragments) },
    { role: 'user', content: q.text },
  ];
  const tools: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a bash command and return its output.',
        parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'The bash command line.' } } },
      },
    },
  ];

  return runLoop(messages, tools, q, async (tc) => {
    const args = parseToolCallArguments(tc.function.arguments);
    const cmd = String(args['command'] ?? '');
    console.log(`  [composable] bash → ${cmd}`);
    const result = await bash.exec(cmd);
    const obs = makeObservation(cmd, result as { stdout: string; stderr: string; exitCode: number }, manifest);

    // V5 strawman: if the pipeline ends in a registry tool, the stdout
    // is untrusted skill output. Wrap it before it lands in the LLM
    // context. Non-registry pipelines (pure jq/grep) skip wrapping —
    // those produce data shaped by the agent itself.
    const lastStage = lastPipelineStage(cmd);
    const lastSlug = manifest.tools.find(
      (t) => lastStage === t.slug || lastStage?.startsWith(t.slug + ' '),
    )?.slug ?? null;
    if (lastSlug && obs.stdout) {
      const cap = outputCapForSkill(lastSlug, manifest.tools);
      obs.stdout = wrapUntrustedOutput(obs.stdout, { slug: lastSlug, outputCap: cap });
    }
    return obs;
  });
}

async function runClassic(q: Query): Promise<RunResult> {
  const toolDefs: ToolDef[] = manifest.tools.map((t) => ({
    type: 'function',
    function: { name: t.slug, description: t.summary, parameters: t.inputSchema },
  }));

  const baseSystem =
    `You have ${manifest.tools.length} tool(s). Call them as needed.\n` +
    `Always use the tools to act; never answer from training knowledge for live data. Be terse.\n` +
    UNTRUSTED_OUTPUT_FRAGMENT;

  const messages: ChatMessage[] = [
    { role: 'system', content: appendFragments(baseSystem, promptFragments) },
    { role: 'user', content: q.text },
  ];

  return runLoop(messages, toolDefs, q, async (tc) => {
    const tool = manifest.tools.find((t) => t.slug === tc.function.name);
    if (!tool) return { error: `unknown tool: ${tc.function.name}` };
    const args = parseToolCallArguments(tc.function.arguments);
    const cmd = `${tool.slug} ${argvToShellCommand(inputToArgv(args))}`.trim();
    console.log(`  [classic] ${tc.function.name} ${JSON.stringify(args)}`);
    const result = await bash.exec(cmd);
    // Classic mode: every call lands directly on a registry skill, so the
    // stdout is always untrusted output. Apply V5 wrapping unconditionally.
    let stdout = (result.stdout ?? '').trim();
    if (stdout) {
      stdout = wrapUntrustedOutput(stdout, {
        slug: tool.slug,
        outputCap: tool.outputCap,
      });
    }
    return {
      stdout,
      stderr: (result.stderr ?? '').trim(),
      exitCode: result.exitCode,
    };
  });
}

function classifyOutcome(correct: boolean, toolCalls: number): RunResult['outcome'] {
  if (correct && toolCalls > 0) return 'via_tool';
  if (correct) return 'without_tool';
  if (toolCalls > 0) return 'wrong_with_tool';
  return 'wrong_no_tool';
}

async function runLoop(
  messages: ChatMessage[],
  tools: ToolDef[],
  q: Query,
  execTool: ExecFn,
): Promise<RunResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let anyEstimated = false;
  let toolCalls = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const raw = await callModel(messages, tools);
    const reply = normalizeReply(raw, MODEL);
    const usage: TokenUsage = tokensUsed(reply, messages, tools);
    inputTokens  += usage.input;
    outputTokens += usage.output;
    if (usage.estimated) anyEstimated = true;

    messages.push({
      role: 'assistant',
      content: reply.content,
      ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls } : {}),
    });

    if (reply.tool_calls.length) {
      toolCalls += reply.tool_calls.length;
      for (const tc of reply.tool_calls) {
        const obs = await execTool(tc);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(obs) });
      }
      continue;
    }

    const finalAnswer = reply.content.trim();
    const correct = q.expect.test(finalAnswer);
    return {
      rounds: round,
      inputTokens, outputTokens,
      costUSD: MODEL_PRICING ? computeCost(inputTokens, outputTokens, MODEL_PRICING) : null,
      anyEstimated,
      finalAnswer,
      correct,
      toolCalls,
      outcome: classifyOutcome(correct, toolCalls),
    };
  }
  return {
    rounds: MAX_ROUNDS,
    inputTokens, outputTokens,
    costUSD: MODEL_PRICING ? computeCost(inputTokens, outputTokens, MODEL_PRICING) : null,
    anyEstimated,
    finalAnswer: '(no convergence)',
    correct: false,
    toolCalls,
    outcome: classifyOutcome(false, toolCalls),
  };
}

async function callModel(messages: ChatMessage[], tools: ToolDef[]): Promise<Parameters<typeof normalizeReply>[0]> {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools, max_tokens: 256, temperature: 0.1 }),
    },
  );
  if (!r.ok) throw new Error(`CF API ${r.status}: ${await r.text()}`);
  const env = (await r.json()) as { success: boolean; result: Parameters<typeof normalizeReply>[0]; errors: unknown };
  if (!env.success) throw new Error(JSON.stringify(env.errors));
  return env.result;
}

/** Append per-model prompt fragments to a base system prompt, if any. */
function appendFragments(base: string, fragments: string[]): string {
  if (!fragments?.length) return base;
  return `${base}\n\nMODEL-SPECIFIC INSTRUCTIONS:\n${fragments.map((f) => '- ' + f).join('\n')}`;
}

// Suppress "Manifest unused" hint when using only types
void (null as Manifest | null);
