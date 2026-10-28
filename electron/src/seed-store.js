'use strict';
/**
 * The recovery seed (master identity) at rest, in Electron safeStorage.
 *
 * FAIL CLOSED, same rule as the contact vault: availability is secureBackendOk
 * (contact-key.js), NOT the raw safeStorage.isEncryptionAvailable(). On Linux
 * 'basic_text' (a hardcoded key) isEncryptionAvailable() can return true in some
 * Electron versions — sealing with that key protects nothing, so we treat it as
 * unavailable and refuse to persist. No plaintext fallback, ever.
 *
 * Existing installs: if a seed is already stored but the backend is no longer
 * trustworthy (basic_text / keyring gone), we do NOT use it and do NOT delete it
 * — the blob is kept so a user who later unlocks their keyring is not wiped, and
 * the UI asks for the recovery phrase. A legacy *plaintext* seed from an old
 * build is likewise kept and returned (so the user is not locked out) but is
 * never re-sealed under a weak key; it is only migrated once a real keyring is
 * present. This mirrors the mobile migration rule: never destroy the user's only
 * copy until a good copy exists.
 */
const { secureBackendOk, secureStorageStatus, backendState, moveStoredValueAside, restoreStoredValueAside } = require('./contact-key');

const SEED_STORE_KEY = 'gmp_seed_phrase_enc';
const LEGACY_SEED_STORE_KEY = 'gmp_seed_phrase';

function createSeedStore({ safeStorage, store }) {
  const available = () => secureBackendOk(safeStorage);

  /**
   * Persist the seed, or fail closed. Returns true if sealed, throws if the
   * backend cannot protect it (the caller must then run session-only, not
   * silently drop to plaintext).
   */
  function setSeed(seed) {
    if (typeof seed !== 'string' || !seed.trim()) {
      throw new Error('Refusing to store an empty seed phrase.');
    }
    if (!available()) {
      const { reason } = secureStorageStatus(safeStorage);
      throw new Error(`${reason} The recovery phrase will not be saved on this device.`);
    }
    // A stored identity this device can't read is never overwritten: it may
    // open again under the right keyring. Replacing it is an explicit step that
    // first moves it aside (moveAside).
    if (store.get(SEED_STORE_KEY) && readSeed().state === 'unreadable') {
      throw new Error('The identity saved on this device cannot be read here, so it will not be overwritten');
    }
    const sealed = safeStorage.encryptString(seed).toString('base64');
    store.set(SEED_STORE_KEY, sealed);
    // Durability: require it to read back before we trust it (and before we
    // would ever delete the legacy copy).
    let back = null;
    try { back = safeStorage.decryptString(Buffer.from(store.get(SEED_STORE_KEY), 'base64')); } catch (_e) { back = null; }
    if (back !== seed) {
      throw new Error('The recovery phrase did not persist to secure storage; not saved.');
    }
    // Only now is it safe to drop a plaintext copy left by an older build.
    store.delete(LEGACY_SEED_STORE_KEY);
    return true;
  }

  /**
   * The stored seed and why it can or can't be used:
   *   'readable' | 'none' | 'locked' | 'insecure' | 'unreadable' (contact-key.js).
   * A blob is kept untouched in every state but 'readable'.
   */
  function readSeed() {
    const sealed = store.get(SEED_STORE_KEY);
    const backend = backendState(safeStorage);
    if (sealed) {
      // Locked or basic_text: keep the blob, don't use it, and say which.
      if (backend !== 'ok') return { state: backend, seed: null };
      try {
        return { state: 'readable', seed: safeStorage.decryptString(Buffer.from(sealed, 'base64')) };
      } catch (err) {
        // Keyring open but this blob won't open (another keyring / corruption).
        return { state: 'unreadable', seed: null };
      }
    }
    // Legacy plaintext from an older build.
    const legacy = store.get(LEGACY_SEED_STORE_KEY);
    if (!legacy) return { state: backend === 'ok' ? 'none' : backend, seed: null };
    // Migrate into secure storage only if we actually can; never re-seal weakly.
    if (backend === 'ok') {
      try { setSeed(legacy); } catch (_e) { /* keep legacy, user still gets in below */ }
    }
    return { state: 'readable', seed: legacy }; // keep & return so the user is not locked out
  }

  function getSeed() {
    return readSeed().seed;
  }

  /** See readSeed. Nothing stored and the keyring locked/insecure reports that state. */
  function readState() {
    return readSeed().state;
  }

  /** Move the sealed blob aside (contact-key.js moveStoredValueAside); returns its new key. */
  function moveAside(now = new Date()) {
    return moveStoredValueAside(store, SEED_STORE_KEY, now);
  }

  /** Undo moveAside (when the replacement could not be stored). */
  function restoreAside(asideKey) {
    restoreStoredValueAside(store, SEED_STORE_KEY, asideKey);
  }

  function status() {
    const s = secureStorageStatus(safeStorage);
    return { ...s, hasStoredSeed: !!store.get(SEED_STORE_KEY) || !!store.get(LEGACY_SEED_STORE_KEY), seedState: readState() };
  }

  return { available, setSeed, getSeed, readState, moveAside, restoreAside, status };
}

module.exports = { createSeedStore, SEED_STORE_KEY, LEGACY_SEED_STORE_KEY };
