/**
 * generateSeedPhrase produces BIP-39 phrases (identity-v2.md §9, R1b):
 * 128 bits from crypto.getRandomValues, a SHA-256 checksum, 12 words.
 * Derivation is untouched: a pinned fixture phrase keeps its NodeID.
 *
 * Phrases are built from word indices and never printed (seed-leak-test).
 *
 * Run: node test/seed-phrase-bip39-test.js
 */
import crypto from 'crypto';
import { BIP39_WORDS } from '../dist/bip39-english.js';
import { generateSeedPhrase } from '../dist/seed-phrase.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };

const phraseOf = (indices) => indices.map((i) => BIP39_WORDS[i]).join(' ');

/** Independent BIP-39 decode: { entropy, checksumOk } or null if a word is off the list. */
function decode(phrase) {
  const idx = phrase.split(' ').map((w) => BIP39_WORDS.indexOf(w));
  if (idx.length !== 12 || idx.some((i) => i < 0)) return null;
  const bits = idx.map((i) => i.toString(2).padStart(11, '0')).join('');
  const entropy = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const expected = crypto.createHash('sha256').update(entropy).digest()[0] >> 4;
  return { entropy, checksumOk: parseInt(bits.slice(128), 2) === expected };
}

console.log('\n=== derivation is unchanged: pinned NodeID ===');
{
  // FIXTURE_A in test/helpers/fixture-phrases.mjs (GHOST-Z3H-NMX-81T).
  const fixtureA = phraseOf([9, 1151, 1914, 273, 1937, 1234, 729, 1904, 709, 1223, 1947, 576]);
  const PINNED = 'f8e35a7501d17b3b0f8cbca44e3b6339f31ce77dead8aa567639a0edbc7819a7'
    + '2134af3ca8ec348ee82269d05efb020d860a3e1f9c3fedea5a288410ebc41f2e';
  const { nodeIdHex } = await deriveIdentityFromSeedPhrase(fixtureA);
  assert(nodeIdHex === PINNED, `fixture phrase still derives NodeID ${PINNED.slice(0, 16)}… (got ${nodeIdHex.slice(0, 16)}…)`);
}

console.log('\n=== 1000 generated phrases are all BIP-39 checksum-valid ===');
{
  let valid = 0, onList = 0;
  for (let i = 0; i < 1000; i++) {
    const d = decode(generateSeedPhrase());
    if (d) onList++;
    if (d && d.checksumOk) valid++;
  }
  assert(onList === 1000, `${onList}/1000 are 12 list words`);
  assert(valid === 1000, `${valid}/1000 pass the BIP-39 checksum (a non-BIP-39 generator passes ~1/16)`);
}

console.log('\n=== entropy comes from crypto.getRandomValues, 16 bytes, encoded per BIP-39 ===');
{
  const webCrypto = globalThis.crypto;
  const real = webCrypto.getRandomValues;
  const calls = [];
  const run = (fill) => {
    Object.defineProperty(webCrypto, 'getRandomValues', {
      configurable: true, writable: true,
      value: (buf) => { calls.push(buf.byteLength); new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).fill(fill); return buf; },
    });
    try { return generateSeedPhrase(); } finally { delete webCrypto.getRandomValues; }
  };
  try {
    const zero = run(0x00);
    assert(zero === phraseOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]), 'all-zero entropy gives the BIP-39 test vector (word 0 x11, word 3)');
    assert(calls.length === 1 && calls[0] === 16, `one getRandomValues call for 16 bytes (calls: ${JSON.stringify(calls)})`);
    const ff = decode(run(0xff));
    assert(!!ff && ff.entropy.equals(Buffer.alloc(16, 0xff)) && ff.checksumOk, 'all-0xff entropy round-trips with a valid checksum');
  } finally {
    if (webCrypto.getRandomValues !== real) Object.defineProperty(webCrypto, 'getRandomValues', { value: real, configurable: true, writable: true });
  }
}

console.log('\n=== no secure random source: refuses rather than degrade ===');
{
  const webCrypto = globalThis.crypto;
  Object.defineProperty(webCrypto, 'getRandomValues', { configurable: true, writable: true, value: undefined });
  let threw = false;
  try { generateSeedPhrase(); } catch { threw = true; } finally { delete webCrypto.getRandomValues; }
  assert(threw, 'generateSeedPhrase throws without getRandomValues');
  assert(typeof globalThis.crypto.getRandomValues === 'function', 'stub removed');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
