'use strict';
/**
 * The 32-byte data key for the desktop contact vault (gl_peer_cache /
 * gl_gmp_known_peers), held in Electron safeStorage (OS keyring), and the one
 * place that classifies the keyring for every secret at rest.
 *
 * Three states, never collapsed (STEP 0 measured each in the built app):
 *   - 'insecure': the backend is basic_text, a fixed built-in key that protects
 *     nothing (isEncryptionAvailable() may even return true). Nothing is sealed.
 *   - 'locked': a real backend that cannot encrypt right now
 *     (isEncryptionAvailable() false, e.g. gnome_libsecret with the collection
 *     locked). Nothing in the store is read or written.
 *   - 'unreadable' (per stored value): encryption works but the stored value
 *     won't decrypt (another keyring, corruption). It is never overwritten; only
 *     an explicit replace moves it aside (moveStoredValueAside) first.
 * The seed store (seed-store.js) and this file share the same rules.
 */
const crypto = require('crypto');

const CONTACT_KEY_STORE = 'gl_contact_vault_key_enc';

/** The word the user types to replace a secret this device cannot read. */
const REPLACE_WORD = 'REPLACE';

const LOCKED_REASON = 'Your system keyring is locked. Unlock it and restart GhostLink.';
const INSECURE_REASON = 'Your identity and contacts aren’t saved on this device: secure storage is basic_text '
  + '(a fixed built-in key). Install and unlock gnome-keyring (or KWallet on KDE), then restart GhostLink.';
const CONTACTS_UNREADABLE_REASON = 'Your saved contacts can’t be read with this keyring, so they were left untouched. '
  + 'Signing in with the keyring they were saved under may open them again.';

function backendName(safeStorage) {
  try { return (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend()) || 'unknown'; } catch (_e) { return 'unknown'; }
}

/** 'ok', 'locked' or 'insecure' (see the header). */
function backendState(safeStorage) {
  if (backendName(safeStorage) === 'basic_text') return 'insecure';
  try { return safeStorage.isEncryptionAvailable() ? 'ok' : 'locked'; } catch (_e) { return 'locked'; }
}

/** True only when the OS keyring really protects secrets right now. */
function secureBackendOk(safeStorage) {
  return backendState(safeStorage) === 'ok';
}

/**
 * Copy store[key] to key + '_unreadable_<UTC timestamp>', check the copy, then
 * clear the original; returns the new key. Throws with the value still in
 * place on any failure. No '.' in the key: electron-store reads dots as
 * nested paths, and a dotted "rename" replaces the original string.
 */
function moveStoredValueAside(store, key, now = new Date()) {
  const value = store.get(key);
  if (!value) throw new Error(`Nothing stored under ${key}`);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const asideKey = `${key}_unreadable_${stamp}`;
  if (store.get(asideKey) !== undefined) throw new Error(`${asideKey} already exists`);
  store.set(asideKey, value);
  if (store.get(asideKey) !== value) throw new Error(`${key} could not be copied aside`);
  store.delete(key);
  return asideKey;
}

/** Undo moveStoredValueAside (when the replacement could not be stored). */
function restoreStoredValueAside(store, key, asideKey) {
  const value = store.get(asideKey);
  if (!value) throw new Error(`${asideKey} is missing`);
  store.set(key, value);
  if (store.get(key) !== value) throw new Error(`${key} could not be moved back`);
  store.delete(asideKey);
}

function unavailable(safeStorage, state) {
  const reason = state === 'insecure' ? INSECURE_REASON : state === 'locked' ? LOCKED_REASON : CONTACTS_UNREADABLE_REASON;
  return { available: false, state, backend: backendName(safeStorage), reason };
}

/** Provision a fresh 32-byte key, seal it, and require it to read back. */
function provisionKey(safeStorage, store) {
  const keyHex = crypto.randomBytes(32).toString('hex');
  store.set(CONTACT_KEY_STORE, safeStorage.encryptString(keyHex).toString('base64'));
  let back = null;
  try { back = safeStorage.decryptString(Buffer.from(store.get(CONTACT_KEY_STORE), 'base64')); } catch (_e) { /* back stays null */ }
  if (back !== keyHex) {
    return { available: false, state: 'failed', backend: backendName(safeStorage), reason: 'contact vault key did not persist to secure storage' };
  }
  return { available: true, state: 'ok', keyHex };
}

/**
 * @returns {{available:true, state:'ok', keyHex:string}
 *   | {available:false, state:'locked'|'insecure'|'unreadable'|'failed', reason:string, backend:string}}
 */
function getContactVaultKey(safeStorage, store) {
  const state = backendState(safeStorage);
  if (state !== 'ok') return unavailable(safeStorage, state); // locked/insecure: the store is not touched
  const sealed = store.get(CONTACT_KEY_STORE);
  if (sealed) {
    let keyHex = null;
    try { keyHex = safeStorage.decryptString(Buffer.from(sealed, 'base64')); } catch (_e) { keyHex = null; }
    if (/^[0-9a-f]{64}$/.test(keyHex || '')) return { available: true, state: 'ok', keyHex };
    // Never a new key over one we can't read: the contacts sealed under it would be lost.
    return unavailable(safeStorage, 'unreadable');
  }
  return provisionKey(safeStorage, store);
}

/**
 * Explicit replace of an UNREADABLE contact key: move it aside, store a new
 * one, and move the old one back if that fails. Refused in every other state.
 * @returns {{available:true, state:'ok', keyHex:string, asideKey:string} | {available:false, state:string, reason:string}}
 */
function replaceContactVaultKey(safeStorage, store, confirmation) {
  if (confirmation !== REPLACE_WORD) {
    return { available: false, state: 'refused', reason: `Type ${REPLACE_WORD} to replace the contact key on this device.` };
  }
  const state = backendState(safeStorage);
  if (state !== 'ok') return unavailable(safeStorage, state);
  const current = store.get(CONTACT_KEY_STORE);
  if (!current) return { available: false, state: 'refused', reason: 'There is no stored contact key to replace.' };
  let readable = false;
  try { readable = /^[0-9a-f]{64}$/.test(safeStorage.decryptString(Buffer.from(current, 'base64'))); } catch (_e) { readable = false; }
  if (readable) return { available: false, state: 'refused', reason: 'The stored contact key is readable; it is not replaced.' };

  let asideKey;
  try {
    asideKey = moveStoredValueAside(store, CONTACT_KEY_STORE);
  } catch (err) {
    return { available: false, state: 'unreadable', reason: `The old contact key could not be moved aside (${err.message}); nothing was changed.` };
  }
  let fresh;
  try { fresh = provisionKey(safeStorage, store); } catch (err) { fresh = { available: false, reason: err.message }; }
  if (!fresh.available) {
    let reason = `A new contact key could not be stored (${fresh.reason}).`;
    try { restoreStoredValueAside(store, CONTACT_KEY_STORE, asideKey); reason += ' The old key was put back.'; } catch (e) { reason += ` The old key stays under ${asideKey} (${e.message}).`; }
    return { available: false, state: 'unreadable', reason };
  }
  return { ...fresh, asideKey };
}

/**
 * The single source of truth for "can we store secrets on this device?", used
 * by the seed store and the contact vault and surfaced to the renderer so the
 * banner names the actual cause.
 * @returns {{available:boolean, state:'ok'|'locked'|'insecure', backend:string, reason:string}}
 */
function secureStorageStatus(safeStorage) {
  const state = backendState(safeStorage);
  return {
    available: state === 'ok',
    state,
    backend: backendName(safeStorage),
    reason: state === 'ok' ? '' : state === 'insecure' ? INSECURE_REASON : LOCKED_REASON,
  };
}

module.exports = {
  getContactVaultKey, replaceContactVaultKey, secureBackendOk, secureStorageStatus, backendState,
  moveStoredValueAside, restoreStoredValueAside,
  CONTACT_KEY_STORE, REPLACE_WORD, LOCKED_REASON, INSECURE_REASON,
};
