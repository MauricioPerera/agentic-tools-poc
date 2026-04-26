/**
 * skill-tuning.mjs — applies per-model overrides from a skill's tool.yaml.
 *
 * The same registry, served by the same MCP server, exposes a slightly
 * different shape per model — because we own the skills.
 *
 * Match is substring + case-insensitive: a tool with `model_overrides.hermes`
 * applies to any model id containing "hermes" (e.g. `@hf/.../hermes-2-pro`).
 *
 * Only `summary`, `description`, and `inputSchema` are overridable today.
 * Behaviour (the source bundle) is not — that stays consistent.
 */

// Fields that can be overridden directly on the skill descriptor.
const OVERRIDABLE_FIELDS = new Set(['summary', 'description', 'inputSchema']);

// Fields that aggregate across all skills and feed the agent's system prompt.
const AGGREGATED_FIELDS = new Set(['system_prompt_fragments']);

/**
 * Find the override block matching the active model, if any.
 * Match is substring + case-insensitive ("hermes" matches `@hf/.../hermes-2-pro`).
 */
function matchOverride(modelOverrides, model) {
  if (!modelOverrides || !model) return null;
  const m = String(model).toLowerCase();
  for (const [key, override] of Object.entries(modelOverrides)) {
    if (m.includes(key.toLowerCase())) return override;
  }
  return null;
}

export function applyModelOverrides(tool, model) {
  const override = matchOverride(tool.model_overrides, model);
  if (!override) return tool;

  const out = { ...tool };
  for (const [k, v] of Object.entries(override)) {
    if (OVERRIDABLE_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export function applyOverridesToManifest(manifest, model) {
  return {
    ...manifest,
    tools: manifest.tools.map((t) => applyModelOverrides(t, model)),
  };
}

/**
 * Aggregate `system_prompt_fragments` from every skill's matching override.
 * Returns an array of strings the agent loop can join with `\n` and append
 * to its system prompt — the cross-skill, per-model tuning layer.
 *
 * Example tool.yaml block:
 *   model_overrides:
 *     hermes:
 *       system_prompt_fragments:
 *         - "When ip-info fails, retry with different args. Never invent IPs."
 *
 * @param {object} manifest  the (possibly already-overridden) registry manifest
 * @param {string} model     the active model name
 * @returns {string[]}       fragments in registration order, deduplicated
 */
export function getSystemPromptFragments(manifest, model) {
  const fragments = [];
  const seen = new Set();
  for (const tool of manifest?.tools ?? []) {
    const override = matchOverride(tool.model_overrides, model);
    const list = override?.system_prompt_fragments;
    if (!Array.isArray(list)) continue;
    for (const fragment of list) {
      if (typeof fragment === 'string' && !seen.has(fragment)) {
        seen.add(fragment);
        fragments.push(fragment);
      }
    }
  }
  return fragments;
}

// Re-export the field-classification sets for tests / introspection.
export const _internals = { OVERRIDABLE_FIELDS, AGGREGATED_FIELDS, matchOverride };
