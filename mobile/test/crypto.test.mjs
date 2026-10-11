/**
 * Mobile crypto checked for byte equality against Node's WebCrypto (what the
 * web app uses): hashes, public keys, AES-GCM payloads, derived keys.
 */
import {webcrypto} from 'crypto';
import assert from 'assert';
import {FIXTURE_B} from '../../test/helpers/fixture-phrases.mjs';

// Node exposes globalThis.crypto as a getter-only property; redefine it so the
// module under test sees the same shape react-native-get-random-values installs.
const setGlobalCrypto = v => Object.defineProperty(globalThis, 'crypto', {value: v, configurable: true, writable: true});
setGlobalCrypto(webcrypto);

const {sha256: nobleSha256} = await import('@noble/hashes/sha256');
const {hmac: nobleHmac} = await import('@noble/hashes/hmac');
const {pbkdf2Async} = await import('@noble/hashes/pbkdf2');
const {gcm} = await import('@noble/ciphers/aes');
const {p256} = await import('@noble/curves/p256');

const utf8 = s => new TextEncoder().encode(s);
const toHex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array((h.match(/.{2}/g) || []).map(b => parseInt(b, 16)));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const throws = async (name, fn) => {
  try { await fn(); fail++; console.log(`  FAIL ${name} (expected a throw)`); }
  catch { pass++; console.log(`  ok   ${name}`); }
};

// ── The module under test, with its RN-only import stubbed ───────────────────
const src = (await import('fs')).readFileSync(new URL('../src/utils/crypto.js', import.meta.url), 'utf8')
  .replace("import * as Keychain from 'react-native-keychain';", 'const Keychain = {};')
  // No native PBKDF2 under Node, so this exercises the @noble fallback path.
  .replace("import {NativeModules} from 'react-native';", 'const NativeModules = {};')
  // The copy lives in test/, so its relative import of the wordlist has to be
  // repointed at src/utils/. Node also needs the explicit .js that Metro infers.
  .replace("from './wordlist'", "from '../src/utils/wordlist.js'")
  .replace("from './ghost-address'", "from '../src/utils/ghost-address.js'");
// Written next to the test so the relative @noble imports resolve the same way
// they do from src/, then removed on exit.
const modPath = new URL('./.crypto-under-test.mjs', import.meta.url);
(await import('fs')).writeFileSync(modPath, src);
const C = (await import(modPath.href)).default;

console.log('\n[1] SHA-256 equals WebCrypto');
for (const input of ['', 'a', 'GhostLink', 'x'.repeat(1000), '🔒 unicode ✓']) {
  const mine = await C.sha256(input);
  const theirs = toHex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', utf8(input))));
  ok(`sha256(${JSON.stringify(input.slice(0, 12))}) matches WebCrypto`, mine === theirs);
}
ok('sha256 is 64 hex chars', /^[0-9a-f]{64}$/.test(await C.sha256('x')));
ok('sha256 is not the old FNV stub', (await C.sha256('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

console.log('\n[2] HMAC-SHA256 equals WebCrypto');
{
  const key = 'secret-key', msg = 'authenticated message';
  const k = await webcrypto.subtle.importKey('raw', utf8(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const theirs = toHex(new Uint8Array(await webcrypto.subtle.sign('HMAC', k, utf8(msg))));
  ok('hmacSha256 matches WebCrypto', C.hmacSha256(key, msg) === theirs);
}

console.log('\n[3] Randomness is real');
{
  const a = C.getRandomBytes(32), b = C.getRandomBytes(32);
  ok('32 bytes returned', a.length === 32);
  ok('two draws differ', toHex(a) !== toHex(b));
  const many = Array.from({length: 200}, () => toHex(C.getRandomBytes(16)));
  ok('200 draws are all distinct', new Set(many).size === 200);
  // The old implementation was Math.random(); seeding cannot make this reproducible.
  const counts = new Array(256).fill(0);
  for (const byte of C.getRandomBytes(20000)) counts[byte]++;
  const chi = counts.reduce((s, c) => s + (c - 20000 / 256) ** 2 / (20000 / 256), 0);
  ok(`byte distribution is uniform (chi-square ${chi.toFixed(1)} < 350)`, chi < 350);
}
await throws('throws when no CSPRNG is present', async () => {
  const saved = globalThis.crypto;
  setGlobalCrypto(undefined);
  try { C.getRandomBytes(8); } finally { setGlobalCrypto(saved); }
});

console.log('\n[4] P-256 keypairs are real pairs');
{
  const kp = C.generateKeyPair();
  ok('public key is 65-byte uncompressed point', /^04[0-9a-f]{128}$/.test(kp.publicKeyHex));
  ok('private key is 32 bytes', /^[0-9a-f]{64}$/.test(kp.privateKeyRaw));
  const derived = toHex(p256.getPublicKey(fromHex(kp.privateKeyRaw), false));
  ok('public key really derives from the private key', derived === kp.publicKeyHex);
  // WebCrypto must accept it as a P-256 point — the old random 65 bytes would not import.
  let imported = true;
  try {
    await webcrypto.subtle.importKey('raw', fromHex(kp.publicKeyHex), {name: 'ECDH', namedCurve: 'P-256'}, true, []);
  } catch { imported = false; }
  ok('WebCrypto imports it as a P-256 public key', imported);
  ok('two keypairs differ', C.generateKeyPair().privateKeyRaw !== kp.privateKeyRaw);
}

console.log('\n[5] ECDH agrees between both parties');
{
  const alice = C.generateKeyPair(), bob = C.generateKeyPair();
  const ab = C.deriveSharedKey(alice.privateKeyRaw, bob.publicKeyHex);
  const ba = C.deriveSharedKey(bob.privateKeyRaw, alice.publicKeyHex);
  ok('both sides derive the same secret', ab === ba);
  ok('shared secret is 32 bytes', /^[0-9a-f]{64}$/.test(ab));
  const eve = C.generateKeyPair();
  ok('a third party derives something different', C.deriveSharedKey(eve.privateKeyRaw, bob.publicKeyHex) !== ab);
}

console.log('\n[6] AES-256-GCM round-trips and authenticates');
{
  const key = toHex(C.getRandomBytes(32));
  for (const msg of ['hello', '', 'x'.repeat(5000), '🔐 unicode ✓ payload']) {
    const enc = C.encrypt(msg, key);
    ok(`round-trips ${JSON.stringify(msg.slice(0, 10))}`, C.decrypt(enc.ciphertext, enc.iv, key) === msg);
  }
  const enc = C.encrypt('secret', key);
  ok('IV is 12 bytes', enc.iv.length === 24);
  ok('ciphertext carries a 16-byte tag', fromHex(enc.ciphertext).length === utf8('secret').length + 16);
  ok('IV differs per call', C.encrypt('secret', key).iv !== enc.iv);
  ok('ciphertext differs per call', C.encrypt('secret', key).ciphertext !== enc.ciphertext);
}

console.log('\n[7] Tampering is detected (the old code accepted it)');
{
  const key = toHex(C.getRandomBytes(32));
  const enc = C.encrypt('transfer 10 to alice', key);
  const flip = hex => { const b = fromHex(hex); b[0] ^= 1; return toHex(b); };
  await throws('flipped ciphertext bit rejected', async () => C.decrypt(flip(enc.ciphertext), enc.iv, key));
  await throws('flipped IV bit rejected', async () => C.decrypt(enc.ciphertext, flip(enc.iv), key));
  await throws('truncated tag rejected', async () => C.decrypt(enc.ciphertext.slice(0, -4), enc.iv, key));
  await throws('wrong key rejected', async () => C.decrypt(enc.ciphertext, enc.iv, toHex(C.getRandomBytes(32))));
}

console.log('\n[8] AES-GCM is wire-compatible with WebCrypto');
{
  const keyBytes = C.getRandomBytes(32);
  const keyHex = toHex(keyBytes);
  const msg = 'cross-platform payload';

  // Mobile encrypts -> WebCrypto (the web app) decrypts.
  const enc = C.encrypt(msg, keyHex);
  const wcKey = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const opened = await webcrypto.subtle.decrypt(
    {name: 'AES-GCM', iv: fromHex(enc.iv)}, wcKey, fromHex(enc.ciphertext));
  ok('WebCrypto decrypts what mobile encrypted', new TextDecoder().decode(opened) === msg);

  // WebCrypto encrypts -> mobile decrypts.
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({name: 'AES-GCM', iv}, wcKey, utf8(msg)));
  ok('mobile decrypts what WebCrypto encrypted', C.decrypt(toHex(ct), toHex(iv), keyHex) === msg);
}

console.log('\n[9] deriveKeyFromSeed matches the web app exactly');
{
  const words = [...FIXTURE_B];
  const mine = await C.deriveKeyFromSeed(words);
  const km = await webcrypto.subtle.importKey('raw', utf8(words.join(' ')), 'PBKDF2', false, ['deriveBits']);
  const theirs = toHex(new Uint8Array(await webcrypto.subtle.deriveBits(
    {name: 'PBKDF2', salt: utf8('ghostlink-v2-salt'), iterations: 100000, hash: 'SHA-256'}, km, 256)));
  ok('PBKDF2 output matches WebCrypto byte for byte', mine === theirs);
  ok('key is 256 bits', mine.length === 64);
  ok('a different phrase gives a different key',
    (await C.deriveKeyFromSeed([...words.slice(0, 11), 'remember'])) !== mine);

  const storage = await C.deriveStorageKey(words);
  ok('storage key differs from the wrapping key', storage !== mine);
  const km2 = await webcrypto.subtle.importKey('raw', utf8(words.join(' ')), 'PBKDF2', false, ['deriveBits']);
  const theirs2 = toHex(new Uint8Array(await webcrypto.subtle.deriveBits(
    {name: 'PBKDF2', salt: utf8('ghostlink-storage-v1'), iterations: 200000, hash: 'SHA-256'}, km2, 256)));
  ok('storage key matches the web app too', storage === theirs2);
}

console.log('\n[10] Private-key wrapping, as SetupScreen does it');
{
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' ');
  const kp = C.generateKeyPair();
  const wrapKey = await C.deriveKeyFromSeed(words);
  const wrapped = C.encrypt(kp.privateKeyRaw, wrapKey);
  ok('unwraps with the right phrase', C.decrypt(wrapped.ciphertext, wrapped.iv, wrapKey) === kp.privateKeyRaw);
  const wrongKey = await C.deriveKeyFromSeed([...words.slice(0, 11), 'mike']);
  await throws('wrong phrase cannot unwrap', async () => C.decrypt(wrapped.ciphertext, wrapped.iv, wrongKey));
}

console.log('\n[11] Shamir secret sharing');
{
  const {ShamirSSS, generateBackupFragments, combineFragments} = await import(modPath.href);
  const secret = utf8('the quick brown fox jumps over the lazy dog');
  const shares = ShamirSSS.split(secret, 7, 3);
  ok('produces 7 shares', shares.length === 7);
  ok('3 shares reconstruct', toHex(ShamirSSS.combine(shares.slice(0, 3))) === toHex(secret));
  ok('a different 3 also reconstruct', toHex(ShamirSSS.combine([shares[6], shares[1], shares[4]])) === toHex(secret));
  ok('2 shares do not reconstruct', toHex(ShamirSSS.combine(shares.slice(0, 2))) !== toHex(secret));
  // The real caller passes the JSON backup blob, and combineFragments parses it.
  const blob = {name: 'TestGhost', pubKeyHex: 'ab'.repeat(65), wrappedPrivKey: {iv: '00'.repeat(12)}};
  const frags = generateBackupFragments(JSON.stringify(blob));
  ok('generateBackupFragments makes 5 by default (3-of-5, GM-M5-2)', frags.length === 5);
  const combined = combineFragments(frags.slice(0, 3).map(f => f.data));
  ok('combineFragments recovers the blob', combined.success && combined.blob.name === 'TestGhost');
  const outOfOrder = combineFragments([frags[4], frags[0], frags[3]].map(f => f.data));
  ok('any 3 fragments work, in any order', outOfOrder.success && outOfOrder.blob.pubKeyHex === blob.pubKeyHex);
  ok('2 fragments are refused', combineFragments(frags.slice(0, 2).map(f => f.data)).success === false);
}

console.log('\n[12] Recovery phrase generation');
{
  const {generateSeedPhrase} = await import(modPath.href);
  const {WORDLIST, SEED_PHRASE_BITS} = await import('../src/utils/wordlist.js');
  const phrase = generateSeedPhrase();
  ok('12 words', phrase.length === 12);
  ok('every word is in the shared list', phrase.every(w => WORDLIST.includes(w)));
  ok('two phrases differ', generateSeedPhrase().join(' ') !== phrase.join(' '));
  const many = Array.from({length: 300}, () => generateSeedPhrase().join(' '));
  ok('300 phrases are all distinct', new Set(many).size === 300);
  ok(`wordlist gives ${SEED_PHRASE_BITS} bits`, SEED_PHRASE_BITS >= 110);

  // Rejection sampling must not favour the low end of the list. With 575 words,
  // naive modulo of a 16-bit draw would over-represent the first 111.
  const counts = new Map();
  for (let i = 0; i < 60; i++) for (const w of generateSeedPhrase()) counts.set(w, (counts.get(w) || 0) + 1);
  const drawn = 60 * 12;
  const expected = drawn / WORDLIST.length;
  const head = WORDLIST.slice(0, 111).reduce((n, w) => n + (counts.get(w) || 0), 0);
  const headExpected = expected * 111;
  ok(`first 111 words are not over-drawn (${head} vs ~${headExpected.toFixed(0)})`,
     head < headExpected * 1.8);
}

(await import('fs')).unlinkSync(modPath);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
