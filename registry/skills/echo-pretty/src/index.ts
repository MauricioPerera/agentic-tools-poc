/**
 * echo-pretty
 * Pure transform tool: no network, no env. Validates the trusted-execution path.
 *
 * Input/Output types come from `./types.gen.ts` — auto-generated from
 * `tool.yaml`. To change the contract, edit the YAML and run `npm run codegen`.
 */
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  let out = String(input.text ?? '');
  if (input.upper) out = out.toUpperCase();
  if (input.lower) out = out.toLowerCase();
  if (input.prefix) out = input.prefix + out;
  ctx.log(`echo-pretty: produced ${out.length} chars`);
  return { text: out, length: out.length };
};

export default handler;
