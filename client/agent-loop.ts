/**
 * agent-loop.ts — the model-agnostic agent loop that drives a query through
 * either the composable (`bash`-only) or classic (one-tool-per-skill) shape.
 *
 * Extracted from compare.ts so the loop is reusable: anyone wanting to
 * benchmark against a different model provider, or drive the same registry
 * from a non-Workers-AI host, supplies a `callModel` adapter and gets the
 * same RunResult shape back. compare.ts is now a thin wrapper that injects
 * the Workers-AI fetch-based callModel; the eval suite, future MCP-server
 * benchmarks, etc. can swap their own adapter.
 *
 * The file deliberately exposes BOTH the high-level helpers (`runComposable`,
 * `runClassic`) and the lower-level `runLoop` for callers that want to
 * customise the system prompt or tool definitions.
 */
import type { Bash } from 'just-bash';
import { makeObservation, lastPipelineStage } from './smart-bash.ts';
import { normalizeReply, tokensUsed, type TokenUsage } from './model-adapter.ts';
import { parseToolCallArguments, inputToArgv, argvToShellCommand } from './arg-parser.ts';
import { computeCost, type ModelPricing } from './pricing.ts';
import {
  wrapUntrustedOutput,
  outputCapForSkill,
  UNTRUSTED_OUTPUT_FRAGMENT,
} from './untrusted-output.ts';
import type { ChatMessage, Manifest, ToolCall } from '../types/index.ts';
import type { Query } from './eval-suite.ts';

// ---------------------------------------------------------------------------
// Public types

export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

/**
 * The provider-agnostic interface the loop calls each round. The implementation
 * is responsible for everything network-shaped: auth, retries, request
 * formatting. Returns the raw provider response, which the loop hands to
 * `normalizeReply` to flatten across Workers-AI shapes.
 */
export type CallModel = (messages: ChatMessage[], tools: ToolDef[]) =>
  Promise<Parameters<typeof normalizeReply>[0]>;

export interface AgentOptions {
  /** Provider-agnostic model-call function (see CallModel). */
  callModel: CallModel;
  /** Model identifier — passed to normalizeReply for shape detection. */
  model: string;
  /** Pricing entry for cost computation. null → cost columns omitted. */
  modelPricing: ModelPricing | null;
  /** Hard ceiling on rounds before the loop returns "no convergence". */
  maxRounds?: number;
  /** Per-model system-prompt fragments aggregated by skill-tuning.ts. */
  promptFragments?: string[];
  /** Optional logger for "[composable] bash → cmd" / "[classic] tool args"
   *  trace lines. Defaults to a no-op so library use is silent. */
  trace?: (msg: string) => void;
}

export type RunOutcome = 'via_tool' | 'without_tool' | 'wrong_with_tool' | 'wrong_no_tool';

export interface RunResult {
  rounds: number;
  /** Sum of usage.prompt_tokens across every round (or our estimate). */
  inputTokens: number;
  /** Sum of usage.completion_tokens across every round (or our estimate). */
  outputTokens: number;
  /** USD cost computed from pricing × tokens. null when no pricing entry. */
  costUSD: number | null;
  /** True when usage.estimated was true on any round (Hermes beta). */
  anyEstimated: boolean;
  finalAnswer: string;
  /** Did the regex match? Says nothing about how the answer was produced. */
  correct: boolean;
  /** Number of tool_calls the model emitted across all rounds. 0 = the
   *  model answered without ever invoking a tool — disciplinarily distinct
   *  from "called the right tool and parsed the result", even if both pass
   *  the same expectation regex. */
  toolCalls: number;
  /** Bucketed outcome — see compare.ts table headers. */
  outcome: RunOutcome;
}

// ---------------------------------------------------------------------------
// High-level helpers

export async function runComposable(
  query: Query,
  manifest: Manifest,
  bash: Bash,
  opts: AgentOptions,
): Promise<RunResult> {
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
    { role: 'system', content: appendFragments(baseSystem, opts.promptFragments ?? []) },
    { role: 'user', content: query.text },
  ];
  const tools: ToolDef[] = [
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

  return runLoop(messages, tools, query, opts, async (tc) => {
    const args = parseToolCallArguments(tc.function.arguments);
    const cmd = String(args['command'] ?? '');
    opts.trace?.(`[composable] bash → ${cmd}`);
    const result = await bash.exec(cmd);
    const obs = makeObservation(
      cmd,
      result as { stdout: string; stderr: string; exitCode: number },
      manifest,
    );
    // V5 strawman: if the pipeline ends in a registry tool, the stdout is
    // untrusted skill output. Wrap before it lands in the LLM context.
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

export async function runClassic(
  query: Query,
  manifest: Manifest,
  bash: Bash,
  opts: AgentOptions,
): Promise<RunResult> {
  const toolDefs: ToolDef[] = manifest.tools.map((t) => ({
    type: 'function',
    function: { name: t.slug, description: t.summary, parameters: t.inputSchema },
  }));

  const baseSystem =
    `You have ${manifest.tools.length} tool(s). Call them as needed.\n` +
    `Always use the tools to act; never answer from training knowledge for live data. Be terse.\n` +
    UNTRUSTED_OUTPUT_FRAGMENT;

  const messages: ChatMessage[] = [
    { role: 'system', content: appendFragments(baseSystem, opts.promptFragments ?? []) },
    { role: 'user', content: query.text },
  ];

  return runLoop(messages, toolDefs, query, opts, async (tc) => {
    const tool = manifest.tools.find((t) => t.slug === tc.function.name);
    if (!tool) return { error: `unknown tool: ${tc.function.name}` };
    const args = parseToolCallArguments(tc.function.arguments);
    const cmd = `${tool.slug} ${argvToShellCommand(inputToArgv(args))}`.trim();
    opts.trace?.(`[classic] ${tc.function.name} ${JSON.stringify(args)}`);
    const result = await bash.exec(cmd);
    let stdout = (result.stdout ?? '').trim();
    if (stdout) {
      stdout = wrapUntrustedOutput(stdout, { slug: tool.slug, outputCap: tool.outputCap });
    }
    return { stdout, stderr: (result.stderr ?? '').trim(), exitCode: result.exitCode };
  });
}

// ---------------------------------------------------------------------------
// Lower-level: runLoop drives one query to completion. Exported for callers
// that want to assemble their own messages / tools list.

export type ExecFn = (tc: ToolCall) => Promise<unknown>;

export async function runLoop(
  messages: ChatMessage[],
  tools: ToolDef[],
  query: Query,
  opts: AgentOptions,
  execTool: ExecFn,
): Promise<RunResult> {
  const maxRounds = opts.maxRounds ?? 5;
  let inputTokens = 0;
  let outputTokens = 0;
  let anyEstimated = false;
  let toolCalls = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const raw = await opts.callModel(messages, tools);
    const reply = normalizeReply(raw, opts.model);
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
    const correct = query.expect.test(finalAnswer);
    return {
      rounds: round,
      inputTokens, outputTokens,
      costUSD: opts.modelPricing ? computeCost(inputTokens, outputTokens, opts.modelPricing) : null,
      anyEstimated,
      finalAnswer,
      correct,
      toolCalls,
      outcome: classifyOutcome(correct, toolCalls),
    };
  }
  return {
    rounds: maxRounds,
    inputTokens, outputTokens,
    costUSD: opts.modelPricing ? computeCost(inputTokens, outputTokens, opts.modelPricing) : null,
    anyEstimated,
    finalAnswer: '(no convergence)',
    correct: false,
    toolCalls,
    outcome: classifyOutcome(false, toolCalls),
  };
}

// ---------------------------------------------------------------------------
// Helpers

export function classifyOutcome(correct: boolean, toolCalls: number): RunOutcome {
  if (correct && toolCalls > 0) return 'via_tool';
  if (correct) return 'without_tool';
  if (toolCalls > 0) return 'wrong_with_tool';
  return 'wrong_no_tool';
}

/** Append per-model prompt fragments to a base system prompt, if any. */
export function appendFragments(base: string, fragments: string[]): string {
  if (!fragments?.length) return base;
  return `${base}\n\nMODEL-SPECIFIC INSTRUCTIONS:\n${fragments.map((f) => '- ' + f).join('\n')}`;
}
