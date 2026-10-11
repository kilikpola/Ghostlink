/**
 * The legacy recovery-data migration must not strand anyone: older data is
 * deleted only when nothing depends on it. Runs the real recovery.js,
 * crypto.js and secret-storage.js against in-memory keychain and storage:
 *
 *  1. an install that cannot re-derive its identity (random key, legacy
 *     fragments + wrapped key + phrase check, no modern bundle): kept at
 *     upgrade; a wrong phrase deletes nothing; the right one writes a modern
 *     bundle that restores the same identity on a fresh device, then the
 *     legacy data goes
 *  2. a 0.0.3 install (phrase-derived identity, modern bundle + fragments):
 *     fragments deleted at upgrade
 *  3. a 0.0.3 install whose bundle is missing but whose fragments rebuild it:
 *     the bundle is restored first, then the fragments go
 *  4. the manual path defaults to 3-of-5: any 3 rebuild it, 2 do not
 */
import {webcrypto} from 'crypto';
import fs from 'fs';

Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true, writable: true});

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

// ── The real modules over in-memory keychain + storage ─────────────────────
const store = new Map();       // AsyncStorage
const secure = new Map();      // EncryptedStorage (holds only the data key)
globalThis.__LRM_STORE__ = store;
globalThis.__LRM_SECURE__ = secure;
globalThis.__LRM_KEYCHAIN__ = new Map();

const prep = (relPath, outName, replacements = []) => {
  let src = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  for (const [from, to] of replacements) {
    if (!src.includes(from)) throw new Error(`prep ${relPath}: "${from.slice(0, 50)}" not found`);
    src = src.split(from).join(to);
  }
  const out = new URL(`./.${outName}`, import.meta.url);
  fs.writeFileSync(out, src);
  return out;
};
prep('../src/utils/secret-storage.js', 'lrm-secret-storage.mjs');
prep('../src/utils/legacy-hash.js', 'lrm-legacy-hash.mjs');
const cryptoPath = prep('../src/utils/crypto.js', 'lrm-crypto.mjs', [
  ["import * as Keychain from 'react-native-keychain';", `const Keychain = {
    setGenericPassword: async (_a, password) => { globalThis.__LRM_KEYCHAIN__.set('kp', password); return true; },
    getGenericPassword: async () => (globalThis.__LRM_KEYCHAIN__.has('kp') ? {password: globalThis.__LRM_KEYCHAIN__.get('kp')} : false),
    resetGenericPassword: async () => { globalThis.__LRM_KEYCHAIN__.delete('kp'); return true; },
    getSupportedBiometryType: async () => null,
    ACCESS_CONTROL: {BIOMETRY_ANY_OR_DEVICE_PASSCODE: 1}, ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1},
  };`],
  ["import {NativeModules} from 'react-native';", 'const NativeModules = {};'],
  ["from './wordlist'", "from '../src/utils/wordlist.js'"],
  ["from './ghost-address'", "from '../src/utils/ghost-address.js'"],
]);
const recoveryPath = prep('../src/utils/recovery.js', 'lrm-recovery.mjs', [
  ["import {storage} from './storage';", `
import {createSecretStorage} from './.lrm-secret-storage.mjs';
const mapStore = (m) => ({ setItem: async (k, v) => { m.set(k, v); }, getItem: async (k) => (m.has(k) ? m.get(k) : null), removeItem: async (k) => { m.delete(k); } });
export const storage = createSecretStorage({ plain: mapStore(globalThis.__LRM_STORE__), secure: mapStore(globalThis.__LRM_SECURE__), randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) });
`],
  ["from './crypto'", "from './.lrm-crypto.mjs'"],
  ["from './legacy-hash'", "from './.lrm-legacy-hash.mjs'"],
]);

const C = await import(cryptoPath.href);
const R = await import(recoveryPath.href);
const {CryptoEngine, generateBackupFragments, generateSeedPhrase, FRAGMENT_SHARES, FRAGMENT_THRESHOLD, combineFragments} = C;
const {legacySha256} = await import(new URL('./.lrm-legacy-hash.mjs', import.meta.url).href);
const storage = R.storage;

function resetDevice() { store.clear(); secure.clear(); globalThis.__LRM_KEYCHAIN__.clear(); }
const sealedOnDisk = (k) => typeof store.get(k) === 'string' && store.get(k).startsWith('gl-sealed:v1:');

// ── 1. An install that cannot re-derive its identity from the phrase ────────
console.log('\n[1] install that cannot re-derive from its phrase (random key, legacy data only)');
{
  resetDevice();
  const phrase = generateSeedPhrase();
  const other = generateSeedPhrase();
  const keyPair = CryptoEngine.generateKeyPair(); // random: the phrase does not derive it
  await CryptoEngine.storeKeyPair(keyPair.publicKeyHex, keyPair.privateKeyRaw);
  // What a 0.0.x setup wrote, in plaintext.
  const legacyBlob = JSON.stringify({wrappedKey: {iv: 'aa'.repeat(12), ciphertext: 'bb'.repeat(40)}, publicKeyHex: keyPair.publicKeyHex, displayName: 'Old'});
  store.set('gl_shamir_fragments', JSON.stringify(generateBackupFragments(legacyBlob, 7, 3)));
  store.set('gl_wrapped_privkey', JSON.stringify({iv: 'aa'.repeat(12), ciphertext: 'bb'.repeat(40)}));
  store.set('gl_seed_check', await legacySha256(phrase.join(' ')));
  store.set('gl_invite_code', 'GL-OLD');

  const derived = await CryptoEngine.deriveIdentityKeyPair(phrase);
  ok('precondition: the phrase does NOT re-derive this identity', derived.publicKeyHex !== keyPair.publicKeyHex);

  const upgrade = await storage.migrate();
  ok('upgrade deletes the invite code', !store.has('gl_invite_code') && upgrade.deleted.includes('gl_invite_code'));
  for (const k of R.LEGACY_RECOVERY_KEYS) ok(`upgrade KEEPS ${k}, sealed in place`, store.has(k) && sealedOnDisk(k));

  const assessed = await R.assessLegacyRecovery();
  ok(`assessment: needs the phrase (${assessed.state})`, assessed.state === 'needs-phrase');
  for (const k of R.LEGACY_RECOVERY_KEYS) ok(`still kept after assessment: ${k}`, store.has(k));

  let err = null;
  try { await R.finishLegacyMigration(other); } catch (e) { err = e; }
  ok(`a wrong phrase is refused (${err && err.code})`, err && err.code === 'WRONG_PHRASE');
  for (const k of R.LEGACY_RECOVERY_KEYS) ok(`and deletes nothing: ${k}`, store.has(k));
  ok('and writes no bundle', !store.has(R.BUNDLE_STORAGE_KEY));

  const done = await R.finishLegacyMigration(phrase, {name: 'Old'});
  ok(`the right phrase finishes it (deleted ${done.deleted.join(', ')})`, done.deleted.length === 3);
  for (const k of R.LEGACY_RECOVERY_KEYS) ok(`gone now: ${k}`, !store.has(k));
  ok('a modern bundle is on the device, sealed', store.has(R.BUNDLE_STORAGE_KEY) && sealedOnDisk(R.BUNDLE_STORAGE_KEY));

  // The point: this install is not stranded. Lose the keychain key; the
  // phrase plus the bundle bring back the SAME identity.
  const bundle = await R.loadRecoveryBundle();
  globalThis.__LRM_KEYCHAIN__.clear();
  const restored = await R.restoreFromPhrase(phrase);
  ok('after losing the keychain key, phrase + bundle restore the same public key', restored.publicKeyHex === keyPair.publicKeyHex);
  ok('and the same private key', restored.privateKeyRaw === keyPair.privateKeyRaw);
  ok('the bundle is a current one (PBKDF2-wrapped, versioned)', bundle.v === R.RECOVERY_BUNDLE_VERSION && !!bundle.wrappedKey.iv);
}

// ── 2. A 0.0.3 install: fragments are redundant ─────────────────────────────
console.log('\n[2] 0.0.3 install: phrase-derived identity, modern bundle and fragments');
{
  resetDevice();
  const phrase = generateSeedPhrase();
  const kp = await CryptoEngine.deriveIdentityKeyPair(phrase);
  await CryptoEngine.storeKeyPair(kp.publicKeyHex, kp.privateKeyRaw);
  const bundle = await R.wrapIdentity({privateKeyRaw: kp.privateKeyRaw, publicKeyHex: kp.publicKeyHex, name: 'Now'}, phrase);
  await R.saveRecoveryBundle(bundle);
  store.set('gl_shamir_fragments', JSON.stringify(generateBackupFragments(JSON.stringify(bundle), 7, 3)));
  await storage.migrate();
  const assessed = await R.assessLegacyRecovery();
  ok(`resolved at upgrade (${assessed.state}, ${assessed.how})`, assessed.state === 'resolved' && assessed.how === 'modern-bundle-present');
  ok('the stored fragments are gone', !store.has('gl_shamir_fragments'));
  ok('the bundle stays', store.has(R.BUNDLE_STORAGE_KEY));
}

// ── 3. A 0.0.3 install whose bundle is missing ──────────────────────────────
console.log('\n[3] 0.0.3 install whose bundle is missing but whose fragments rebuild it');
{
  resetDevice();
  const phrase = generateSeedPhrase();
  const kp = await CryptoEngine.deriveIdentityKeyPair(phrase);
  await CryptoEngine.storeKeyPair(kp.publicKeyHex, kp.privateKeyRaw);
  const bundle = await R.wrapIdentity({privateKeyRaw: kp.privateKeyRaw, publicKeyHex: kp.publicKeyHex, name: 'Half'}, phrase);
  store.set('gl_shamir_fragments', JSON.stringify(generateBackupFragments(JSON.stringify(bundle), 7, 3)));
  await storage.migrate();
  const assessed = await R.assessLegacyRecovery();
  ok(`resolved by restoring the bundle first (${assessed.how})`, assessed.state === 'resolved' && assessed.how === 'bundle-restored-from-fragments');
  ok('bundle now on the device', store.has(R.BUNDLE_STORAGE_KEY));
  ok('fragments gone', !store.has('gl_shamir_fragments'));
  globalThis.__LRM_KEYCHAIN__.clear();
  const restored = await R.restoreFromPhrase(phrase);
  ok('phrase + restored bundle give back the identity', restored.publicKeyHex === kp.publicKeyHex);
}

// ── 4. Manual path: 3 of 5 ─────────────────────────────────────────────────
console.log('\n[4] manual fragments default to 3-of-5');
{
  const blob = JSON.stringify({v: 1, secret: 'x'.repeat(50)});
  const frags = generateBackupFragments(blob);
  ok(`${frags.length} fragments, threshold ${FRAGMENT_THRESHOLD}`, frags.length === 5 && FRAGMENT_SHARES === 5 && FRAGMENT_THRESHOLD === 3);
  ok('labels say "of 5"', frags.every((f) => / of 5$/.test(f.label)));
  const any3 = combineFragments([frags[4].data, frags[1].data, frags[2].data]);
  ok('any 3 rebuild it', any3.success && JSON.stringify(any3.blob) === blob);
  const two = combineFragments([frags[0].data, frags[3].data]);
  ok('2 do not', !two.success);
}

for (const f of ['lrm-secret-storage.mjs', 'lrm-legacy-hash.mjs', 'lrm-crypto.mjs', 'lrm-recovery.mjs']) fs.rmSync(new URL(`./.${f}`, import.meta.url), {force: true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
