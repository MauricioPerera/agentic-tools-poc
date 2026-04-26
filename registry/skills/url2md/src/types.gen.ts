// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Convert a public web URL to clean markdown via url2md.automators.work */
export interface Input {
  /** Absolute http(s) URL of a public page to convert. */
  url: string;
  /** If true, convert the full page body instead of extracting the main article. Use as fallback when default extraction returns 422. */
  raw?: boolean;
}

/** Skill output */
export interface Output {
  /** Page title extracted by the upstream service. */
  title?: string;
  /** The original URL that was fetched. */
  source?: string;
  /** The page content as markdown. */
  markdown?: string;
  /** Character length of the markdown body. */
  length?: number;
}
