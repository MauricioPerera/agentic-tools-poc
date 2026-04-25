/**
 * echo-pretty
 * Pure transform tool: no network, no env. Validates the trusted-execution path.
 *
 * @param {{ text: string, upper?: boolean, lower?: boolean, prefix?: string }} input
 * @param {{ log: (msg: string) => void }} ctx
 */
export default async function handler(input, ctx) {
  let out = String(input.text ?? '');
  if (input.upper) out = out.toUpperCase();
  if (input.lower) out = out.toLowerCase();
  if (input.prefix) out = input.prefix + out;
  ctx.log(`echo-pretty: produced ${out.length} chars`);
  return { text: out, length: out.length };
}
