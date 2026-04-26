/**
 * types/index.ts — shared TypeScript types for the agentic-tools-poc.
 *
 * The PHILOSOPHY.md argues that skills are owned by the agent's author
 * and ship with their five layers of context as one artifact. These types
 * are the structural contract that makes that ownership type-safe.
 */

// ---------------------------------------------------------------------------
// JSONSchema (subset we actually use — full draft-07 would be enormous)

export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  required?: string[];
  enum?: ReadonlyArray<string | number | boolean>;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  items?: JSONSchema;
  additionalProperties?: boolean | JSONSchema;
}

// ---------------------------------------------------------------------------
// Skill descriptors (registry → loader → MCP)

export type SideEffect = 'none' | 'read' | 'write' | 'destructive';

export interface NetworkPolicy {
  allow: string[];
}

/**
 * Per-model override block. Keys are model-name substrings (case-insensitive).
 * Only the listed fields are merged onto the tool descriptor.
 * `system_prompt_fragments` is special: it's collected across all skills
 * by `getSystemPromptFragments` rather than merged into a single tool.
 */
export interface ModelOverride {
  summary?: string;
  description?: string;
  inputSchema?: JSONSchema;
  system_prompt_fragments?: string[];
}

/**
 * The shape of every entry in `dist/manifest.json`.
 */
export interface SkillDef {
  slug: string;
  name: string;
  summary: string;
  description?: string;
  version: string;
  capabilities?: string[];
  sideEffects?: SideEffect;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  requiredEnv?: string[];
  networkPolicy?: NetworkPolicy;
  model_overrides?: Record<string, ModelOverride>;
  /** Path within the manifest base URL where the bundled .mjs lives. */
  source: string;
  /** SHA-256 hex digest of the bundle contents at manifest-build time.
   *  The loader verifies this before importing — protects against tampering
   *  with the dist branch / CDN caching of a hostile commit. */
  sha256?: string;
  /** Maximum number of characters of stdout to forward back to the LLM.
   *  Limits the blast radius of prompt-injection payloads in skill output
   *  (THREAT-MODEL.md V5). Output beyond the cap is truncated with a marker
   *  before delimiter-wrapping. Skill authors should pick a cap that fits
   *  the legitimate output of their skill — url2md (markdown extraction) is
   *  the natural injection vector and ships with a tight cap by default. */
  outputCap?: number;
  /** Historical versions of this skill, in semver order (highest first).
   *  Each entry corresponds to a `dist/skills/<slug>@<version>.mjs` bundle
   *  preserved across builds. The top-level `source` + `sha256` always
   *  point at the latest version; consumers that want to pin a specific
   *  version pass `loadRegistry({ pin: { <slug>: '<range>' }})` and the
   *  loader resolves the range against this list.
   *
   *  Always populated by `scripts/manifest.ts` when versioned bundles
   *  exist; absent on fresh builds where only the latest exists. */
  versions?: SkillVersionEntry[];
}

export interface SkillVersionEntry {
  /** Semver of this archived bundle (matches the `version` field in the
   *  tool.yaml at the time it was published). */
  version: string;
  /** Path within the manifest base URL (e.g. `skills/echo-pretty@1.0.0.mjs`). */
  source: string;
  /** sha256 of the bundle bytes — same integrity contract as the top-level. */
  sha256: string;
}

export interface Manifest {
  registryVersion: string;
  generatedAt: string;
  commit: string | null;
  tools: SkillDef[];
}

// ---------------------------------------------------------------------------
// Skill handler contract (what `registry/skills/<slug>/src/index.ts` exports)

export interface ToolContext {
  fetch: typeof fetch;
  env: Record<string, string>;
  log: (msg: string) => void;
}

export type SkillHandler<I = unknown, O = unknown> = (
  input: I,
  ctx: ToolContext,
) => Promise<O>;

// ---------------------------------------------------------------------------
// Bash result + smart-bash observation

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ToolReference {
  slug: string;
  output_schema: JSONSchema | undefined;
  example: unknown;
  jq_paths: string[];
}

export interface SchemaCheck {
  validated: boolean;
  ok?: boolean;
  reason?: string;
  errors?: string[];
}

export interface Observation {
  exitCode: number;
  stdout: string;
  stderr: string;
  tools_referenced?: ToolReference[];
  schema_check?: SchemaCheck;
  diagnostics?: string[];
}

// ---------------------------------------------------------------------------
// Model-adapter normalization (Granite/Hermes/Gemma → one shape)

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface UsageStats {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface NormalizedReply {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage: UsageStats | null;
  /** Tokens reported by the model (0 = use estimate). */
  reportedTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// llms.txt ## Skills section parsing

export interface SkillEntryMetadata {
  version?: string;
  sha256?: string;
  license?: string;
  homepage?: string;
  requires?: string[];
}

export interface SkillEntry {
  title: string;
  url: string;
  description: string;
  metadata: SkillEntryMetadata;
}

/**
 * The thing returned by `loadDomainSkills` for each entry. Combines info
 * from the llms.txt link line with the parsed SKILL.md frontmatter+body.
 */
export interface DiscoveredSkill {
  name: string;
  description: string;
  version: string | null;
  license: string | null;
  homepage: string | null;
  source_domain: string;
  llms_txt_url: string;
  skill_url: string;
  sha256: string | null;
  verified: boolean;
  llms_txt_metadata: SkillEntryMetadata;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export interface DomainSkillsResult {
  domain: string;
  llms_txt_url: string;
  skills: DiscoveredSkill[];
}

// ---------------------------------------------------------------------------
// Internal helpers

/** A function that takes a tool_call and returns whatever observation shape
 *  the caller's loop expects. Used by compare.ts's runLoop signature. */
export type ToolExecutor = (tc: ToolCall) => Promise<unknown>;
