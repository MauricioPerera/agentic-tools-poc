/**
 * url2md — converts a public URL to clean markdown via url2md.automators.work
 *
 * The five layers of this skill:
 * 1. Function:  fetch the upstream API, return parsed result
 * 2. Context:   "use when user pastes URL and asks to read/summarize content"
 *               (lives in tool.yaml summary + README)
 * 3. Tuning:    model_overrides.hermes drops the optional `raw` flag in
 *               tool.yaml so small models can't fill it wrong
 * 4. Recovery:  on 422 (extraction failed) auto-retry with raw=1 once,
 *               so the model doesn't have to learn that pattern itself
 * 5. Meta:      composes naturally with `jq -r .markdown`, `wc`, `head`,
 *               or downstream LLM calls in pipelines
 *
 * Input/Output types come from `./types.gen.ts` — auto-generated from
 * `tool.yaml`. To change the contract, edit the YAML and run `npm run codegen`.
 */
import type { SkillHandler, ToolContext } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';

const BASE = 'https://url2md.automators.work/md';

function buildUrl(url: string, raw: boolean): string {
  const params = new URLSearchParams({ url });
  if (raw) params.set('raw', '1');
  return `${BASE}?${params.toString()}`;
}

function isAbsoluteHttp(s: unknown): s is string {
  return typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s);
}

interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
}

async function fetchOnce(target: string, ctx: ToolContext): Promise<FetchResult> {
  const res = await ctx.fetch(target);
  return {
    status: res.status,
    ok: res.ok,
    body: res.ok ? await res.text() : await res.text().catch(() => ''),
  };
}

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  if (!isAbsoluteHttp(input?.url)) {
    throw new Error('url must be an absolute http(s) URL');
  }

  // First attempt: respect caller's `raw` choice. Default to readability extraction.
  const wantRaw = input.raw === true;
  let target = buildUrl(input.url, wantRaw);
  ctx.log(`GET ${target}`);
  let res = await fetchOnce(target, ctx);

  // Recovery layer: if readability extraction failed (422) and we didn't
  // already try raw mode, retry once with raw=1.
  if (res.status === 422 && !wantRaw) {
    target = buildUrl(input.url, true);
    ctx.log(`GET ${target} (auto-fallback after 422)`);
    res = await fetchOnce(target, ctx);
  }

  if (!res.ok) {
    const reasonMap: Record<number, string> = {
      400: 'invalid url, disallowed scheme, or private host',
      413: 'upstream body exceeded 5 MB',
      415: 'upstream returned non-HTML content-type',
      422: 'could not extract readable content even in raw mode',
      502: 'upstream fetch failed',
    };
    const reason = reasonMap[res.status] ?? 'unknown error';
    throw new Error(`url2md returned ${res.status}: ${reason}`);
  }

  const md = res.body;
  // Response format documented as: "# {title}\n\n> Source: {url}\n\n{body}"
  const titleMatch = md.match(/^# (.+?)$/m);
  const sourceMatch = md.match(/^> Source: (.+?)$/m);

  // outputSchema declares fields as optional but we always populate them
  // — `satisfies Output` enforces shape conformance at the boundary.
  const out: Output = {
    title: titleMatch?.[1]?.trim() ?? undefined,
    source: sourceMatch?.[1]?.trim() ?? input.url,
    markdown: md,
    length: md.length,
  };
  return out;
};

export default handler;
