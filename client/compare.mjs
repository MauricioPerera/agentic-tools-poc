/**
 * compare.mjs — runs the same set of queries against Granite in both modes
 * and prints a side-by-side cost / round / correctness table.
 *
 *   COMPOSABLE: model sees ONE `bash` tool. Composes via unix pipes.
 *   CLASSIC:    model sees N tools (one per registry tool). Function-calling.
 *
 * Both modes execute against the exact same underlying registry — the only
 * variable is the surface area the model is shown.
 *
 * Auth: CF_ACCOUNT_ID + CF_API_TOKEN (Workers AI scope) + REGISTRY (optional).
 */
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.mjs';
import { makeObservation } from './smart-bash.mjs';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN   = process.env.CF_API_TOKEN;
const MODEL   = process.env.GRANITE_MODEL ?? '@cf/ibm-granite/granite-4.0-h-micro';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 5);

if (!ACCOUNT || !TOKEN) { console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN env.'); process.exit(2); }

const QUERIES = [
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

const { manifest, commands } = await loadRegistry({ registry: process.env.REGISTRY });
const bash = new Bash({ customCommands: commands });

const results = [];
for (const q of QUERIES) {
  console.log(`\n${'='.repeat(70)}\n${q.id}: ${q.text}\n${'='.repeat(70)}`);
  results.push({
    query: q.id,
    composable: await runComposable(q),
    classic:    await runClassic(q),
  });
}

// Pretty table
console.log(`\n${'═'.repeat(78)}\nSUMMARY\n${'═'.repeat(78)}`);
console.log('Query        | Mode       | Rounds | Tokens | Correct | Final answer');
console.log('-------------|------------|-------:|-------:|---------|-------------------------');
for (const r of results) {
  for (const mode of ['composable', 'classic']) {
    const x = r[mode];
    console.log(
      `${r.query.padEnd(12)} | ${mode.padEnd(10)} | ${String(x.rounds).padStart(6)} | ${String(x.tokens).padStart(6)} | ${(x.correct ? '✓' : '✗').padEnd(7)} | ${(x.finalAnswer || '').slice(0, 30)}`
    );
  }
}

const totals = results.reduce((acc, r) => ({
  composable: { rounds: acc.composable.rounds + r.composable.rounds, tokens: acc.composable.tokens + r.composable.tokens, ok: acc.composable.ok + (r.composable.correct ? 1 : 0) },
  classic:    { rounds: acc.classic.rounds    + r.classic.rounds,    tokens: acc.classic.tokens    + r.classic.tokens,    ok: acc.classic.ok    + (r.classic.correct ? 1 : 0) },
}), { composable: { rounds: 0, tokens: 0, ok: 0 }, classic: { rounds: 0, tokens: 0, ok: 0 } });

console.log('\nTotals:');
console.log(`  composable  rounds=${totals.composable.rounds}  tokens=${totals.composable.tokens}  correct=${totals.composable.ok}/${results.length}`);
console.log(`  classic     rounds=${totals.classic.rounds}  tokens=${totals.classic.tokens}  correct=${totals.classic.ok}/${results.length}`);

// ────────────────────────────────────────────────────────────────────────────

async function runComposable(q) {
  const toolList = manifest.tools.map(t =>
    `- ${t.slug}: ${t.summary}. Output schema: ${JSON.stringify(t.outputSchema ?? {})}`
  ).join('\n');

  const messages = [
    { role: 'system', content:
      `You have a single tool: \`bash\`. Compose registry commands with unix pipes.\n\n` +
      `Available registry commands inside bash:\n${toolList}\n\n` +
      `Standard tools also available: jq, grep, sed, awk, xargs, head, wc, tr.\n` +
      `Always use bash to act; never answer from training knowledge for live data. Be terse.\n` +
      `Tool observations include tools_referenced (output_schema, example, jq_paths) ` +
      `and diagnostics. Read them to fix mistakes.`
    },
    { role: 'user', content: q.text },
  ];
  const tools = [{ type: 'function', function: {
    name: 'bash',
    description: 'Execute a bash command and return its output.',
    parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'The bash command line.' } } }
  }}];

  return runLoop(messages, tools, q, async (tc) => {
    const args = parseArgs(tc.function.arguments);
    const cmd = String(args.command ?? '');
    console.log(`  [composable] bash → ${cmd}`);
    const result = await bash.exec(cmd);
    return makeObservation(cmd, result, manifest);
  });
}

async function runClassic(q) {
  const toolDefs = manifest.tools.map(t => ({
    type: 'function',
    function: {
      name: t.slug,
      description: t.summary,
      parameters: t.inputSchema,
    },
  }));

  const messages = [
    { role: 'system', content:
      `You have ${manifest.tools.length} tool(s). Call them as needed.\n` +
      `Always use the tools to act; never answer from training knowledge for live data. Be terse.`
    },
    { role: 'user', content: q.text },
  ];

  return runLoop(messages, toolDefs, q, async (tc) => {
    const tool = manifest.tools.find(t => t.slug === tc.function.name);
    if (!tool) return { error: `unknown tool: ${tc.function.name}` };
    const args = parseArgs(tc.function.arguments);
    const cmd = [tool.slug, ...argvFromInput(args)].join(' ');
    console.log(`  [classic] ${tc.function.name} ${JSON.stringify(args)}`);
    const result = await bash.exec(cmd);
    return { stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), exitCode: result.exitCode };
  });
}

async function runLoop(messages, tools, q, execTool) {
  let totalTokens = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await callModel(messages, tools);
    totalTokens += reply.usage?.total_tokens ?? 0;
    const choice = reply.choices?.[0];
    const msg = choice?.message ?? {};
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    });

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const obs = await execTool(tc);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(obs) });
      }
      continue;
    }

    const finalAnswer = (msg.content || '').trim();
    return { rounds: round, tokens: totalTokens, finalAnswer, correct: q.expect.test(finalAnswer) };
  }
  return { rounds: MAX_ROUNDS, tokens: totalTokens, finalAnswer: '(no convergence)', correct: false };
}

async function callModel(messages, tools) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools, max_tokens: 256, temperature: 0.1 }),
    }
  );
  if (!r.ok) throw new Error(`CF API ${r.status}: ${await r.text()}`);
  const env = await r.json();
  if (!env.success) throw new Error(JSON.stringify(env.errors));
  return env.result;
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    const once = JSON.parse(raw);
    if (typeof once === 'string') return JSON.parse(once);
    return once;
  } catch { return {}; }
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
