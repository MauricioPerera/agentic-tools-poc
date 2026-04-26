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

const OVERRIDABLE = new Set(['summary', 'description', 'inputSchema']);

export function applyModelOverrides(tool, model) {
  if (!tool.model_overrides || !model) return tool;

  const m = String(model).toLowerCase();
  for (const [key, override] of Object.entries(tool.model_overrides)) {
    if (m.includes(key.toLowerCase())) {
      const out = { ...tool };
      for (const [k, v] of Object.entries(override)) {
        if (OVERRIDABLE.has(k)) out[k] = v;
      }
      return out;
    }
  }
  return tool;
}

export function applyOverridesToManifest(manifest, model) {
  return {
    ...manifest,
    tools: manifest.tools.map((t) => applyModelOverrides(t, model)),
  };
}
