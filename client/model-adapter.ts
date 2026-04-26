/**
 * model-adapter.ts — normalizes per-model response shapes for Workers AI.
 *
 * Different models on the same Workers AI endpoint return different shapes:
 *
 *   Granite / OpenAI-style:
 *     result.choices[0].message.{ content, tool_calls[].function.{name,arguments-as-string} }
 *     result.choices[0].finish_reason
 *     result.usage.{ prompt_tokens, completion_tokens, total_tokens }
 *
 *   Hermes 2 Pro / legacy WAI shape:
 *     result.response                                          (string, may be null)
 *     result.tool_calls[].{ name, arguments-as-OBJECT }        (no id, no wrapper)
 *     result.usage  →  all zeros (token counting broken in beta)
 *
 * normalizeReply() returns a consistent shape; estimateTokens() provides a
 * rough char-based fallback when the model lies about counts.
 */
import type { ChatMessage, NormalizedReply, ToolCall, UsageStats } from '../types/index.ts';

const HERMES_RE = /hermes|llama-3\.1.*instruct/i;
const QWEN_RE   = /qwen.*coder/i;

/** OpenAI-style reply (Granite, Gemma, OpenAI, Anthropic via compat layer). */
interface OpenAIStyleReply {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: UsageStats;
}

/** Legacy Workers AI reply (Hermes 2 Pro, Llama 3.1 8B fp8). */
interface HermesStyleReply {
  response?: string | null;
  tool_calls?: Array<{
    name: string;
    arguments: unknown; // typically a parsed object
  }>;
  usage?: UsageStats;
}

/**
 * Qwen 2.5 Coder reply. Notable quirk: when the model wants to call a tool,
 * `response` is an OBJECT `{ name, arguments }` rather than a string. The
 * top-level `tool_calls[]` is empty in that case. When the model gives a
 * final answer, `response` is a string and `tool_calls[]` is also empty.
 */
interface QwenStyleReply {
  response?: string | { name: string; arguments: unknown } | null;
  tool_calls?: ToolCall[];
  usage?: UsageStats;
}

type RawReply = OpenAIStyleReply | HermesStyleReply | QwenStyleReply;

export function normalizeReply(raw: RawReply, model: string): NormalizedReply {
  if (QWEN_RE.test(model)) {
    const r = raw as QwenStyleReply;
    if (r.response && typeof r.response === 'object' && 'name' in r.response) {
      // Tool call shape — synthesize a single ToolCall in the OpenAI format
      const tc: ToolCall = {
        id: `qwen-${Date.now()}-0`,
        type: 'function',
        function: {
          name: r.response.name,
          arguments: typeof r.response.arguments === 'string'
            ? r.response.arguments
            : JSON.stringify(r.response.arguments ?? {}),
        },
      };
      return {
        content: '',
        tool_calls: [tc],
        finish_reason: 'tool_calls',
        usage: r.usage ?? null,
        reportedTokens: r.usage?.total_tokens ?? 0,
      };
    }
    // Final answer shape — plain string response
    return {
      content: typeof r.response === 'string' ? r.response : '',
      tool_calls: [],
      finish_reason: 'stop',
      usage: r.usage ?? null,
      reportedTokens: r.usage?.total_tokens ?? 0,
    };
  }

  if (HERMES_RE.test(model)) {
    const r = raw as HermesStyleReply;
    const tcs: ToolCall[] = (r.tool_calls ?? []).map((tc, i) => ({
      id: `hermes-${Date.now()}-${i}`,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments ?? {}),
      },
    }));
    return {
      content: r.response ?? '',
      tool_calls: tcs,
      finish_reason: tcs.length ? 'tool_calls' : 'stop',
      usage: r.usage ?? null,
      reportedTokens: r.usage?.total_tokens ?? 0, // Hermes beta returns 0 here
    };
  }

  // Granite / Gemma / OpenAI-style
  const r = raw as OpenAIStyleReply;
  const choice = r.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  return {
    content: msg.content ?? '',
    tool_calls: msg.tool_calls ?? [],
    finish_reason: choice.finish_reason ?? 'stop',
    usage: r.usage ?? null,
    reportedTokens: r.usage?.total_tokens ?? 0,
  };
}

/**
 * Hermes returns zeroed usage in beta; estimate via the well-known
 * heuristic ≈ chars/4. Used for cross-model token comparisons.
 */
export function estimateTokens(messages: ChatMessage[], tools: unknown[] = []): number {
  const text =
    messages.map((m) => {
      let s = (m.role ?? '') + ' ' + (m.content ?? '');
      if (m.tool_calls) s += JSON.stringify(m.tool_calls);
      if (m.tool_call_id) s += m.tool_call_id;
      return s;
    }).join('\n') +
    JSON.stringify(tools);
  return Math.ceil(text.length / 4);
}

/**
 * Token usage broken into input (prompt) and output (completion).
 *
 * Pricing for most models is asymmetric (output is 2-10× input), so the
 * token-count of "X total" hides the real cost story. Composable mode tends
 * to ship less input (1 tool definition) but more output (longer bash
 * commands); classic ships more input (N tool definitions) but less
 * output (structured args). The honest cost answer needs both numbers.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** True when these numbers come from our chars/4 fallback rather than model usage. */
  estimated: boolean;
}

/**
 * Best-effort token usage from a model reply. Uses model-reported counts
 * when available (Granite, Gemma) and falls back to an estimate (Hermes
 * zeroes out usage in beta).
 *
 * For the estimated case, we attribute the *delta* between the request
 * messages (which include the prior assistant message that was just
 * pushed) and just-the-new-content as input vs output. It's not perfect
 * but it's directionally honest for cross-model comparisons.
 */
export function tokensUsed(
  reply: NormalizedReply,
  requestMessages: ChatMessage[],
  requestTools: unknown[],
): TokenUsage {
  const reported = reply.usage;
  if (reported && (reported.prompt_tokens ?? 0) > 0) {
    const input  = reported.prompt_tokens     ?? 0;
    const output = reported.completion_tokens ?? 0;
    return { input, output, total: input + output, estimated: false };
  }
  // Estimate path: input = the prompt we just sent; output = the model's reply
  const input  = estimateTokens(requestMessages, requestTools);
  // The reply isn't in requestMessages yet at this point, so reconstruct it
  const replyMsg: ChatMessage = {
    role: 'assistant',
    content: reply.content,
    ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls } : {}),
  };
  const output = estimateTokens([replyMsg]);
  return { input, output, total: input + output, estimated: true };
}
