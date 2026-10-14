/**
 * Seed-phrase leak detection: finds a phrase in text so the logger can
 * withhold the line. Reports where, never the phrase.
 *
 * A phrase is SEED_WORDS consecutive word-list words separated by short runs
 * of non-letters (SEPARATOR); common prose words are not on the list.
 */

import { ACCEPTED_WORDS } from './bip39-english.js';

export const SEED_WORDS = 12;

const WORD = /[A-Za-z]+/g;
// Any short run of non-letters except sentence punctuation: covers spaces,
// newlines, ["w1","w2"], and {"0":"w1","1":"w2"} (an array that went through
// an object spread), while a full stop still ends a run.
const SEPARATOR = /^[^A-Za-z.!?]{1,12}$/;

/** Every run of at least SEED_WORDS accepted words in `text`: offset and words. */
export function seedRuns(text: string): Array<{ at: number; words: string[] }> {
  const runs: Array<{ at: number; words: string[] }> = [];
  let words: string[] = [];
  let start = -1;
  let prevEnd = -1;
  const flush = () => { if (words.length >= SEED_WORDS) runs.push({ at: start, words }); words = []; };
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    const joined = prevEnd >= 0 && SEPARATOR.test(text.slice(prevEnd, m.index));
    if (ACCEPTED_WORDS.has(m[0].toLowerCase())) {
      if (!(words.length > 0 && joined)) { flush(); start = m.index; }
      words.push(m[0].toLowerCase());
    } else {
      flush();
    }
    prevEnd = m.index + m[0].length;
  }
  flush();
  return runs;
}

/** Offset of the first run of SEED_WORDS accepted words in `text`, or -1. */
export function findSeedPhrase(text: string): number {
  const runs = seedRuns(text);
  return runs.length ? runs[0].at : -1;
}

/**
 * Secrets registered at runtime, consulted by containsSeedPhrase in addition to
 * the caller's list. A `derivedSeed` node has no seed phrase and no configured
 * GMP_SEED_PHRASE, so the logger's static [env, config] list cannot match its
 * raw seed; the node registers that seed's hex and base64 here so either form is
 * withheld wherever it appears. Hex (64) and base64 (44) clear the 8-char floor.
 */
const registeredSecrets = new Set<string>();

/** Withhold any log line containing `value`. No-op for values under 8 chars. */
export function registerSensitiveValue(value: string): void {
  const v = (value || '').trim();
  if (v.length >= 8) registeredSecrets.add(v);
}

/**
 * True if `text` holds a seed phrase: a run of accepted words, any of
 * `knownSecrets` verbatim, or any runtime-registered secret (a configured or
 * derived seed need not be made of list words).
 */
export function containsSeedPhrase(text: string, knownSecrets: ReadonlyArray<string | undefined> = []): boolean {
  for (const s of knownSecrets) if (s && s.trim().length >= 8 && text.includes(s.trim())) return true;
  for (const s of registeredSecrets) if (text.includes(s)) return true;
  return findSeedPhrase(text) >= 0;
}
