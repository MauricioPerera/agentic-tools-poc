/**
 * jsonschema-to-ts.ts — converts our JSONSchema subset into TypeScript
 * type expressions.
 *
 * Zero dependencies. Handles only the subset we actually use in tool.yaml:
 *   - primitive types (string, number, integer, boolean, null)
 *   - enum (rendered as union literal)
 *   - object with properties + required
 *   - array with items
 *
 * Returns a TS type expression as a string. The CALLER decides whether to
 * wrap it in `interface X {...}` (for object roots) or `type X = ...;`.
 */
import type { JSONSchema } from '../types/index.ts';

/** Convert a JSONSchema node to a TS type expression. */
export function schemaToTypeScript(schema: JSONSchema | undefined, indent = 0): string {
  if (!schema) return 'unknown';

  // enum wins over type (e.g. `{ type: 'string', enum: ['a', 'b'] }` → `'a' | 'b'`)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }

  switch (schema.type) {
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'null':    return 'null';
    case 'array': {
      const item = schemaToTypeScript(schema.items, indent);
      // Wrap unions in parens so `string | number[]` doesn't read wrong
      return /\|/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case 'object': {
      const props = schema.properties ?? {};
      const keys = Object.keys(props);
      if (keys.length === 0) return 'Record<string, never>';
      const required = new Set(schema.required ?? []);
      const pad = '  '.repeat(indent + 1);
      const lines: string[] = [];
      for (const k of keys) {
        const sub = props[k]!;
        const optional = required.has(k) ? '' : '?';
        if (sub.description) lines.push(`${pad}/** ${sub.description} */`);
        const inner = schemaToTypeScript(sub, indent + 1);
        lines.push(`${pad}${quoteKeyIfNeeded(k)}${optional}: ${inner};`);
      }
      const closingPad = '  '.repeat(indent);
      return `{\n${lines.join('\n')}\n${closingPad}}`;
    }
    default:
      return 'unknown';
  }
}

/** Wrap a property key in quotes only when it isn't a valid identifier. */
function quoteKeyIfNeeded(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}
