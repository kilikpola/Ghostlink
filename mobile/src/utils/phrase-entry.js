/**
 * Recovery-phrase entry: splitting, validating, autocompleting.
 *
 * Validation accepts ACCEPTED_WORDS (BIP-39 plus legacy words); autocomplete
 * offers BIP-39 only. There is no checksum, so the screen confirms the derived
 * Ghost Address instead.
 */

import {
  BIP39_WORDS,
  SEED_PHRASE_WORDS,
  isAcceptedWord,
  isLegacyOnlyWord,
} from './wordlist.js';

/** Split pasted text into candidate words, tolerating punctuation and case. */
export function splitPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * What is wrong with this phrase, if anything, by word position. `legacy`
 * lists positions holding accepted-but-no-longer-generated words.
 */
export function validatePhrase(words) {
  const filled = words.filter(w => w && w.trim());
  if (filled.length < SEED_PHRASE_WORDS) {
    return {ok: false, missing: SEED_PHRASE_WORDS - filled.length, unknown: [], legacy: []};
  }
  const unknown = [];
  const legacy = [];
  words.forEach((w, i) => {
    if (!isAcceptedWord(w)) unknown.push(i);
    else if (isLegacyOnlyWord(w)) legacy.push(i);
  });
  return {ok: unknown.length === 0, missing: 0, unknown, legacy};
}

/** Up to five BIP-39 suggestions for a partially typed word. */
export function suggestWords(prefix, limit = 5) {
  const p = String(prefix || '').trim().toLowerCase();
  if (p.length < 2) return [];
  const out = [];
  for (const w of BIP39_WORDS) {
    if (w.toLowerCase().startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}
