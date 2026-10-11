/**
 * The recovery flow as the screens drive it: set up an identity, restore it
 * both ways, and check the same identity comes back (same public key, matching
 * private key). Assertions compare against the original, not just truthiness.
 */
import {webcrypto} from 'crypto';
import fs from 'fs';
import assert from 'assert';

Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true, writable: true});

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const throwsWith = async (name, code, fn) => {
  try { await fn(); fail++; console.log(`  FAIL ${name} (expected a throw)`); }
  catch (e) {
    if (code && e.code !== code) { fail++; console.log(`  FAIL ${name} (got code ${e.code}, wanted ${code})`); }
    else { pass++; console.log(`  ok   ${name}`); }
  }
};

// ── In-memory AsyncStorage + Keychain, so the real modules run unmodified ────
const store = new Map();
globalThis.__GL_STORE__ = store;
globalThis.__GL_KEYCHAIN__ = new Map();

const prep = (relPath, outName, extraReplacements = []) => {
  let src = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  for (const [from, to] of extraReplacements) src = src.split(from).join(to);
  const out = new URL(`./.${outName}`, import.meta.url);
  fs.writeFileSync(out, src);
  return out;
};

const cryptoPath = prep('../src/utils/crypto.js', 'rec-crypto.mjs', [
  ["import * as Keychain from 'react-native-keychain';", `const Keychain = {
    setGenericPassword: async (_a, password) => { globalThis.__GL_KEYCHAIN__.set('kp', password); return true; },
    getGenericPassword: async () => (globalThis.__GL_KEYCHAIN__.has('kp') ? {password: globalThis.__GL_KEYCHAIN__.get('kp')} : false),
    resetGenericPassword: async () => { globalThis.__GL_KEYCHAIN__.delete('kp'); return true; },
    getSupportedBiometryType: async () => null,
    ACCESS_CONTROL: {BIOMETRY_ANY_OR_DEVICE_PASSCODE: 1}, ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1},
  };`],
  ["import {NativeModules} from 'react-native';", 'const NativeModules = {};'],
  ["from './wordlist'", "from '../src/utils/wordlist.js'"],
  ["from './ghost-address'", "from '../src/utils/ghost-address.js'"],
]);
// recovery.js reads and writes through utils/storage.js. The stub is
// the REAL sealing module over the in-memory store, so recovery here runs
// through the same sealing as on a device.
prep('../src/utils/secret-storage.js', 'rec-secret-storage.mjs');
prep('../src/utils/legacy-hash.js', 'rec-legacy-hash.mjs');
const sealedStorageStub = `
import {createSecretStorage} from './.rec-secret-storage.mjs';
const __store = globalThis.__GL_STORE__;
const __secure = new Map();
const storage = createSecretStorage({
  plain: {
    setItem: async (k, v) => { __store.set(k, v); },
    getItem: async k => (__store.has(k) ? __store.get(k) : null),
    removeItem: async k => { __store.delete(k); },
  },
  secure: {
    setItem: async (k, v) => { __secure.set(k, v); },
    getItem: async k => (__secure.has(k) ? __secure.get(k) : null),
    removeItem: async k => { __secure.delete(k); },
  },
  randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
});
`;
const recoveryPath = prep('../src/utils/recovery.js', 'rec-recovery.mjs', [
  ["import {storage} from './storage';", sealedStorageStub],
  ["from './crypto'", `from './.rec-crypto.mjs'`],
  ["from './legacy-hash'", `from './.rec-legacy-hash.mjs'`],
]);

const {CryptoEngine, generateBackupFragments, generateSeedPhrase} = await import(cryptoPath.href);
const R = await import(recoveryPath.href);

// ── Setup, exactly as SetupScreen does it ───────────────────────────────────
console.log('\n[1] Setup produces a bundle and fragments');
const phrase = generateSeedPhrase();
const keyPair = CryptoEngine.generateKeyPair();
const bundle = await R.wrapIdentity(
  {privateKeyRaw: keyPair.privateKeyRaw, publicKeyHex: keyPair.publicKeyHex, name: 'TestGhost'},
  phrase,
);
await CryptoEngine.storeKeyPair(keyPair.publicKeyHex, keyPair.privateKeyRaw);
const fragments = generateBackupFragments(JSON.stringify(bundle));
await R.saveRecoveryBundle(bundle);

ok('bundle carries a wrapped key', !!bundle.wrappedKey?.iv && !!bundle.wrappedKey?.ciphertext);
ok('bundle records the public key', bundle.publicKeyHex === keyPair.publicKeyHex);
ok('5 fragments produced (3-of-5 by default, GM-M5-2)', fragments.length === 5);
ok('the phrase is NOT in the stored bundle', !JSON.stringify(bundle).includes(phrase[0]));
ok('the phrase is NOT in any fragment', !fragments.some(f => f.data.includes(Buffer.from(phrase.join(' ')).toString('hex'))));
ok('the private key is NOT in the bundle in the clear', !JSON.stringify(bundle).includes(keyPair.privateKeyRaw));
ok('no bare seed hash is stored', !store.has('gl_seed_check'));

// ── Same-device restore ──────────────────────────────────────────────────────
console.log('\n[2] Restore on this device, with the phrase');
{
  const restored = await R.restoreFromPhrase(phrase);
  ok('returns the SAME public key (not a new identity)', restored.publicKeyHex === keyPair.publicKeyHex);
  ok('returns the original private key', restored.privateKeyRaw === keyPair.privateKeyRaw);
  ok('private key really matches the public key',
     CryptoEngine.publicKeyFromPrivate(restored.privateKeyRaw) === restored.publicKeyHex);
  ok('display name survives', restored.name === 'TestGhost');
  ok('fingerprint is 16 hex chars', /^[0-9a-f]{16}$/.test(restored.fingerprint));
}

console.log('\n[3] A wrong phrase is rejected, not silently accepted');
{
  const wrong = [...phrase.slice(0, 11), phrase[11] === 'abandon' ? 'ability' : 'abandon'];
  await throwsWith('wrong phrase rejected', R.RecoveryError.WRONG_PHRASE, () => R.restoreFromPhrase(wrong));
  const shuffled = [...phrase].reverse();
  await throwsWith('same words in the wrong order rejected', R.RecoveryError.WRONG_PHRASE, () => R.restoreFromPhrase(shuffled));
}

// ── New device ───────────────────────────────────────────────────────────────
console.log('\n[4] Restore on a fresh device, from fragments + phrase');
{
  store.clear();
  globalThis.__GL_KEYCHAIN__.clear();
  await throwsWith('phrase alone cannot restore a blank device', R.RecoveryError.NO_LOCAL_BUNDLE,
    () => R.restoreFromPhrase(phrase));

  const restored = await R.restoreFromFragments(fragments.slice(0, 3).map(f => f.data), phrase);
  ok('returns the SAME public key', restored.publicKeyHex === keyPair.publicKeyHex);
  ok('returns the original private key', restored.privateKeyRaw === keyPair.privateKeyRaw);
  ok('any 3 fragments work', (await R.restoreFromFragments(
      [fragments[4], fragments[2], fragments[0]].map(f => f.data), phrase)).privateKeyRaw === keyPair.privateKeyRaw);
  ok('the device is now set up for phrase-only restore', store.has('gl_recovery_bundle'));
  const again = await R.restoreFromPhrase(phrase);
  ok('and phrase-only restore now works here', again.publicKeyHex === keyPair.publicKeyHex);
}

console.log('\n[5] Fragments alone are not enough');
{
  const wrong = [...phrase.slice(0, 11), phrase[11] === 'abandon' ? 'ability' : 'abandon'];
  await throwsWith('fragments + wrong phrase rejected', R.RecoveryError.WRONG_PHRASE,
    () => R.restoreFromFragments(fragments.slice(0, 3).map(f => f.data), wrong));
  await throwsWith('2 fragments refused', R.RecoveryError.BAD_FRAGMENTS,
    () => R.restoreFromFragments(fragments.slice(0, 2).map(f => f.data), phrase));
  await throwsWith('garbage fragments refused', R.RecoveryError.BAD_FRAGMENTS,
    () => R.restoreFromFragments(['00ff', '01ab', '02cd'], phrase));
}

console.log('\n[6] A tampered bundle is caught');
{
  const swapped = {...bundle, publicKeyHex: CryptoEngine.generateKeyPair().publicKeyHex};
  await throwsWith('public key swapped for another identity', R.RecoveryError.KEY_MISMATCH,
    () => R.unlockBundle(swapped, phrase));

  const flipped = JSON.parse(JSON.stringify(bundle));
  const b = Buffer.from(flipped.wrappedKey.ciphertext, 'hex'); b[0] ^= 1;
  flipped.wrappedKey.ciphertext = b.toString('hex');
  await throwsWith('flipped ciphertext bit', R.RecoveryError.WRONG_PHRASE, () => R.unlockBundle(flipped, phrase));

  await throwsWith('bundle with no wrapped key', R.RecoveryError.MALFORMED_BUNDLE,
    () => R.unlockBundle({v: 1, publicKeyHex: keyPair.publicKeyHex}, phrase));
}

console.log('\n[7] Two identities cannot be mixed');
{
  const other = CryptoEngine.generateKeyPair();
  const otherPhrase = generateSeedPhrase();
  const otherBundle = await R.wrapIdentity(
    {privateKeyRaw: other.privateKeyRaw, publicKeyHex: other.publicKeyHex, name: 'Other'}, otherPhrase);
  const otherFrags = generateBackupFragments(JSON.stringify(otherBundle));
  const mixed = [fragments[0].data, fragments[1].data, otherFrags[2].data];
  await throwsWith('fragments from two identities do not combine into a usable key', null,
    () => R.restoreFromFragments(mixed, phrase));
}

console.log('\n[8] P2P recovery tag');
{
  // The distributing and restoring devices must derive the same tag from the
  // same phrase.
  const tagA = await R.deriveRecoveryTag(phrase);
  const tagB = await R.deriveRecoveryTag([...phrase]);
  ok('same phrase gives the same tag on both sides', tagA === tagB);
  ok('tag is prefixed', tagA.startsWith(R.RECOVERY_TAG_PREFIX));

  const other = generateSeedPhrase();
  ok('a different phrase gives a different tag', (await R.deriveRecoveryTag(other)) !== tagA);

  // The tag travels the network, so it must not carry the phrase.
  const joined = phrase.join(' ');
  ok('tag does not contain the phrase', !tagA.includes(joined));
  // Check the digest, not the constant prefix: 'ghostlink:recovery:' itself
  // contains BIP-39 words (ghost, host, link, cover, over, very), so matching
  // against the whole tag failed for ~3.5% of random phrases.
  const digest = tagA.slice(R.RECOVERY_TAG_PREFIX.length);
  ok('tag contains no word from the phrase', !phrase.some(w => w.length > 3 && digest.includes(w)));
  ok('tag is a fixed-length digest', tagA.length === R.RECOVERY_TAG_PREFIX.length + 32);
}

for (const f of [cryptoPath, recoveryPath]) fs.unlinkSync(f);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
