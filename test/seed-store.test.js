'use strict';
/**
 * electron/src/seed-store.js — fail-closed seed-at-rest. safeStorage + store are
 * mocked (the same logic is also exercised against REAL safeStorage by
 * test/electron/seed-store.electron.mjs under `electron`). Run: node test/seed-store.test.js
 */
const assert = require('assert');
const { createSeedStore, SEED_STORE_KEY, LEGACY_SEED_STORE_KEY } = require('../electron/src/seed-store.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } }
function throws(fn, msg) { try { fn(); ok(false, `${msg} (did not throw)`); } catch (_e) { ok(true, msg); } }

function fakeStore(init = {}) { const m = new Map(Object.entries(init)); return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), _map: m }; }
// A keyring that really round-trips (prefix 'enc:').
function keyring(backend = 'gnome_libsecret') {
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend, encryptString: (s) => Buffer.from('enc:' + s, 'utf8'), decryptString: (b) => b.toString('utf8').replace(/^enc:/, '') };
}
// The dangerous case: basic_text that STILL reports available and "encrypts"
// with a hardcoded key (older Electron on Linux). This is exactly the gap.
function basicTextButReportsAvailable() {
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: (s) => Buffer.from('HARDCODED:' + s, 'utf8'), decryptString: (b) => b.toString('utf8').replace(/^HARDCODED:/, '') };
}

const SEED = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

console.log('\n=== A/B: basic_text that reports available (old Electron) — the gap ===');
{
  const ss = basicTextButReportsAvailable();
  ok(ss.isEncryptionAvailable() === true, 'control: isEncryptionAvailable() is TRUE here — the OLD gate (raw isEncryptionAvailable) would have persisted the seed under a hardcoded key');
  const store = fakeStore();
  const seed = createSeedStore({ safeStorage: ss, store });
  ok(seed.available() === false, 'NEW gate (secureBackendOk) treats basic_text as unavailable');
  throws(() => seed.setSeed(SEED), 'setSeed FAILS CLOSED on basic_text (refuses to seal with a hardcoded key)');
  ok(store.get(SEED_STORE_KEY) === undefined, 'nothing was written to the store on the fail-closed path');
  const st = seed.status();
  ok(st.available === false && /basic_text/.test(st.reason), 'status() names basic_text as the cause for the banner');
}

console.log('\n=== fail closed: no keyring at all ===');
{
  const ss = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown' };
  const store = fakeStore();
  const seed = createSeedStore({ safeStorage: ss, store });
  ok(seed.available() === false, 'no keyring -> unavailable');
  throws(() => seed.setSeed(SEED), 'setSeed refuses when no keyring is present');
  ok(/keyring/i.test(seed.status().reason), 'status() names the missing keyring');
}

console.log('\n=== positive control: a real keyring seals and reads back, survives "restart" ===');
{
  const store = fakeStore();
  const seed = createSeedStore({ safeStorage: keyring(), store });
  ok(seed.setSeed(SEED) === true, 'setSeed seals under a real keyring');
  ok(store.get(SEED_STORE_KEY) && !String(store.get(SEED_STORE_KEY)).includes(SEED.split(' ')[0]), 'the stored value is sealed, not the plaintext phrase');
  ok(seed.getSeed() === SEED, 'getSeed returns the phrase');
  // "Restart": a fresh store object over the SAME backing map + same keyring.
  const seed2 = createSeedStore({ safeStorage: keyring(), store: fakeStore(Object.fromEntries(store._map)) });
  ok(seed2.getSeed() === SEED, 'the seed survives a restart (fresh instance, same disk)');
}

console.log('\n=== existing sealed seed, but keyring GONE: keep it, do not use it, do not delete ===');
{
  const good = keyring();
  const store = fakeStore();
  createSeedStore({ safeStorage: good, store }).setSeed(SEED); // sealed under a keyring
  const blob = store.get(SEED_STORE_KEY);
  // Now the keyring is gone (basic_text / unavailable).
  const degraded = createSeedStore({ safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' }, store });
  ok(degraded.getSeed() === null, 'getSeed returns null when the backend can no longer be trusted (identity must be re-entered)');
  ok(store.get(SEED_STORE_KEY) === blob, 'the sealed blob is NOT deleted — a later keyring unlock recovers it');
}

console.log('\n=== legacy plaintext seed from an old build ===');
{
  // keyring present: migrate to sealed, drop plaintext, user still gets in
  const store = fakeStore({ [LEGACY_SEED_STORE_KEY]: SEED });
  const seed = createSeedStore({ safeStorage: keyring(), store });
  ok(seed.getSeed() === SEED, 'legacy plaintext is returned so the user is not locked out');
  ok(store.get(SEED_STORE_KEY) && store.get(LEGACY_SEED_STORE_KEY) === undefined, 'with a keyring, the legacy plaintext is migrated to sealed and then removed');
}
{
  // basic_text: keep plaintext, never re-seal weakly, still let the user in
  const store = fakeStore({ [LEGACY_SEED_STORE_KEY]: SEED });
  const seed = createSeedStore({ safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' }, store });
  ok(seed.getSeed() === SEED, 'on basic_text the legacy plaintext is still returned (not locked out)');
  ok(store.get(LEGACY_SEED_STORE_KEY) === SEED && store.get(SEED_STORE_KEY) === undefined, 'but it is NOT deleted and NOT re-sealed under a weak key');
}

console.log('\n=== durability failure: a key that does not read back is refused ===');
{
  const flaky = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'kwallet', encryptString: (s) => Buffer.from('enc:' + s), decryptString: () => 'CORRUPT' };
  const store = fakeStore({ [LEGACY_SEED_STORE_KEY]: SEED });
  const seed = createSeedStore({ safeStorage: flaky, store });
  throws(() => seed.setSeed(SEED), 'setSeed throws when the sealed value does not decrypt back');
  ok(store.get(LEGACY_SEED_STORE_KEY) === SEED, 'and the legacy plaintext copy is preserved (not deleted on a failed seal)');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
