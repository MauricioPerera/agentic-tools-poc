// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Returns public IP and country code via api.country.is */
export interface Input {
  /** IP to look up. Empty string (default) → caller's public IP. */
  ip?: string;
}

/** Skill output */
export interface Output {
  ip?: string;
  /** ISO 3166-1 alpha-2 country code */
  country?: string;
}
