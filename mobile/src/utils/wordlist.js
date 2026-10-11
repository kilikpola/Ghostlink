/**
 * The mobile app's view of the recovery-phrase wordlist in shared/wordlist.js
 * (resolved via Metro's watchFolders). WORDLIST is BIP-39 only.
 */
export {
  BIP39_WORDS as WORDLIST,
  BIP39_WORDS,
  LEGACY_ONLY_WORDS,
  ACCEPTED_WORDS,
  SEED_PHRASE_WORDS,
  SEED_PHRASE_BITS,
  isAcceptedWord,
  isLegacyOnlyWord,
} from '../../../shared/wordlist.js';

export {BIP39_WORDS as default} from '../../../shared/wordlist.js';
