/**
 * model-adapter.test.ts — covers normalizeReply for every Workers AI shape
 * we've encountered, plus tokensUsed input/output split.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReply, tokensUsed } from '../client/model-adapter.ts';
import type { ChatMessage } from '../types/index.ts';

// ---------------------------------------------------------------------------
// OpenAI-style (Granite, Gemma)

test('normalizeReply: Granite returns OpenAI-style message with tool_calls', () => {
  const raw = {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'echo-pretty', arguments: '{"text":"hi"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  const out = normalizeReply(raw, '@cf/ibm-granite/granite-4.0-h-micro');
  assert.equal(out.content, '');
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0]!.function.name, 'echo-pretty');
  assert.equal(out.finish_reason, 'tool_calls');
  assert.equal(out.reportedTokens, 120);
});

test('normalizeReply: Granite final answer (no tool_calls)', () => {
  const raw = {
    choices: [{
      finish_reason: 'stop',
      message: { content: 'AGENTIC TOOLS POC', tool_calls: [] },
    }],
    usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
  };
  const out = normalizeReply(raw, '@cf/ibm-granite/granite-4.0-h-micro');
  assert.equal(out.content, 'AGENTIC TOOLS POC');
  assert.deepEqual(out.tool_calls, []);
  assert.equal(out.finish_reason, 'stop');
});

// ---------------------------------------------------------------------------
// Hermes-style (also Llama 3.1 8B fp8)

test('normalizeReply: Hermes top-level tool_calls with parsed args', () => {
  const raw = {
    response: null,
    tool_calls: [{ name: 'ip-info', arguments: { ip: 'caller' } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  const out = normalizeReply(raw, '@hf/nousresearch/hermes-2-pro-mistral-7b');
  assert.equal(out.content, '');
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0]!.function.name, 'ip-info');
  assert.equal(out.tool_calls[0]!.function.arguments, '{"ip":"caller"}');
  assert.equal(out.finish_reason, 'tool_calls');
});

test('normalizeReply: Llama 3.1 8B fp8 routes through Hermes path', () => {
  const raw = {
    response: 'AGENTIC TOOLS POC',
    tool_calls: [],
    usage: { prompt_tokens: 162, completion_tokens: 7, total_tokens: 169 },
  };
  const out = normalizeReply(raw, '@cf/meta/llama-3.1-8b-instruct-fp8');
  assert.equal(out.content, 'AGENTIC TOOLS POC');
  assert.deepEqual(out.tool_calls, []);
  assert.equal(out.finish_reason, 'stop');
});

test('normalizeReply: Hermes finish_reason inferred from tool_calls presence', () => {
  const withCall = normalizeReply({ response: null, tool_calls: [{ name: 'x', arguments: {} }] }, 'hermes');
  const withoutCall = normalizeReply({ response: 'done', tool_calls: [] }, 'hermes');
  assert.equal(withCall.finish_reason, 'tool_calls');
  assert.equal(withoutCall.finish_reason, 'stop');
});

// ---------------------------------------------------------------------------
// Qwen-style (response: object instead of string when calling tool)

test('normalizeReply: Qwen tool call (response is object)', () => {
  const raw = {
    response: { name: 'ip-info', arguments: {} },
    tool_calls: [],
    usage: { prompt_tokens: 265, completion_tokens: 13, total_tokens: 278 },
  };
  const out = normalizeReply(raw, '@cf/qwen/qwen2.5-coder-32b-instruct');
  assert.equal(out.content, '');
  assert.equal(out.tool_calls.length, 1, 'expected synthesized tool_call from response object');
  assert.equal(out.tool_calls[0]!.function.name, 'ip-info');
  assert.equal(out.tool_calls[0]!.function.arguments, '{}');
  assert.equal(out.finish_reason, 'tool_calls');
});

test('normalizeReply: Qwen tool call with parsed arguments', () => {
  const raw = {
    response: { name: 'echo-pretty', arguments: { text: 'hi', upper: true } },
    tool_calls: [],
  };
  const out = normalizeReply(raw, '@cf/qwen/qwen2.5-coder-32b-instruct');
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0]!.function.arguments, '{"text":"hi","upper":true}');
});

test('normalizeReply: Qwen final answer (response is string)', () => {
  const raw = {
    response: 'MX',
    tool_calls: [],
    usage: { prompt_tokens: 339, completion_tokens: 2, total_tokens: 341 },
  };
  const out = normalizeReply(raw, '@cf/qwen/qwen2.5-coder-32b-instruct');
  assert.equal(out.content, 'MX');
  assert.deepEqual(out.tool_calls, []);
  assert.equal(out.finish_reason, 'stop');
});

test('normalizeReply: Qwen handles arguments that arrive as a JSON string', () => {
  const raw = {
    response: { name: 'echo-pretty', arguments: '{"text":"hi"}' },
    tool_calls: [],
  };
  const out = normalizeReply(raw, '@cf/qwen/qwen2.5-coder-32b-instruct');
  assert.equal(out.tool_calls[0]!.function.arguments, '{"text":"hi"}');
});

// ---------------------------------------------------------------------------
// tokensUsed — input/output split

test('tokensUsed: from model-reported usage when prompt_tokens > 0', () => {
  const reply = {
    content: 'hi',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    reportedTokens: 120,
  };
  const usage = tokensUsed(reply, [], []);
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 20);
  assert.equal(usage.total, 120);
  assert.equal(usage.estimated, false);
});

test('tokensUsed: estimates when usage is zero (Hermes beta)', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hello' },
  ];
  const reply = {
    content: 'world',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    reportedTokens: 0,
  };
  const usage = tokensUsed(reply, messages, []);
  assert.equal(usage.estimated, true);
  // Estimate is chars/4; values are positive
  assert.ok(usage.input > 0);
  assert.ok(usage.output > 0);
  assert.equal(usage.total, usage.input + usage.output);
});

test('tokensUsed: estimates from tool_calls when reply has them', () => {
  const reply = {
    content: '',
    tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'x', arguments: '{"a":1}' } }],
    finish_reason: 'tool_calls',
    usage: null,
    reportedTokens: 0,
  };
  const usage = tokensUsed(reply, [], []);
  assert.equal(usage.estimated, true);
  // Output should reflect the tool_call serialization
  assert.ok(usage.output > 0);
});
