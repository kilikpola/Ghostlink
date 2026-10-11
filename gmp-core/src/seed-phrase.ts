/**
 * The one CSPRNG-backed seed-phrase generator, outside cli.ts so tooling can
 * use it without running the CLI.
 */

import crypto from 'crypto';
import { BIP39_WORDS } from './bip39-english.js';

/** Uniform random index in [0, max) via rejection sampling (no modulo bias). */
function secureRandomIndex(max: number): number {
  const webCrypto = globalThis.crypto || (crypto as unknown as { webcrypto: Crypto }).webcrypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    // A predictable seed phrase is a predictable identity key. There is no
    // safe degraded mode here, so fail loudly instead of producing one.
    throw new Error('No secure random source available — refusing to generate a seed phrase.');
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    webCrypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

/** Generate a 12-word recovery phrase: the node's master identity. */
export function generateSeedPhrase(): string {
  const words: string[] = [];
  for (let i = 0; i < 12; i++) {
    words.push(BIP39_WORDS[secureRandomIndex(BIP39_WORDS.length)]);
  }
  return words.join(' ');
}

