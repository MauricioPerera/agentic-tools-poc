/**
 * smart-bash.mjs — wraps just-bash exec with a richer observation contract
 * intended to make small open-weights models (e.g. Granite 4.0 H Micro)
 * converge in fewer retries.
 *
 * Vanilla just-bash returns: { stdout, stderr, exitCode }
 * Small models stare at "jq: parse error: Cannot index string with string"
 * and have to guess what went wrong.
 *
 * SmartBash returns the same fields PLUS:
 *   - tools_referenced: which registry tools appear in the pipeline, with
 *     their declared output_schema and a synthesized example
 *   - diagnostics: pattern-matched hints for known antipatterns (jq nesting,
 *     command not found, escaped-quote garbage, empty stdout, etc.)
 *   - schema_check: when the pipeline ends in a registry tool, validates that
 *     stdout JSON-parses and matches outputSchema; otherwise notes that the
 *     pipeline transformed the shape and the model should compare to source
 *
 * The contract is intentionally token-frugal: extras only appear when they
 * carry signal. A clean exec returns the same minimal JSON as before.
 */

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Detect a registry tool by name in a bash command, **outside of quoted strings
 * and shell variable expansions**. The earlier regex matched `"ip-info"` literal
 * tokens too; this version walks the command character by character, tracking
 * single/double-quote state, before testing the tool token.
 */
function commandReferencesTool(command, slug) {
  const re = new RegExp(`(^|[\\s|;&(])${escapeRegex(slug)}(\\s|$|[|;&)])`);
  const cleaned = stripQuotedRegions(command);
  return re.test(cleaned);
}

/** Replace contents of single- and double-quoted regions with spaces of equal length. */
function stripQuotedRegions(s) {
  let out = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if (c === "'" && prev !== '\\' && !inDouble)  { inSingle = !inSingle; out += c; continue; }
    if (c === '"' && prev !== '\\' && !inSingle)  { inDouble = !inDouble; out += c; continue; }
    out += (inSingle || inDouble) ? ' ' : c;
  }
  return out;
}

export function makeObservation(command, result, manifest) {
  const stdout = (result.stdout ?? '').replace(/\n+$/, '');
  const stderr = (result.stderr ?? '').replace(/\n+$/, '');
  const exitCode = result.exitCode ?? 0;

  const obs = { exitCode, stdout, stderr };

  // 1. Identify registry tools referenced in the command, ignoring tool names
  //    that only appear inside quoted strings (e.g. `echo "ip-info is a tool"`).
  const tools = manifest.tools.filter((t) => commandReferencesTool(command, t.slug));
  if (tools.length) {
    obs.tools_referenced = tools.map((t) => ({
      slug: t.slug,
      output_schema: t.outputSchema,
      example: synthesizeExample(t.outputSchema),
      jq_paths: jqPathsFromSchema(t.outputSchema),
    }));
  }

  // 2. Identify whether the LAST stage of the pipeline is a registry tool
  //    (vs a post-processor like jq/grep). If so, validate stdout shape.
  const lastStage = lastPipelineStage(command);
  const lastTool  = manifest.tools.find((t) => lastStage === t.slug || lastStage?.startsWith(t.slug + ' '));
  if (lastTool && exitCode === 0 && stdout) {
    obs.schema_check = validateAgainstSchema(stdout, lastTool.outputSchema);
  } else if (tools.length && exitCode === 0 && stdout) {
    obs.schema_check = {
      validated: false,
      reason: `Pipeline ends in a transform (${lastStage ?? 'unknown'}), not a registry tool — ` +
        `final stdout shape is up to your post-processing. Compare to the example ` +
        `output of the upstream registry tool listed in tools_referenced.`,
    };
  }

  // 3. Pattern-matched diagnostics (the high-value bit)
  const diag = [];

  // jq path traversal failure → almost always wrong nesting assumption
  if (/jq:.*parse error.*Cannot index/i.test(stderr) ||
      /jq:.*error.*has no keys/i.test(stderr)) {
    const upstream = tools[0];
    diag.push(
      `jq could not traverse the path you used. ` +
      (upstream
        ? `Upstream tool '${upstream.slug}' returns ${formatSchemaShape(upstream.outputSchema)} — ` +
          `use jq paths that match THAT shape (e.g. \`.${firstScalarField(upstream.outputSchema) ?? 'field'}\` ` +
          `for a flat field), not nested paths.`
        : `Check the source JSON shape before constructing the jq path.`)
    );
  }

  // jq received non-JSON
  if (/jq:.*parse error.*Invalid numeric literal/i.test(stderr) ||
      /jq:.*compile error/i.test(stderr)) {
    diag.push(
      `jq received invalid JSON or had a syntax error in the filter. ` +
      `Verify the upstream command emits a single JSON value on stdout.`
    );
  }

  // command not found — model invented a tool that doesn't exist
  if (/command not found|not found/i.test(stderr) || exitCode === 127) {
    diag.push(
      `One of the commands does not exist. Available registry commands: ` +
      manifest.tools.map((t) => t.slug).join(', ') +
      `. Standard tools: jq, grep, sed, awk, xargs, head, wc, tr.`
    );
  }

  // Suspicious stdout: starts with stray escape that suggests bad text-extraction
  if (exitCode === 0 && stdout && tools.length &&
      /^"[^"]*$/.test(stdout) && stdout.length < 30) {
    diag.push(
      `stdout looks malformed: an unclosed escaped quote ('${stdout.slice(0, 20)}') usually means ` +
      `awk/cut/grep split the JSON on the wrong delimiter. Consider \`jq -r .<field>\` instead, ` +
      `using the schema in tools_referenced to pick the right field.`
    );
  }

  // Empty stdout from a successful exec but with registry tools involved
  if (exitCode === 0 && !stdout && tools.length) {
    diag.push(
      `Pipeline succeeded (exit 0) but produced no stdout. The post-processing likely filtered ` +
      `everything out. Try running the registry tool alone first to see its raw output.`
    );
  }

  if (diag.length) obs.diagnostics = diag;
  return obs;
}

// ---------------------------------------------------------------------------
// helpers

/**
 * Return the last command in a bash pipeline, splitting only on **unquoted,
 * unescaped single pipes**. Treats `||` as a logical OR (not a pipe), and
 * leaves `|` characters inside `'..'` / `".."` and after `\` untouched.
 *
 * Not a full bash parser — but covers the cases we've actually hit when small
 * models compose pipelines (`echo "a|b" | jq`, `cmd1 || cmd2`, `cmd \| cmd`).
 */
export function lastPipelineStage(cmd) {
  const stages = [];
  let current = '';
  let inSingle = false, inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];

    if (c === '\\' && next === '|') { current += c + next; i++; continue; }
    if (c === "'" && !inDouble)     { inSingle = !inSingle; current += c; continue; }
    if (c === '"' && !inSingle)     { inDouble = !inDouble; current += c; continue; }
    if (c === '|' && !inSingle && !inDouble) {
      if (next === '|') { current += c + next; i++; continue; }   // ||
      stages.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) stages.push(current.trim());
  return stages[stages.length - 1] ?? null;
}

function validateAgainstSchema(stdout, schema) {
  if (!schema) return { validated: false, reason: 'no schema declared' };
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch (e) {
    return {
      validated: false,
      ok: false,
      reason: `stdout is not valid JSON. The tool's outputSchema declares ${formatSchemaShape(schema)}.`,
    };
  }
  const errs = checkType(schema, parsed, '$');
  return errs.length
    ? { validated: true, ok: false, errors: errs }
    : { validated: true, ok: true };
}

function checkType(schema, data, path) {
  const errs = [];
  if (!schema || !schema.type) return errs;
  const actual = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data;
  if (actual !== schema.type) {
    errs.push(`${path}: expected ${schema.type}, got ${actual}`);
    return errs;
  }
  if (schema.type === 'object' && schema.properties) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (data[k] !== undefined) errs.push(...checkType(sub, data[k], `${path}.${k}`));
    }
  }
  return errs;
}

function synthesizeExample(schema) {
  if (!schema) return undefined;
  if (schema.type === 'object') {
    const out = {};
    for (const [k, sub] of Object.entries(schema.properties ?? {})) out[k] = synthesizeExample(sub);
    return out;
  }
  if (schema.type === 'array') return [synthesizeExample(schema.items)];
  if (schema.type === 'string')  return schema.description ? `<${schema.description}>` : '<string>';
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  return null;
}

function formatSchemaShape(schema) {
  if (!schema) return '(no schema)';
  if (schema.type === 'object') {
    const fields = Object.entries(schema.properties ?? {})
      .map(([k, sub]) => `${k}:${sub.type ?? '?'}`).join(', ');
    return `a flat object {${fields}}`;
  }
  return `a value of type ${schema.type}`;
}

function firstScalarField(schema) {
  if (schema?.type !== 'object') return null;
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    if (['string', 'number', 'integer', 'boolean'].includes(sub.type)) return k;
  }
  return null;
}

/**
 * Walks an outputSchema and emits literal jq paths the agent can copy-paste.
 * Saves a small model from having to "compose" jq syntax it might get wrong.
 */
function jqPathsFromSchema(schema, prefix = '') {
  if (!schema) return [];
  if (schema.type === 'object') {
    const out = [];
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      const path = `${prefix}.${k}`;
      if (sub.type === 'object' || sub.type === 'array') out.push(...jqPathsFromSchema(sub, path));
      else out.push(path);
    }
    return out;
  }
  if (schema.type === 'array') {
    return jqPathsFromSchema(schema.items, `${prefix}[]`);
  }
  return [prefix || '.'];
}
