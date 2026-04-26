// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Look up an English word's definitions, parts of speech, phonetic, and example sentences. */
export interface Input {
  /** Single English word to look up. No spaces or phrases. */
  word: string;
}

/** Skill output */
export interface Output {
  /** The headword (echoed back, lowercased). */
  word?: string;
  /** IPA phonetic transcription if available, else empty. */
  phonetic?: string;
  /** One entry per part of speech (noun, verb, etc). */
  meanings?: Array<{
    /** noun | verb | adjective | adverb | … */
    partOfSpeech?: string;
    /** Primary definition for this part of speech. */
    definition?: string;
    /** Example sentence if available, else empty. */
    example?: string;
  }>;
}
