/**
 * semver-pin.ts — minimal semver range matcher for the loader's `pin` map.
 *
 * Why minimal: the registry's needs are narrow (skill authors bump
 * patch/minor for fixes, major for breaking shape changes; consumers want
 * to lock at a known-good range) and pulling in a full semver lib (`semver`
 * is ~50 KB after bundling, with a long dep chain) would inflate the
 * runtime cost of a fetch-tiny-WASM-and-go architecture for one feature.
 *
 * Supported range syntax (more than enough for the catalog scale):
 *   '1.2.3'         — exact match
 *   '^1.2.3'        — >=1.2.3 <2.0.0   (compatible-with, the npm default)
 *   '~1.2.3'        — >=1.2.3 <1.3.0   (only patches)
 *   '*' / 'latest'  — any version (returns the highest)
 *
 * NOT supported (intentional — would invite scope creep):
 *   pre-release tags ('1.2.3-beta')
 *   build metadata  ('1.2.3+sha')
 *   range expressions ('>=1.0.0 <2.0.0', '1.x', '||')
 *
 * If a real registry needs those later, swap this for the `semver` package
 * — the public API is just `parseRange` and `resolveBest`.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ParsedRange {
  /** Inclusive lower bound (the version that the range starts AT). */
  min: ParsedVersion;
  /** Exclusive upper bound. `null` means unbounded (used by `*`). */
  maxExclusive: ParsedVersion | null;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(s: string): ParsedVersion {
  const m = VERSION_RE.exec(s.trim());
  if (!m) throw new Error(`invalid semver: "${s}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Parse a range expression into [min, maxExclusive]. */
export function parseRange(range: string): ParsedRange {
  const r = range.trim();
  if (r === '*' || r === 'latest') {
    return { min: { major: 0, minor: 0, patch: 0 }, maxExclusive: null };
  }
  if (r.startsWith('^')) {
    const v = parseVersion(r.slice(1));
    // ^1.2.3 → >=1.2.3 <2.0.0  (and ^0.x.y is special: ^0.2.3 → >=0.2.3 <0.3.0)
    const upper = v.major === 0
      ? { major: 0, minor: v.minor + 1, patch: 0 }
      : { major: v.major + 1, minor: 0, patch: 0 };
    return { min: v, maxExclusive: upper };
  }
  if (r.startsWith('~')) {
    const v = parseVersion(r.slice(1));
    // ~1.2.3 → >=1.2.3 <1.3.0
    return { min: v, maxExclusive: { major: v.major, minor: v.minor + 1, patch: 0 } };
  }
  // Plain version → exact match (treat as a one-version range).
  const v = parseVersion(r);
  return {
    min: v,
    maxExclusive: { major: v.major, minor: v.minor, patch: v.patch + 1 },
  };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isInRange(version: ParsedVersion, range: ParsedRange): boolean {
  if (compareVersions(version, range.min) < 0) return false;
  if (range.maxExclusive && compareVersions(version, range.maxExclusive) >= 0) return false;
  return true;
}

/**
 * Pick the highest version from `available` that satisfies `range`. Returns
 * the original (string) version so the caller can index back into a versions
 * map. Returns `null` if nothing matches.
 */
export function resolveBest(available: readonly string[], range: string): string | null {
  const parsedRange = parseRange(range);
  let best: { raw: string; parsed: ParsedVersion } | null = null;
  for (const v of available) {
    let parsed: ParsedVersion;
    try {
      parsed = parseVersion(v);
    } catch {
      continue; // skip malformed entries silently — manifest builder rejects them earlier
    }
    if (!isInRange(parsed, parsedRange)) continue;
    if (!best || compareVersions(parsed, best.parsed) > 0) best = { raw: v, parsed };
  }
  return best?.raw ?? null;
}
