'use strict';
/**
 * The 32-byte data key for the desktop contact vault (gl_peer_cache /
 * gl_gmp_known_peers), held in Electron safeStorage (OS keyring).
 *
 * FAIL CLOSED: safeStorage.isEncryptionAvailable() returns true even for the
 * Linux 'basic_text' backend, which uses a HARDCODED key and protects nothing.
 * We treat basic_text as "secure storage unavailable" and refuse to hand out a
 * key — the renderer then keeps contacts in memory and shows a warning, rather
 * than sealing them with a key that is not secret. (This is stricter than the
 * seed-phrase path in main.js, which only checks isEncryptionAvailable.)
 */
const crypto = require('crypto');

const CONTACT_KEY_STORE = 'gl_contact_vault_key_enc';

/** True only when the OS keyring really protects the key (not basic_text). */
function secureBackendOk(safeStorage) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      if (safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    }
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * @returns {{available:true, keyHex:string} | {available:false, reason:string, backend:string}}
 */
function getContactVaultKey(safeStorage, store) {
  if (!secureBackendOk(safeStorage)) {
    let backend = 'unknown';
    try { backend = (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend()) || 'unknown'; } catch (_e) { /* ignore */ }
    return {
      available: false,
      backend,
      reason: backend === 'basic_text'
        ? 'OS secure storage is basic_text (a hardcoded key): contacts cannot be sealed safely'
        : 'OS secure storage is unavailable (no keyring): contacts cannot be sealed safely',
    };
  }
  // Reuse the persisted key if it decrypts and is well-formed.
  const sealed = store.get(CONTACT_KEY_STORE);
  if (sealed) {
    try {
      const keyHex = safeStorage.decryptString(Buffer.from(sealed, 'base64'));
      if (/^[0-9a-f]{64}$/.test(keyHex)) return { available: true, keyHex };
    } catch (_e) { /* regenerate below */ }
  }
  // Provision a fresh 32-byte key, seal it, and require it to read back.
  const keyHex = crypto.randomBytes(32).toString('hex');
  store.set(CONTACT_KEY_STORE, safeStorage.encryptString(keyHex).toString('base64'));
  let back = null;
  try { back = safeStorage.decryptString(Buffer.from(store.get(CONTACT_KEY_STORE), 'base64')); } catch (_e) { /* back stays null */ }
  if (back !== keyHex) {
    return { available: false, backend: 'unknown', reason: 'contact vault key did not persist to secure storage' };
  }
  return { available: true, keyHex };
}

/**
 * The single source of truth for "can we store secrets on this device?", used
 * by the seed store and the contact vault and surfaced to the renderer so the
 * banner names the actual cause.
 * @returns {{available:boolean, backend:string, reason:string}}
 */
function secureStorageStatus(safeStorage) {
  let backend = 'unknown';
  try { backend = (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend()) || 'unknown'; } catch (_e) { /* ignore */ }
  const available = secureBackendOk(safeStorage);
  return {
    available,
    backend,
    reason: available
      ? ''
      : backend === 'basic_text'
        ? 'OS secure storage is basic_text (a hardcoded key): secrets cannot be protected'
        : 'No system keyring found (gnome-keyring / kwallet): secrets cannot be protected',
  };
}

module.exports = { getContactVaultKey, secureBackendOk, secureStorageStatus, CONTACT_KEY_STORE };
