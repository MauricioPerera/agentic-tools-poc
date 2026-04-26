/**
 * pricing.ts — per-model token pricing for the Workers AI catalog.
 *
 * Snapshot fetched from the Cloudflare catalog at the time of the
 * benchmarks documented in this repo. Prices change; for production
 * use, refresh from the live catalog:
 *
 *   GET /accounts/{id}/ai/models/search?search=<model-name>
 *   → result[].properties.find(p => p.property_id === 'price').value
 *
 * The output:input asymmetry matters. Composable bash composition
 * trades smaller tool-list input for longer command output. On
 * Granite (output is 6.5× input price) that trade-off costs more in $
 * than the token-count alone suggests.
 */

export interface ModelPricing {
  /** Cents per million input tokens, in USD. */
  inputPerMUSD: number;
  /** Cents per million output tokens, in USD. */
  outputPerMUSD: number;
  /** True when the model is on a beta tier (typically $0 until promoted). */
  beta?: boolean;
  /** Notes shown in the comparison table for this model. */
  notes?: string;
}

/**
 * Match-by-substring (case-insensitive) so model ids like
 * `@cf/ibm-granite/granite-4.0-h-micro` resolve to the right entry
 * without listing every variant.
 *
 * Order matters: longest matches should come first to avoid
 * `granite` accidentally matching a future `granite-mini` etc.
 */
const PRICING_TABLE: Array<[RegExp, ModelPricing]> = [
  [/granite-4\.0-h-micro/i, { inputPerMUSD: 0.017, outputPerMUSD: 0.11 }],
  [/gemma-4-26b/i,           { inputPerMUSD: 0.10,  outputPerMUSD: 0.30 }],
  [/llama-3\.1-8b.*fp8/i,    { inputPerMUSD: 0.15,  outputPerMUSD: 0.29, notes: 'fp8 quant' }],
  [/llama-3\.1-8b.*awq/i,    { inputPerMUSD: 0.12,  outputPerMUSD: 0.27, notes: 'awq quant' }],
  [/llama-3\.1-8b/i,         { inputPerMUSD: 0.15,  outputPerMUSD: 0.29 }],
  [/qwen2\.5-coder-32b/i,    { inputPerMUSD: 0.66,  outputPerMUSD: 1.00 }],
  [/hermes-2-pro/i,          { inputPerMUSD: 0,     outputPerMUSD: 0,
                                beta: true, notes: 'free in beta; no published post-beta price' }],
];

/** Lookup pricing for a model id; null if we don't have it. */
export function getPricing(modelId: string): ModelPricing | null {
  for (const [pattern, price] of PRICING_TABLE) {
    if (pattern.test(modelId)) return price;
  }
  return null;
}

/** Compute USD cost from an input/output token pair, rounded to 6 decimals. */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  const inputCost  = (inputTokens  / 1_000_000) * pricing.inputPerMUSD;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMUSD;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/** Human-readable cost: '$0.000123' or '<$0.000001' for sub-microcent values. */
export function formatCost(usd: number): string {
  if (usd === 0)         return '$0';
  if (usd < 0.000001)    return '<$0.000001';
  if (usd < 0.001)       return `$${usd.toFixed(6)}`;
  if (usd < 1)           return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
