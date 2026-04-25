/**
 * agent-granite.mjs — full agent loop using Cloudflare Workers AI (Granite 4.0
 * H Micro) as the brain and our just-bash registry as the hands.
 *
 * Demonstrates the thesis end-to-end: a small open-weights model can drive a
 * registry of remote tools through a single `bash` function-call, composing
 * them with unix pipes — instead of N discrete function calls.
 *
 * Auth: pass CF_ACCOUNT_ID and CF_API_TOKEN via env. The token needs the
 * "Workers AI" read+write scope.
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... node client/agent-granite.mjs "your question"
 */
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.mjs';
import { makeObservation } from './smart-bash.mjs';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN   = process.env.CF_API_TOKEN;
const MODEL   = process.env.GRANITE_MODEL ?? '@cf/ibm-granite/granite-4.0-h-micro';
const QUERY   = process.argv.slice(2).join(' ').trim() ||
                'What ISO country code am I currently in? Reply with just the code.';

if (!ACCOUNT || !TOKEN) {
  console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN env.');
  process.exit(2);
}

const banner = (s) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

const { manifest, commands } = await loadRegistry({ registry: process.env.REGISTRY });
const bash = new Bash({ customCommands: commands });

const toolList = manifest.tools
  .map((t) => `- ${t.slug}: ${t.summary}. Output schema: ${JSON.stringify(t.outputSchema ?? {})}`)
  .join('\n');

const messages = [
  {
    role: 'system',
    content:
      `You have a single tool: \`bash\`. Compose registry commands with unix pipes.\n\n` +
      `Available registry commands:\n${toolList}\n\n` +
      `Standard tools also available: jq, grep, sed, awk, xargs, head, wc, tr.\n` +
      `Always use bash to act; never answer from training knowledge for questions ` +
      `that need live data. Be terse.\n` +
      `Tool observations include tools_referenced (with output_schema, example, ` +
      `and ready-to-use jq_paths) and diagnostics. When a command fails, read ` +
      `diagnostics and use the suggested jq_paths instead of guessing syntax.`,
  },
  { role: 'user', content: QUERY },
];

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command and return its output.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string', description: 'The bash command line.' } },
      },
    },
  },
];

banner(`Query: ${QUERY}`);
console.log(`Model: ${MODEL}`);

let totalTokens = 0;
const MAX_ROUNDS = 4;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  banner(`Round ${round} → Granite`);

  const reply = await callModel(messages, tools);
  totalTokens += reply.usage?.total_tokens ?? 0;
  const choice = reply.choices?.[0];
  const msg = choice?.message ?? {};
  const finish = choice?.finish_reason;

  console.log(`finish: ${finish}   usage(round): ${JSON.stringify(reply.usage)}`);

  // Push assistant message into history
  messages.push({
    role: 'assistant',
    content: msg.content ?? '',
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
  });

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      const args = parseToolArgs(tc.function?.arguments);
      const cmd  = String(args?.command ?? '');
      console.log(`tool_call: bash -> ${cmd}`);
      const result = await bash.exec(cmd);
      const obs = process.env.SMART === '0'
        ? { stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(), exitCode: result.exitCode }
        : makeObservation(cmd, result, manifest);
      const observation = JSON.stringify(obs);
      console.log(`observation: ${observation.slice(0, 240)}${observation.length > 240 ? '…' : ''}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: observation });
    }
    continue;
  }

  banner('Final answer');
  console.log(msg.content || '(no content)');
  console.log(`\nTotal tokens across rounds: ${totalTokens}`);
  process.exit(0);
}

console.error(`Aborted after ${MAX_ROUNDS} rounds without final answer.`);
process.exit(1);

// ────────────────────────────────────────────────────────────────────────────

async function callModel(messages, tools) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages, tools, max_tokens: 256, temperature: 0.1 }),
    }
  );
  if (!r.ok) throw new Error(`CF API ${r.status}: ${await r.text()}`);
  const env = await r.json();
  if (!env.success) throw new Error(`CF API errors: ${JSON.stringify(env.errors)}`);
  return env.result;
}

/**
 * Workers AI sometimes double-encodes function-call arguments as a JSON string
 * containing JSON. Handle both cases.
 */
function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    const once = JSON.parse(raw);
    if (typeof once === 'string') return JSON.parse(once);
    return once;
  } catch {
    return {};
  }
}
