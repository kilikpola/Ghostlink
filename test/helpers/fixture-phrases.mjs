/**
 * Recovery-phrase test fixtures, built at run time from word-list indices so no
 * source file holds a seed-phrase-shaped string (see seed-leak-test.js).
 *
 * Throwaway values: never use them for a real identity.
 */
import { BIP39_WORDS } from '../../shared/wordlist.js';

const words = (indices) => Object.freeze(indices.map((i) => BIP39_WORDS[i]));

/** Pinned: ghost address GHOST-Z3H-NMX-81T (phrase-roundtrip, ghost-address-kdf). */
export const FIXTURE_A = words([9, 1151, 1914, 273, 1937, 1234, 729, 1904, 709, 1223, 1947, 576]);

/** Mobile crypto / ghost-address / text-encoding fixture. */
export const FIXTURE_B = words([2002, 179, 526, 1457, 1, 1852, 1723, 1057, 1510, 1797, 548, 730]);

/** The BIP-39 all-zero-entropy test vector: word 0 eleven times, then word 3. */
export const FIXTURE_ZERO = words([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
