// Schema for tool.yaml — used both by the CI linter (validate.mjs)
// and (in a future iteration) by the runtime registry. Keeping it
// vanilla-JSONSchema-shaped so the same definition can travel.

export const SKILL_SCHEMA = {
  type: 'object',
  required: ['slug', 'name', 'summary', 'version', 'inputSchema'],
  additionalProperties: true,
  properties: {
    slug:         { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name:         { type: 'string', minLength: 1 },
    summary:      { type: 'string', minLength: 1, maxLength: 200 },
    description:  { type: 'string' },
    version:      { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    capabilities: { type: 'array', items: { type: 'string' } },
    sideEffects:  { type: 'string', enum: ['none', 'read', 'write', 'destructive'] },
    inputSchema:  { type: 'object' },
    outputSchema: { type: 'object' },
    requiredEnv:  { type: 'array', items: { type: 'string' } },
    networkPolicy:{
      type: 'object',
      properties: { allow: { type: 'array', items: { type: 'string' } } }
    },
    // Per-model overrides. Keys are model-name substrings (case-insensitive),
    // values are partial skill definitions that replace the matching fields.
    // Only summary, description, and inputSchema are overridable for now.
    model_overrides: {
      type: 'object',
    },
  }
};

// Tiny inline JSONSchema validator (dependency-free, just enough for the linter).
// Returns array of error strings; empty array == valid.
export function validate(schema, data, path = '$') {
  const errs = [];
  if (schema.type) {
    const actual = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data;
    if (actual !== schema.type) {
      errs.push(`${path}: expected ${schema.type}, got ${actual}`);
      return errs;
    }
  }
  if (schema.type === 'object') {
    for (const k of schema.required || []) {
      if (!(k in (data || {}))) errs.push(`${path}.${k}: missing required field`);
    }
    for (const [k, v] of Object.entries(data || {})) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${path}.${k}`));
    }
  }
  if (schema.type === 'array' && schema.items) {
    (data || []).forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (schema.type === 'string') {
    if (schema.minLength != null && data.length < schema.minLength)
      errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength != null && data.length > schema.maxLength)
      errs.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errs.push(`${path}: does not match /${schema.pattern}/`);
    if (schema.enum && !schema.enum.includes(data))
      errs.push(`${path}: not in enum [${schema.enum.join(', ')}]`);
  }
  return errs;
}
