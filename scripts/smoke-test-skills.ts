#!/usr/bin/env node
/**
 * smoke-test-skills.ts — calls each new skill handler directly against its
 * upstream API to verify the wrapper actually works end-to-end. NOT part
 * of `npm run all` (network-dependent). Run on demand.
 *
 *   node scripts/smoke-test-skills.ts
 */
import githubHandler from '../registry/skills/github-repo-info/src/index.ts';
import weatherHandler from '../registry/skills/weather/src/index.ts';
import dictionaryHandler from '../registry/skills/dictionary/src/index.ts';
import type { ToolContext } from '../types/index.ts';

function makeCtx(name: string, allowedHosts: string[]): ToolContext {
  const allow = new Set(allowedHosts);
  return {
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const host = new URL(u).host;
      if (!allow.has(host)) throw new Error(`network: ${host} not allowed for ${name}`);
      return globalThis.fetch(url, init);
    }) as typeof fetch,
    env: {},
    log: (m: string) => console.error(`  [${name}] ${m}`),
  };
}

const banner = (s: string) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  banner(name);
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ ${name}: ${msg}`);
    failed++;
  }
}

await run('github-repo-info: cloudflare/workers-sdk', async () => {
  const out = await githubHandler(
    { owner: 'cloudflare', repo: 'workers-sdk' },
    makeCtx('github-repo-info', ['api.github.com']),
  );
  console.log(out);
  if (!out.full_name?.includes('cloudflare/workers-sdk')) throw new Error('full_name missing');
  if (typeof out.stars !== 'number') throw new Error('stars not a number');
});

await run('weather: Madrid (40.42, -3.70)', async () => {
  const out = await weatherHandler(
    { latitude: 40.4168, longitude: -3.7038 },
    makeCtx('weather', ['api.open-meteo.com']),
  );
  console.log(out);
  if (out.location !== '40.4168,-3.7038') throw new Error('location wrong');
  if (typeof out.temp_c !== 'number') throw new Error('temp not a number');
});

await run('dictionary: ephemeral', async () => {
  const out = await dictionaryHandler(
    { word: 'ephemeral' },
    makeCtx('dictionary', ['api.dictionaryapi.dev']),
  );
  console.log(`${out.word} ${out.phonetic}`);
  for (const m of out.meanings ?? []) {
    console.log(`  ${m.partOfSpeech}: ${m.definition?.slice(0, 80)}…`);
  }
  if (!out.meanings?.length) throw new Error('no meanings returned');
});

await run('weather: invalid coords (negative path)', async () => {
  try {
    await weatherHandler({ latitude: 200, longitude: 0 }, makeCtx('weather', ['api.open-meteo.com']));
    throw new Error('expected validation to throw');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/out of range/.test(msg)) throw new Error(`wrong error message: ${msg}`);
    console.log(`got expected error: ${msg}`);
  }
});

await run('dictionary: phrase rejection (negative path)', async () => {
  try {
    await dictionaryHandler({ word: 'hello world' }, makeCtx('dictionary', ['api.dictionaryapi.dev']));
    throw new Error('expected validation to throw');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/phrase/.test(msg)) throw new Error(`wrong error message: ${msg}`);
    console.log(`got expected error: ${msg}`);
  }
});

console.log(`\n${'═'.repeat(70)}\n${passed} passed, ${failed} failed\n${'═'.repeat(70)}`);
process.exit(failed ? 1 : 0);
