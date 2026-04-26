#!/usr/bin/env node
/**
 * load-domain.mjs — CLI demo of the discovery flow proposed in
 *   https://github.com/AnswerDotAI/llms-txt/issues/116
 *
 * Implements §2.3 of https://img.automators.work/docs/rfc-skills-in-llms-txt.md
 * up to step 4 (surface skills to user). Steps 5-7 (opt-in, load, cache) are
 * the agent host's responsibility.
 *
 *   node client/load-domain.mjs https://img.automators.work
 *   node client/load-domain.mjs https://url2md.automators.work
 *   node client/load-domain.mjs https://example.com  --json
 */
import { loadDomainSkills } from './llms-txt-loader.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const verbose = args.includes('-v') || args.includes('--verbose');
const domain = args.find((a) => a.startsWith('http'));

if (!domain) {
  console.error('usage: load-domain.mjs <domain> [--json] [-v]');
  console.error('example: load-domain.mjs https://img.automators.work');
  process.exit(2);
}

const log = verbose ? (m) => console.error(`  [loader] ${m}`) : () => {};

try {
  const result = await loadDomainSkills(domain, { log });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }

  const banner = (s) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

  banner(`${result.domain}`);
  console.log(`llms.txt:  ${result.llms_txt_url}`);
  console.log(`Skills:    ${result.skills.length}`);

  for (const s of result.skills) {
    banner(`${s.name} ${s.version ? 'v' + s.version : ''}`);
    console.log(`description: ${s.description}`);
    console.log(`source:      ${s.skill_url}`);
    if (s.license)  console.log(`license:     ${s.license}`);
    if (s.homepage) console.log(`homepage:    ${s.homepage}`);
    if (s.sha256)   console.log(`sha256:      ${s.sha256.slice(0, 16)}… ${s.verified ? '✓ verified' : ''}`);
    console.log(`body:        ${s.body.length} chars`);

    // Show frontmatter at a glance — useful for debugging spec compliance
    const knownKeys = ['name', 'description', 'version', 'license', 'homepage'];
    const extras = Object.keys(s.frontmatter).filter((k) => !knownKeys.includes(k));
    if (extras.length) console.log(`extra frontmatter keys: ${extras.join(', ')}`);
  }

  if (!result.skills.length) {
    console.log(`\nNo \`## Skills\` section found in llms.txt at ${result.llms_txt_url}.`);
    console.log(`See https://github.com/AnswerDotAI/llms-txt/issues/116 for the proposed format.`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
