/**
 * skill-linter.ts — semantic lints over a skill's tool.yaml.
 *
 * scripts/validate.ts already enforces structural rules (slug pattern,
 * required fields, etc.) via SKILL_SCHEMA. This file adds the *semantic*
 * rules learned from running real models against the registry — patterns
 * that small open-weights LLMs (Hermes, older 7B instruct, etc.) handle
 * badly when the skill is naively shaped.
 *
 * Each rule is a separate function so the rule set is browseable and
 * individual rules are unit-testable in isolation.
 *
 * Severity model:
 *   - error   → blocks merge / publish (CI exits non-zero)
 *   - warning → noticeable in CI output, doesn't block
 *   - info    → opportunity to improve, silent unless `--all` is passed
 */
import type { JSONSchema, ModelOverride, SkillDef } from '../types/index.ts';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintResult {
  rule: string;
  severity: LintSeverity;
  /** JSONPath-ish locator into the skill, e.g. `$.inputSchema.properties.ip`. */
  field: string;
  message: string;
  suggestion?: string;
}

/** A LintRule is a pure function: skill → findings. */
export type LintRule = (skill: SkillDef) => LintResult[];

// ---------------------------------------------------------------------------
// Rule implementations

/**
 * R1 — `optional-string-no-description`
 * Optional string fields without a `description` are the #1 cause of small
 * models inventing values (Hermes baseline filled `ip` with "192.168.1.1").
 */
export const optionalStringNoDescription: LintRule = (skill) => {
  const out: LintResult[] = [];
  const schema = skill.inputSchema;
  const required = new Set(schema?.required ?? []);
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (required.has(name)) continue;
    if (prop.type !== 'string') continue;
    if (prop.description && prop.description.trim().length > 0) continue;
    out.push({
      rule: 'optional-string-no-description',
      severity: 'warning',
      field: `$.inputSchema.properties.${name}`,
      message: `Optional string field "${name}" has no description.`,
      suggestion:
        `Small models (Hermes 7B and similar) invent values for optional ` +
        `fields when they have no guidance. Either add a description ` +
        `(e.g. "IMPORTANT: omit unless …") or add a model_overrides.<model> ` +
        `block that drops this field from the schema.`,
    });
  }
  return out;
};

/**
 * R2 — `optional-no-default`
 * Optional fields without an explicit `default` are ambiguous to LLMs:
 * "is this really optional, or did the author just forget?"
 */
export const optionalNoDefault: LintRule = (skill) => {
  const out: LintResult[] = [];
  const schema = skill.inputSchema;
  const required = new Set(schema?.required ?? []);
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (required.has(name)) continue;
    if (prop.default !== undefined) continue;
    out.push({
      rule: 'optional-no-default',
      severity: 'warning',
      field: `$.inputSchema.properties.${name}`,
      message: `Optional field "${name}" has no explicit default.`,
      suggestion:
        `Add \`default: <value>\` so the model knows what "not setting it" ` +
        `means. For booleans, \`default: false\` is almost always correct.`,
    });
  }
  return out;
};

/**
 * R3 — `required-no-description`
 * A required field without guidance forces the model to guess what to put.
 */
export const requiredNoDescription: LintRule = (skill) => {
  const out: LintResult[] = [];
  const schema = skill.inputSchema;
  const required = new Set(schema?.required ?? []);
  const props = schema?.properties ?? {};
  for (const name of required) {
    const prop = props[name];
    if (!prop) continue;
    if (prop.description && prop.description.trim().length > 0) continue;
    out.push({
      rule: 'required-no-description',
      severity: 'error',
      field: `$.inputSchema.properties.${name}`,
      message: `Required field "${name}" has no description.`,
      suggestion:
        `Add a description telling the model what value to provide. ` +
        `Without it, the model picks based on the field name alone, which ` +
        `often produces invented or mis-typed values.`,
    });
  }
  return out;
};

/**
 * R4 — `output-schema-missing`
 * Without outputSchema, smart-bash can't generate jq_paths or run schema_check.
 * The whole "agent self-corrects" loop relies on this metadata.
 *
 * Note: a schema like `{ type: 'object' }` with no `properties` is functionally
 * empty — smart-bash can't synthesize an example or extract jq_paths. We check
 * for non-empty `properties`, not just non-empty schema-object keys.
 */
export const outputSchemaMissing: LintRule = (skill) => {
  const props = skill.outputSchema?.properties;
  if (props && Object.keys(props).length > 0) return [];
  return [
    {
      rule: 'output-schema-missing',
      severity: 'error',
      field: '$.outputSchema',
      message: `outputSchema is missing or has no properties.`,
      suggestion:
        `Declare outputSchema with at least one property so smart-bash can ` +
        `produce jq_paths, run schema_check on stdout, and synthesize ` +
        `examples. Without it, the agent has no structured way to introspect ` +
        `what came back.`,
    },
  ];
};

/**
 * R5 — `destructive-no-warning`
 * If a skill self-declares as destructive, its description should warn the
 * model. Otherwise the model invokes it like any other tool.
 */
export const destructiveNoWarning: LintRule = (skill) => {
  if (skill.sideEffects !== 'destructive') return [];
  const text = `${skill.summary ?? ''} ${skill.description ?? ''}`.toLowerCase();
  const warnsAlready = /\b(destructive|irreversible|cannot be undone|deletes?|warning|caution|danger)\b/.test(text);
  if (warnsAlready) return [];
  return [
    {
      rule: 'destructive-no-warning',
      severity: 'warning',
      field: '$.summary',
      message: `Skill is marked sideEffects: 'destructive' but neither summary nor description mentions safety.`,
      suggestion:
        `Add language like "WARNING: this is irreversible" or "Deletes …" ` +
        `to the summary so the model invokes it deliberately, not as a default.`,
    },
  ];
};

/**
 * R6 — `summary-too-long`
 * Summary appears in tools/list every turn for every active session. Keep it
 * tight — > 120 chars wastes tokens at scale.
 */
export const summaryTooLong: LintRule = (skill) => {
  const len = skill.summary?.length ?? 0;
  if (len <= 120) return [];
  return [
    {
      rule: 'summary-too-long',
      severity: 'warning',
      field: '$.summary',
      message: `Summary is ${len} chars (> 120). Lives in every tools/list response.`,
      suggestion:
        `Move detail to description (which only loads when the agent calls ` +
        `tool_schema). Summary should fit in one screen-line.`,
    },
  ];
};

/**
 * R7 — `optionals-without-tuning`
 * Two or more optional fields and no model_overrides → very likely the skill
 * works on Claude/GPT-4o but breaks on Hermes / older 7B instruct models.
 */
export const optionalsWithoutTuning: LintRule = (skill) => {
  const schema = skill.inputSchema;
  const required = new Set(schema?.required ?? []);
  const optionalCount = Object.keys(schema?.properties ?? {})
    .filter((k) => !required.has(k)).length;
  if (optionalCount < 2) return [];
  if (skill.model_overrides && Object.keys(skill.model_overrides).length > 0) return [];
  return [
    {
      rule: 'optionals-without-tuning',
      severity: 'info',
      field: '$.model_overrides',
      message: `Skill has ${optionalCount} optional fields and no model_overrides.`,
      suggestion:
        `Consider adding a model_overrides.<small-model> block that drops ` +
        `or constrains optional fields. The 3-model A/B in this repo's ` +
        `README shows ip-info going from "fails on Hermes" to "passes" ` +
        `with this exact pattern.`,
    },
  ];
};

/**
 * R8 — `network-skill-no-policy`
 * If the skill self-declares network use but networkPolicy.allow is empty,
 * the loader's gate has nothing to enforce — the skill can hit any host.
 */
export const networkSkillNoPolicy: LintRule = (skill) => {
  const usesNetwork = (skill.capabilities ?? []).some((c) =>
    /^(network|fetch|http|api)/i.test(c),
  );
  if (!usesNetwork) return [];
  const allowed = skill.networkPolicy?.allow ?? [];
  if (allowed.length > 0) return [];
  return [
    {
      rule: 'network-skill-no-policy',
      severity: 'warning',
      field: '$.networkPolicy.allow',
      message: `Skill declares network capability but networkPolicy.allow is empty.`,
      suggestion:
        `Set networkPolicy.allow to the explicit hostnames this skill is ` +
        `allowed to contact. Otherwise the loader's network gate is a no-op ` +
        `and a compromised skill bundle could exfiltrate to any host.`,
    },
  ];
};

// ---------------------------------------------------------------------------
// Aggregator — runs every rule and collects results

export const ALL_RULES: LintRule[] = [
  optionalStringNoDescription,
  optionalNoDefault,
  requiredNoDescription,
  outputSchemaMissing,
  destructiveNoWarning,
  summaryTooLong,
  optionalsWithoutTuning,
  networkSkillNoPolicy,
];

/** Run every rule against a skill and return all findings (ordered by rule). */
export function lintSkill(skill: SkillDef, rules: LintRule[] = ALL_RULES): LintResult[] {
  return rules.flatMap((rule) => rule(skill));
}

/** Run lint over many skills and group results by skill slug. */
export function lintSkills(skills: SkillDef[]): Map<string, LintResult[]> {
  const out = new Map<string, LintResult[]>();
  for (const skill of skills) {
    out.set(skill.slug, lintSkill(skill));
  }
  return out;
}

/** Aggregate severity counts across a result set. */
export function summarize(results: LintResult[]): Record<LintSeverity, number> {
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const r of results) counts[r.severity]++;
  return counts;
}

// Suppress "ModelOverride / JSONSchema unused" hints when only used in type position
void (null as unknown as ModelOverride | JSONSchema);
