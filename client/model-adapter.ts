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

const HERMES_RE = /hermes/i;

/** Shape of an OpenAI-style raw reply (Granite, Gemma, etc.). */
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

/** Shape of the legacy Workers AI reply (Hermes). */
interface HermesStyleReply {
  response?: string | null;
  tool_calls?: Array<{
    name: string;
    arguments: unknown; // Hermes returns this as a parsed object
  }>;
  usage?: UsageStats;
}

type RawReply = OpenAIStyleReply | HermesStyleReply;

export function normalizeReply(raw: RawReply, model: string): NormalizedReply {
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
      reportedTokens: 0, // Hermes returns zeros — caller should estimate
    };
  }

  // Granite / OpenAI-style
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
 * Returns the best available token count: model-reported when non-zero,
 * otherwise our estimate. Always returns a positive integer.
 */
export function tokensUsed(
  reply: NormalizedReply,
  requestMessages: ChatMessage[],
  requestTools: unknown[],
): number {
  if (reply.reportedTokens > 0) return reply.reportedTokens;
  return estimateTokens(requestMessages, requestTools);
}
