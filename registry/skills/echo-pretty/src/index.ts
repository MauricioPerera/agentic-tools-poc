/**
 * echo-pretty
 * Pure transform tool: no network, no env. Validates the trusted-execution path.
 */
import type { SkillHandler } from '../../../../types/index.ts';

interface Input {
  text: string;
  upper?: boolean;
  lower?: boolean;
  prefix?: string;
}

interface Output {
  text: string;
  length: number;
}

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  let out = String(input.text ?? '');
  if (input.upper) out = out.toUpperCase();
  if (input.lower) out = out.toLowerCase();
  if (input.prefix) out = input.prefix + out;
  ctx.log(`echo-pretty: produced ${out.length} chars`);
  return { text: out, length: out.length };
};

export default handler;
