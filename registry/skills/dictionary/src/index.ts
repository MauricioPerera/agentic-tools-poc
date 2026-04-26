/**
 * dictionary — wraps the free dictionaryapi.dev English dictionary API.
 *
 * Upstream returns an array of entry objects, each with a deeply-nested
 * `meanings[].definitions[]` array. We collapse to one definition per
 * part of speech (the first non-empty one), which is what most agents
 * actually use.
 *
 * Defensive layer: trim and lowercase the input, reject phrases.
 *
 * Input/Output types come from `./types.gen.ts` — auto-generated from
 * `tool.yaml`. To change the contract, edit the YAML and run `npm run codegen`.
 */
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';

interface DictDefinition {
  definition?: string;
  example?: string;
}
interface DictMeaning {
  partOfSpeech?: string;
  definitions?: DictDefinition[];
}
interface DictPhonetic {
  text?: string;
}
interface DictEntry {
  word?: string;
  phonetic?: string;
  phonetics?: DictPhonetic[];
  meanings?: DictMeaning[];
}

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  const word = String(input.word ?? '').trim().toLowerCase();
  if (!word) throw new Error('word is required');
  if (/\s/.test(word)) throw new Error(`"${input.word}" looks like a phrase — pass a single word`);

  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  ctx.log(`GET ${url}`);

  const res = await ctx.fetch(url);
  if (res.status === 404) throw new Error(`no dictionary entry for "${word}"`);
  if (!res.ok) throw new Error(`dictionaryapi.dev returned ${res.status}`);

  const data = (await res.json()) as DictEntry[];
  const entry = data[0];
  if (!entry) throw new Error(`empty response for "${word}"`);

  // Pick a phonetic from either the top-level field or the first non-empty
  // entry in the phonetics[] array.
  const phonetic =
    entry.phonetic?.trim() ||
    entry.phonetics?.find((p) => p.text?.trim())?.text?.trim() ||
    '';

  const meanings = (entry.meanings ?? []).map((m) => ({
    partOfSpeech: m.partOfSpeech ?? '',
    definition:   m.definitions?.[0]?.definition ?? '',
    example:      m.definitions?.find((d) => d.example?.trim())?.example?.trim() ?? '',
  }));

  const out: Output = {
    word: entry.word ?? word,
    phonetic,
    meanings,
  };
  return out;
};

export default handler;
