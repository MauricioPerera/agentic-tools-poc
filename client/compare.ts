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
import { makeObservation } from './smart-bash.ts';
import { normalizeReply, tokensUsed, type TokenUsage } from './model-adapter.ts';
import { applyOverridesToManifest, getSystemPromptFragments } from './skill-tuning.ts';
import { parseToolCallArguments, inputToArgv, argvToShellCommand } from './arg-parser.ts';
import { computeCost, formatCost, getPricing } from './pricing.ts';
import type { ChatMessage, Manifest, NormalizedReply, ToolCall } from '../types/index.ts';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN   = process.env.CF_API_TOKEN;
const MODEL   = process.env.MODEL ?? process.env.GRANITE_MODEL ?? '@cf/ibm-granite/granite-4.0-h-micro';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 5);

if (!ACCOUNT || !TOKEN) {
  console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN env.');
  process.exit(2);
}

interface Query {
  id: string;
  text: string;
  expect: RegExp;
}

const QUERIES: Query[] = [
  {
    id: 'Q1-simple',
    text: "Convert 'agentic tools poc' to uppercase. Reply with just the result.",
    expect: /AGENTIC TOOLS POC/,
  },
  {
    id: 'Q2-extract',
    text: 'What ISO country code am I currently in? Reply with just the 2-letter code.',
    expect: /^[A-Z]{2}$/m,
  },
  {
    id: 'Q3-chain',
    text: "Get my country code, then echo it back uppercased with prefix 'YOU ARE IN: '. Reply with just the result.",
    expect: /YOU ARE IN: [A-Z]{2}/,
  },
];

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
  correct: boolean;
}

const results: Array<{ query: string; composable: RunResult; classic: RunResult }> = [];

for (const q of QUERIES) {
  console.log(`\n${'='.repeat(70)}\n${q.id}: ${q.text}\n${'='.repeat(70)}`);
  results.push({
    query: q.id,
    composable: await runComposable(q),
    classic:    await runClassic(q),
  });
}

// Pretty table — separate input/output and show $ cost so the cross-mode
// trade-off is honest. Composable typically ships less input but more
// output; classic is the opposite. With output usually 2-10× input price,
// the token-count alone hides which mode is actually cheaper.
console.log(`\n${'═'.repeat(96)}\nSUMMARY\n${'═'.repeat(96)}`);
console.log('Query        | Mode       | Rounds |    In |   Out |   Total |    Cost  | ✓ | Answer');
console.log('-------------|------------|-------:|------:|------:|--------:|---------:|---|---------');
for (const r of results) {
  for (const mode of ['composable', 'classic'] as const) {
    const x = r[mode];
    const total = x.inputTokens + x.outputTokens;
    const cost = x.costUSD === null ? '   n/a' : formatCost(x.costUSD).padStart(9);
    console.log(
      `${r.query.padEnd(12)} | ${mode.padEnd(10)} | ${String(x.rounds).padStart(6)} | ${String(x.inputTokens).padStart(5)} | ${String(x.outputTokens).padStart(5)} | ${String(total).padStart(7)} | ${cost} | ${x.correct ? '✓' : '✗'} | ${(x.finalAnswer || '').slice(0, 30)}`,
    );
  }
}

interface ModeTotals { rounds: number; input: number; output: number; cost: number; ok: number; }
const totals = results.reduce<{ composable: ModeTotals; classic: ModeTotals }>(
  (acc, r) => ({
    composable: {
      rounds: acc.composable.rounds + r.composable.rounds,
      input:  acc.composable.input  + r.composable.inputTokens,
      output: acc.composable.output + r.composable.outputTokens,
      cost:   acc.composable.cost   + (r.composable.costUSD ?? 0),
      ok:     acc.composable.ok     + (r.composable.correct ? 1 : 0),
    },
    classic: {
      rounds: acc.classic.rounds + r.classic.rounds,
      input:  acc.classic.input  + r.classic.inputTokens,
      output: acc.classic.output + r.classic.outputTokens,
      cost:   acc.classic.cost   + (r.classic.costUSD ?? 0),
      ok:     acc.classic.ok     + (r.classic.correct ? 1 : 0),
    },
  }),
  {
    composable: { rounds: 0, input: 0, output: 0, cost: 0, ok: 0 },
    classic:    { rounds: 0, input: 0, output: 0, cost: 0, ok: 0 },
  },
);

console.log('\nTotals:');
for (const mode of ['composable', 'classic'] as const) {
  const t = totals[mode];
  const total = t.input + t.output;
  const cost = MODEL_PRICING ? formatCost(t.cost) : 'n/a';
  console.log(
    `  ${mode.padEnd(10)}  rounds=${t.rounds}  in=${t.input}  out=${t.output}  total=${total}  cost=${cost}  correct=${t.ok}/${results.length}`,
  );
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
    `and diagnostics. Read them to fix mistakes.`;

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
    return makeObservation(cmd, result as { stdout: string; stderr: string; exitCode: number }, manifest);
  });
}

async function runClassic(q: Query): Promise<RunResult> {
  const toolDefs: ToolDef[] = manifest.tools.map((t) => ({
    type: 'function',
    function: { name: t.slug, description: t.summary, parameters: t.inputSchema },
  }));

  const baseSystem =
    `You have ${manifest.tools.length} tool(s). Call them as needed.\n` +
    `Always use the tools to act; never answer from training knowledge for live data. Be terse.`;

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
    return {
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      exitCode: result.exitCode,
    };
  });
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
      for (const tc of reply.tool_calls) {
        const obs = await execTool(tc);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(obs) });
      }
      continue;
    }

    const finalAnswer = reply.content.trim();
    return {
      rounds: round,
      inputTokens, outputTokens,
      costUSD: MODEL_PRICING ? computeCost(inputTokens, outputTokens, MODEL_PRICING) : null,
      anyEstimated,
      finalAnswer,
      correct: q.expect.test(finalAnswer),
    };
  }
  return {
    rounds: MAX_ROUNDS,
    inputTokens, outputTokens,
    costUSD: MODEL_PRICING ? computeCost(inputTokens, outputTokens, MODEL_PRICING) : null,
    anyEstimated,
    finalAnswer: '(no convergence)',
    correct: false,
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
