/**
 * llms-txt-loader.ts — first independent consumer of the proposed `## Skills`
 * extension to the llms.txt spec.
 *
 *   RFC:    https://img.automators.work/docs/rfc-skills-in-llms-txt.md
 *   Issue:  https://github.com/AnswerDotAI/llms-txt/issues/116
 *
 * Implements §2.1 (parsing rules) and §2.3 (discovery flow) from the RFC.
 * Given a domain, fetches /llms.txt, extracts the optional ## Skills section,
 * resolves each linked SKILL.md, parses its YAML frontmatter, and returns
 * structured skill descriptors ready for an agent to surface to the user.
 *
 * Trust posture: this loader does NOT auto-execute or auto-install skills.
 * It returns descriptors; the caller decides what to do (per RFC §2.3 step 5,
 * agents must require explicit user opt-in before activation).
 */
import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import type {
  DiscoveredSkill,
  DomainSkillsResult,
  SkillEntry,
  SkillEntryMetadata,
} from '../types/index.ts';

interface LoadOptions {
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/**
 * Discover skills published by a domain via the proposed `## Skills` section.
 */
export async function loadDomainSkills(
  domain: string,
  opts: LoadOptions = {},
): Promise<DomainSkillsResult> {
  const log = opts.log ?? (() => {});
  const base = String(domain).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('domain must be an absolute http(s) URL');

  const llmsUrl = `${base}/llms.txt`;
  log(`GET ${llmsUrl}`);
  const llmsText = await fetchText(llmsUrl, opts.signal);

  const entries = parseSkillsSection(llmsText);
  log(`Found ${entries.length} skill entr${entries.length === 1 ? 'y' : 'ies'} in ## Skills`);

  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    const url = absolutize(entry.url, base);

    // Per RFC §2.1, archives are permitted but bundled SKILL.md files are
    // out of scope for v1 of this loader (would require streaming unzip).
    if (/\.(zip|tar\.gz|tgz)$/i.test(url)) {
      log(`  skip ${entry.title}: archive bundles not yet supported (${url})`);
      continue;
    }

    log(`  GET ${url}`);
    let skillText: string;
    try {
      skillText = await fetchText(url, opts.signal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  FAIL ${entry.title}: ${msg}`);
      continue;
    }

    // sha256 verification per RFC §2.2
    if (entry.metadata?.sha256) {
      const actual = sha256Hex(skillText);
      if (actual !== entry.metadata.sha256) {
        log(`  FAIL ${entry.title}: sha256 mismatch (declared ${entry.metadata.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
        continue;
      }
    }

    const { frontmatter, body } = parseSkillFile(skillText);

    skills.push({
      // Identifying fields — name from frontmatter wins, fall back to llms.txt title
      name: (frontmatter.name as string | undefined) ?? entry.title,
      description: (frontmatter.description as string | undefined) ?? entry.description,
      version: (frontmatter.version as string | undefined) ?? entry.metadata?.version ?? null,
      license: (frontmatter.license as string | undefined) ?? entry.metadata?.license ?? null,
      homepage: (frontmatter.homepage as string | undefined) ?? null,

      // Provenance
      source_domain: base,
      llms_txt_url: llmsUrl,
      skill_url: url,
      sha256: entry.metadata?.sha256 ?? null,
      verified: Boolean(entry.metadata?.sha256),

      // Full payload — caller decides how to use
      llms_txt_metadata: entry.metadata,
      frontmatter,
      body,
      raw: skillText,
    });
  }

  return { domain: base, llms_txt_url: llmsUrl, skills };
}

// ---------------------------------------------------------------------------
// Parsing per RFC §2.1

/**
 * Extract entries from the `## Skills` section of an llms.txt body.
 * Section heading match is case-insensitive ("## Skills", "## skills", …).
 * Stops at the next heading of equal or higher rank.
 */
export function parseSkillsSection(text: string): SkillEntry[] {
  const headingRe = /^##\s+skills\s*$/im;
  const headingMatch = text.match(headingRe);
  if (!headingMatch?.index && headingMatch?.index !== 0) return [];

  const start = headingMatch.index! + headingMatch[0].length;
  const rest = text.slice(start);
  const nextHeading = rest.match(/^#{1,2}\s+\S/m);
  const section = nextHeading?.index !== undefined ? rest.slice(0, nextHeading.index) : rest;

  // Each entry: - [title](url): description [optional <!-- skill: {...} -->]
  const entries: SkillEntry[] = [];
  const lineRe = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(section)) !== null) {
    const title = m[1]!;
    const url = m[2]!;
    let tail = m[3] ?? '';
    let metadata: SkillEntryMetadata = {};

    // Pull off optional trailing HTML metadata comment
    const metaMatch = tail.match(/<!--\s*skill:\s*(\{[\s\S]*?\})\s*-->/);
    if (metaMatch?.[1]) {
      try { metadata = JSON.parse(metaMatch[1]) as SkillEntryMetadata; } catch { /* ignore malformed */ }
      tail = tail.slice(0, metaMatch.index!).trim();
    }

    entries.push({
      title: title.trim(),
      url: url.trim(),
      description: tail.replace(/[:\s]+$/, '').trim(),
      metadata,
    });
  }
  return entries;
}

/**
 * Split an Anthropic-style SKILL.md into YAML frontmatter + body.
 * If no frontmatter delimiter is found, body is the whole file.
 */
export function parseSkillFile(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (parseYaml(m[1] ?? '') as Record<string, unknown>) ?? {};
  } catch {
    /* tolerate malformed */
  }
  return { frontmatter, body: m[2] ?? '' };
}

// ---------------------------------------------------------------------------
// helpers

async function fetchText(url: string, signal: AbortSignal | undefined): Promise<string> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

function absolutize(maybeRelative: string, base: string): string {
  if (/^https?:\/\//.test(maybeRelative)) return maybeRelative;
  return new URL(maybeRelative, base + '/').toString();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
