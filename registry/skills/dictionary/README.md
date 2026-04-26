# dictionary

Wraps `https://api.dictionaryapi.dev/api/v2/entries/en/{word}`. Free, no
auth, no rate limit policy advertised. Returns one entry collapsed to:
the headword, IPA phonetic, and one definition + example per part of
speech.

## Usage

```bash
dictionary --word ephemeral
# → {
#     "word":"ephemeral",
#     "phonetic":"/ɪˈfɛm.ə.rəl/",
#     "meanings":[
#       {"partOfSpeech":"adjective","definition":"Lasting for a short time…","example":"…"}
#     ]
#   }
```

## Why a thin wrapper

The upstream returns deeply nested JSON: `[{ meanings: [{ definitions:
[...], synonyms: [], antonyms: [] }] }]`. Most agents looking up a word
need one definition per part of speech, not all 5+ alternative wordings
of each. Token diff: ~2KB upstream → ~250 bytes here.

## Composition

Pairs naturally with `echo-pretty` for formatting, or with a downstream
LLM call for translation:

```bash
dictionary --word "ephemeral" | jq -r '.meanings[0].definition'
```
