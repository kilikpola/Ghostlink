/**
 * The one CSPRNG-backed seed-phrase generator, outside cli.ts so tooling can
 * use it without running the CLI.
 */

import crypto from 'crypto';
import { sha256 } from '@noble/hashes/sha256';
import { BIP39_WORDS } from './bip39-english.js';

/** 128 bits from crypto.getRandomValues. */
function secureEntropy(): Uint8Array {
  const webCrypto = globalThis.crypto || (crypto as unknown as { webcrypto: Crypto }).webcrypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    // A predictable seed phrase is a predictable identity key. There is no
    // safe degraded mode here, so fail loudly instead of producing one.
    throw new Error('No secure random source available — refusing to generate a seed phrase.');
  }
  return webCrypto.getRandomValues(new Uint8Array(16));
}

/**
 * Generate a 12-word BIP-39 recovery phrase: the node's master identity.
 * 128 bits of entropy plus the first 4 bits of its SHA-256, split into twelve
 * 11-bit word indices. Restore still accepts older phrases without a valid
 * checksum (identity-v2.md D14); derivation is the same for both.
 */
export function generateSeedPhrase(): string {
  const entropy = secureEntropy();
  const checksum = sha256(entropy)[0] >> 4;
  let bits = 0n;
  for (const b of entropy) bits = (bits << 8n) | BigInt(b);
  bits = (bits << 4n) | BigInt(checksum);
  const words: string[] = [];
  for (let i = 11; i >= 0; i--) words.push(BIP39_WORDS[Number((bits >> BigInt(i * 11)) & 0x7ffn)]);
  return words.join(' ');
}
