// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Look up a public GitHub repo's stars, language, description, default branch, and last push. */
export interface Input {
  /** GitHub user or org owning the repo, e.g. 'cloudflare'. */
  owner: string;
  /** Repo name without owner, e.g. 'workers-sdk'. */
  repo: string;
}

/** Skill output */
export interface Output {
  /** owner/repo identifier. */
  full_name?: string;
  /** Repo description (may be empty string if unset). */
  description?: string;
  /** Star count at fetch time. */
  stars?: number;
  /** Primary language detected by GitHub linguist (may be empty). */
  language?: string;
  /** Default branch name, e.g. 'main' or 'master'. */
  default_branch?: string;
  /** ISO 8601 timestamp of the most recent push to any branch. */
  pushed_at?: string;
  /** Public html_url of the repo. */
  url?: string;
}
