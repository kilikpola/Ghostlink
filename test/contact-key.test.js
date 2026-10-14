'use strict';
/**
 * electron/src/contact-key.js — the main-process safeStorage key provider for
 * the desktop contact vault. safeStorage is mocked (Electron is not run here).
 * Run: node test/contact-key.test.js
 */
const assert = require('assert');
const { getContactVaultKey, CONTACT_KEY_STORE } = require('../electron/src/contact-key.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } }

function fakeStore() { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : undefined), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), _map: m }; }
// A keyring-backed safeStorage: real round-trip (prefix 'enc:').
function keyringSafeStorage(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

console.log('\n=== fail closed ===');
const basicText = { ...keyringSafeStorage('basic_text') };
const r1 = getContactVaultKey(basicText, fakeStore());
ok(r1.available === false && r1.backend === 'basic_text', 'basic_text backend -> unavailable (hardcoded key protects nothing)');
ok(!('keyHex' in r1) && /basic_text/.test(r1.reason), 'no key is handed out on basic_text, with a reason');

const noEnc = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown' };
ok(getContactVaultKey(noEnc, fakeStore()).available === false, 'isEncryptionAvailable=false -> unavailable');

const durabilityFail = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'kwallet', encryptString: (s) => Buffer.from('enc:' + s), decryptString: () => 'CORRUPT' };
ok(getContactVaultKey(durabilityFail, fakeStore()).available === false, 'a key that does not read back -> unavailable (no silent weak key)');

console.log('\n=== positive control: a real keyring seals and persists ===');
const store = fakeStore();
const a = getContactVaultKey(keyringSafeStorage(), store);
ok(a.available === true && /^[0-9a-f]{64}$/.test(a.keyHex), 'keyring backend -> a 32-byte (64-hex) data key');
ok(!!store.get(CONTACT_KEY_STORE), 'the key is persisted (encrypted) under its store key');
const b = getContactVaultKey(keyringSafeStorage(), store);
ok(b.available === true && b.keyHex === a.keyHex, 'a second call returns the SAME key (stable across restarts)');

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
