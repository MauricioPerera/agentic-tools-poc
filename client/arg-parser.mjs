/**
 * arg-parser.mjs — the two argument parsers used across the project,
 * consolidated into one module with clear, distinct names.
 *
 * Why two parsers exist:
 *   1. parseArgvAgainstSchema  — invoked by the just-bash command handler.
 *      Input is argv (`['--text', 'hi', '--upper']`) plus stdin, parsed
 *      against a tool's JSONSchema. Output is the tool's `input` object.
 *
 *   2. parseToolCallArguments  — invoked by the agent loop when it receives
 *      a `tool_calls[].function.arguments` payload from the model. Input
 *      is a JSON string (which Workers AI sometimes double-encodes for
 *      Granite). Output is the parsed object.
 *
 * Same goal (`{key: value}` object), totally different inputs. Keeping them
 * in one module makes the duality visible.
 */

// ---------------------------------------------------------------------------
// Parser #1 — argv → input (used by client/loader.mjs inside the bash shell)

/**
 * Parses argv + stdin into an `input` object that conforms to the JSONSchema.
 * Tiny but functional: --flag, --key=val, --key val, default coercion, and
 * stdin read into the first unfilled string field if no --flag supplied it.
 *
 * @param {string[]} args      argv tokens (no program name)
 * @param {string}   stdin     piped stdin content (may be empty)
 * @param {object}   schema    JSONSchema describing the input shape
 * @returns {object}           parsed input object
 */
export function parseArgvAgainstSchema(args, stdin, schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const out = {};

  // Apply defaults from the schema first
  for (const [k, def] of Object.entries(props)) {
    if (def.default !== undefined) out[k] = def.default;
  }

  // Walk argv, mapping --flag → out
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    let key, val;
    if (a.includes('=')) {
      [key, val] = [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    } else {
      key = a.slice(2);
      val = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : true;
    }
    const coerced = coerceArgvValue(val, props[key]?.type);
    if (coerced !== undefined) out[key] = coerced;
  }

  // Stdin → first string field that is still undefined. Skips fields that
  // already have a value (set via argv or via a default in the schema).
  if (stdin && stdin.length > 0) {
    const stdinTarget = Object.keys(props).find((k) =>
      props[k].type === 'string' && out[k] === undefined
    );
    if (stdinTarget) out[stdinTarget] = stdin.replace(/\n+$/, '');
  }

  for (const k of required) {
    if (out[k] === undefined) throw new Error(`missing required input: --${k}`);
  }
  return out;
}

/**
 * Coerce a parsed argv value into the type declared by the schema.
 *
 * `val === true` happens for bare flags like `--upper`. For a boolean field
 * that's correct. For a string/number field it means "the user typed the
 * flag with no value" — we return undefined so the missing-required check
 * upstream can surface a clear error, instead of silently sending the
 * literal string "true" to the handler.
 *
 * @param {string|boolean} val   raw token from argv (or `true` for bare flags)
 * @param {string|undefined} type  JSONSchema type the field expects
 * @returns {string|number|boolean|undefined}  coerced value, or undefined to skip
 */
export function coerceArgvValue(val, type) {
  if (type === 'boolean')              return val === 'true' || val === true;
  if (val === true || val === false)   return undefined;     // bare flag on non-boolean field
  if (type === 'integer' || type === 'number') {
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  }
  return String(val);
}

// ---------------------------------------------------------------------------
// Parser #2 — model tool_calls → input (used by client/compare.mjs and agents)

/**
 * Parses a `tool_calls[].function.arguments` payload from a model.
 *
 * Workers AI returns this in three possible shapes, depending on the model:
 *   - Granite (OpenAI):  string containing JSON
 *   - Granite quirk:     string containing string-quoted JSON (double-encoded)
 *   - Hermes legacy:     normalized to single-encoded JSON string by model-adapter
 *
 * This function handles all three by trying to parse twice if the first
 * parse yielded another string.
 *
 * @param {string|object|null|undefined} raw  the arguments payload
 * @returns {object}  parsed input, or `{}` on failure (caller decides what to do)
 */
export function parseToolCallArguments(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    const once = JSON.parse(raw);
    if (typeof once === 'string') {
      try { return JSON.parse(once); } catch { return {}; }
    }
    return once ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helper #3 — input → argv (inverse of parser #1, used by classic MCP server)

/**
 * Build clean argv tokens from a parsed input object (no shell quoting).
 * Inverse of parseArgvAgainstSchema. Boolean false / null / undefined are
 * dropped; boolean true becomes a bare flag; numbers are passed unquoted;
 * strings are passed verbatim.
 *
 * Use this when you control the next consumer programmatically. For a bash
 * command line, pipe through `argvToShellCommand` to add the appropriate
 * quoting.
 *
 * @param {object} args   input object (key-value pairs)
 * @returns {string[]}    argv tokens, ready to feed parseArgvAgainstSchema
 */
export function inputToArgv(args) {
  const out = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === false || v == null) continue;
    if (v === true)               { out.push(`--${k}`); continue; }
    out.push(`--${k}`, String(v));
  }
  return out;
}

/**
 * Join an argv array into a single bash command string with shell quoting.
 * Used by mcp-server-classic.mjs to convert a structured tool call into
 * the equivalent bash invocation that the registry tool exposes.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function argvToShellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

function shellQuote(token) {
  if (token === '' || /[\s"'`$\\|&;()<>*?{}[\]!#~]/.test(token)) {
    // Use double quotes and escape only `"`, `\`, `$`, and backtick.
    return `"${token.replace(/(["\\`$])/g, '\\$1')}"`;
  }
  return token;
}
