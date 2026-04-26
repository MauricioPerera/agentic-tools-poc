/**
 * eval-suite.ts — the bucketed query corpus that compare.ts runs against
 * each model × mode combination (issue #3).
 *
 * Why this file exists separately from compare.ts:
 *   1. compare.ts has top-level side effects (loadRegistry, console.log,
 *      network calls). Splitting QUERIES out keeps them importable for
 *      structural tests that don't need API credentials.
 *   2. The query corpus is the part that gets reviewed. Keeping it isolated
 *      makes additions / churn visible in PR diffs without conflating them
 *      with refactors of the runner loop.
 *   3. Future tooling (a JSON exporter for the eval registry, a CI quality
 *      gate that checks pass-rate doesn't regress) consumes this without
 *      pulling in the model-call surface.
 *
 * Bucket semantics:
 *   single        — one skill, simple expectation. Baseline functionality.
 *   chain-2       — output of one skill feeds the next. Pipe discipline.
 *   chain-multi   — three or more steps. Stresses long-pipeline correctness.
 *   error         — upstream returns an error or returns nothing. Tests
 *                   recovery, schema discovery, and graceful "I cannot" paths.
 *   discipline    — answerable from training knowledge alone. The
 *                   disciplined outcome is `without_tool` — the model
 *                   should NOT reach for a skill. `via_tool` here is a
 *                   different kind of failure (over-reach).
 *   ambiguous     — two or more skills could plausibly answer. Tests the
 *                   model's choice quality.
 */

export type Bucket = 'single' | 'chain-2' | 'chain-multi' | 'error' | 'discipline' | 'ambiguous';

export interface Query {
  id: string;
  bucket: Bucket;
  text: string;
  expect: RegExp;
  /** When true, a `without_tool` outcome is the EXPECTED disciplined behaviour
   *  (training-knowledge question — the model should NOT call a tool).
   *  When false (default), `via_tool` is preferred and `without_tool` flags
   *  a discipline gap. Only meaningful for the `discipline` bucket. */
  expectNoTool?: boolean;
}

// The original 3-query suite, kept for backward-compat with prior README
// numbers. SUITE=basic (default) selects this set.
export const QUERIES_BASIC: Query[] = [
  {
    id: 'Q1-simple', bucket: 'single',
    text: "Convert 'agentic tools poc' to uppercase. Reply with just the result.",
    expect: /AGENTIC TOOLS POC/,
  },
  {
    id: 'Q2-extract', bucket: 'single',
    text: 'What ISO country code am I currently in? Reply with just the 2-letter code.',
    expect: /^[A-Z]{2}$/m,
  },
  {
    id: 'Q3-chain', bucket: 'chain-2',
    text: "Get my country code, then echo it back uppercased with prefix 'YOU ARE IN: '. Reply with just the result.",
    expect: /YOU ARE IN: [A-Z]{2}/,
  },
];

/**
 * The 20-query corpus (issue #3). Each query is deterministic given the
 * registry + low temperature, picks an unambiguous answer, and uses an
 * expectation regex tolerant to stray formatting.
 *
 * Query design constraints (enforced by compile-handler-suite.test.ts):
 *   - Every bucket appears at least once.
 *   - Every regex compiles.
 *   - `expectNoTool: true` is restricted to the `discipline` bucket
 *     (otherwise the meaning is unclear).
 *   - IDs are unique.
 *   - No query depends on time-varying real-world data with no fixed
 *     expectation (e.g. "what's the current temperature in NYC" is OK
 *     because the regex accepts any number, but "is it raining" is not).
 */
export const QUERIES_FULL: Query[] = [
  // ── Bucket 1: single-skill correctness (4) ────────────────────────────
  ...QUERIES_BASIC.slice(0, 2), // Q1-simple (echo-pretty), Q2-extract (ip-info)
  {
    id: 'S3-dictionary', bucket: 'single',
    text: "What part of speech is 'serendipity'? Reply with just the part of speech.",
    expect: /noun/i,
  },
  {
    id: 'S4-github', bucket: 'single',
    text: "What is the default branch of the github.com/sindresorhus/ky repo? Reply with just the branch name.",
    expect: /^main$/im,
  },

  // ── Bucket 2: 2-skill chain — pipe one skill's output into another (3)
  QUERIES_BASIC[2]!, // Q3-chain (ip-info → echo-pretty)
  {
    id: 'C2-dict-echo', bucket: 'chain-2',
    text: "Look up the part of speech of 'lexicon'. Then echo it uppercased with prefix 'POS: '. Reply with just the result.",
    expect: /POS:\s+NOUN/i,
  },
  {
    id: 'C3-github-echo', bucket: 'chain-2',
    text: "Get the primary language of the github.com/sindresorhus/ky repo. Then echo it lowercased. Reply with just the lowercased result.",
    expect: /^typescript$/im,
  },

  // ── Bucket 3: longer chains — composition discipline (2) ──────────────
  {
    id: 'M1-github-echo-prefix', bucket: 'chain-multi',
    text: "Get the default branch of the github.com/sindresorhus/ky repo. Echo it lowercased. Then echo that result again with prefix 'BRANCH=' uppercased. Reply with just the final result.",
    expect: /BRANCH=MAIN/,
  },
  {
    id: 'M2-two-dict-join', bucket: 'chain-multi',
    text: "Look up the part of speech of 'serendipity'. Then look up the part of speech of 'lexicon'. Reply with both parts of speech joined by a hyphen, lowercased — e.g. 'noun-noun'.",
    expect: /noun-noun/i,
  },

  // ── Bucket 4: error recovery (3) ──────────────────────────────────────
  {
    id: 'E1-missing-repo', bucket: 'error',
    text: "Look up the github.com/totally-fake-account-12345/no-such-repo repo. If the lookup fails, reply with the word 'NOTFOUND' and nothing else.",
    expect: /NOTFOUND|not found|404/i,
  },
  {
    id: 'E2-non-word', bucket: 'error',
    text: "Look up the dictionary entry for 'asdfqwerty'. If there is no entry, reply with the word 'UNKNOWN' and nothing else.",
    expect: /UNKNOWN|no.*entry|not found/i,
  },
  {
    id: 'E3-schema-discovery', bucket: 'error',
    text: "Use the weather skill to get the current temperature in celsius at coordinates 0,0. Read the tool's output schema if you don't know the field name. Reply with just the integer rounded down (no decimal, no unit).",
    expect: /^-?\d+/m,
  },

  // ── Bucket 5: tool-use discipline (5) ─────────────────────────────────
  // Each query is answerable from training knowledge alone. `without_tool`
  // is the disciplined outcome here. `via_tool` for these means the model
  // over-reached for a tool when it didn't need one.
  {
    id: 'D1-capital', bucket: 'discipline', expectNoTool: true,
    text: "What's the capital of Spain? Reply with just the city name.",
    expect: /Madrid/i,
  },
  {
    id: 'D2-arithmetic', bucket: 'discipline', expectNoTool: true,
    text: "What's 7 multiplied by 8? Reply with just the integer.",
    expect: /\b56\b/,
  },
  {
    id: 'D3-language-of-word', bucket: 'discipline', expectNoTool: true,
    text: "Which language is the word 'merci' from? Reply with just the language name.",
    expect: /French/i,
  },
  {
    id: 'D4-past-tense', bucket: 'discipline', expectNoTool: true,
    text: "What's the past tense of the English verb 'run'? Reply with just the verb.",
    expect: /^ran\b/im,
  },
  {
    id: 'D5-spell-uppercase', bucket: 'discipline', expectNoTool: true,
    text: "Spell the word 'mississippi' in uppercase. Reply with just the uppercased spelling.",
    expect: /MISSISSIPPI/,
  },

  // ── Bucket 6: ambiguous tool choice — 2+ skills could answer (3) ──────
  {
    id: 'A1-repo-vs-url', bucket: 'ambiguous',
    text: "What's the primary language of github.com/torvalds/linux? Reply with just the language name.",
    expect: /\bC\b/,
  },
  {
    id: 'A2-define-vs-fetch', bucket: 'ambiguous',
    text: "Define the word 'lexicon'. Reply with just the definition (one sentence).",
    expect: /vocabulary|words|dictionary|terms/i,
  },
  {
    id: 'A3-coords-from-knowledge', bucket: 'ambiguous',
    text: "Get the current temperature in celsius at the geographic coordinates of New York City. Reply with just the integer (rounded down, no unit).",
    expect: /^-?\d+/m,
  },
];

/**
 * Resolve which suite to run from a string identifier (typically env SUITE).
 * Returns `null` when the identifier matches no known suite or bucket.
 */
export function selectSuite(suite: string): Query[] | null {
  const s = suite.toLowerCase();
  if (s === 'basic') return QUERIES_BASIC;
  if (s === 'full')  return QUERIES_FULL;
  const filtered = QUERIES_FULL.filter((q) => q.bucket === s);
  return filtered.length > 0 ? filtered : null;
}
