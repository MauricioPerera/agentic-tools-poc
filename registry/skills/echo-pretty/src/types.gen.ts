// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Echoes input text with optional case transformation and prefix */
export interface Input {
  /** Text to echo back */
  text: string;
  /** Uppercase output */
  upper?: boolean;
  /** Lowercase output */
  lower?: boolean;
  /** Optional prefix */
  prefix?: string;
}

/** Skill output */
export interface Output {
  text?: string;
  length?: number;
}
