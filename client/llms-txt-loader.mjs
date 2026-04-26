/**
 * llms-txt-loader.mjs — first independent consumer of the proposed `## Skills`
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

/**
 * Discover skills published by a domain via the proposed `## Skills` section.
 *
 * @param {string} domain  Origin URL, e.g. "https://img.automators.work"
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]   Cancellation
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ domain: string, llms_txt_url: string, skills: Skill[] }>}
 */
export async function loadDomainSkills(domain, opts = {}) {
  const log  = opts.log ?? (() => {});
  const base = String(domain).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('domain must be an absolute http(s) URL');

  const llmsUrl = `${base}/llms.txt`;
  log(`GET ${llmsUrl}`);
  const llmsText = await fetchText(llmsUrl, opts.signal);

  const entries = parseSkillsSection(llmsText);
  log(`Found ${entries.length} skill entr${entries.length === 1 ? 'y' : 'ies'} in ## Skills`);

  const skills = [];
  for (const entry of entries) {
    const url = absolutize(entry.url, base);

    // Per RFC §2.1, archives are permitted but bundled SKILL.md files are
    // out of scope for v1 of this loader (would require streaming unzip).
    if (/\.(zip|tar\.gz|tgz)$/i.test(url)) {
      log(`  skip ${entry.title}: archive bundles not yet supported (${url})`);
      continue;
    }

    log(`  GET ${url}`);
    let skillText;
    try {
      skillText = await fetchText(url, opts.signal);
    } catch (e) {
      log(`  FAIL ${entry.title}: ${e.message}`);
      continue;
    }

    // sha256 verification per RFC §2.2
    if (entry.metadata?.sha256) {
      const actual = sha256Hex(skillText);
      if (actual !== entry.metadata.sha256) {
        log(`  FAIL ${entry.title}: sha256 mismatch (declared ${entry.metadata.sha256.slice(0,12)}…, actual ${actual.slice(0,12)}…)`);
        continue;
      }
    }

    const { frontmatter, body } = parseSkillFile(skillText);

    skills.push({
      // Identifying fields — name from frontmatter wins, fall back to llms.txt title
      name:        frontmatter.name ?? entry.title,
      description: frontmatter.description ?? entry.description,
      version:     frontmatter.version ?? entry.metadata?.version ?? null,
      license:     frontmatter.license ?? entry.metadata?.license ?? null,
      homepage:    frontmatter.homepage ?? null,

      // Provenance
      source_domain: base,
      llms_txt_url:  llmsUrl,
      skill_url:     url,
      sha256:        entry.metadata?.sha256 ?? null,
      verified:      Boolean(entry.metadata?.sha256), // sha256 was checked if present

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
export function parseSkillsSection(text) {
  // Find the heading line, then capture until the next ## or # heading
  const headingRe = /^##\s+skills\s*$/im;
  const headingMatch = text.match(headingRe);
  if (!headingMatch) return [];

  const start = headingMatch.index + headingMatch[0].length;
  const rest  = text.slice(start);
  const nextHeading = rest.match(/^#{1,2}\s+\S/m);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  // Each entry: - [title](url): description [optional <!-- skill: {...} -->]
  const entries = [];
  const lineRe  = /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/gm;
  let m;
  while ((m = lineRe.exec(section)) !== null) {
    let [, title, url, tail] = m;
    let metadata = {};

    // Pull off optional trailing HTML metadata comment
    const metaMatch = tail.match(/<!--\s*skill:\s*(\{[\s\S]*?\})\s*-->/);
    if (metaMatch) {
      try { metadata = JSON.parse(metaMatch[1]); } catch { /* ignore malformed */ }
      tail = tail.slice(0, metaMatch.index).trim();
    }

    entries.push({
      title:       title.trim(),
      url:         url.trim(),
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
export function parseSkillFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  let frontmatter = {};
  try { frontmatter = parseYaml(m[1]) ?? {}; } catch { /* tolerate malformed */ }
  return { frontmatter, body: m[2] ?? '' };
}

// ---------------------------------------------------------------------------
// helpers

async function fetchText(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

function absolutize(maybeRelative, base) {
  if (/^https?:\/\//.test(maybeRelative)) return maybeRelative;
  return new URL(maybeRelative, base + '/').toString();
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
