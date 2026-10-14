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
const { secureBackendOk, secureStorageStatus } = require('./contact-key');

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
      throw new Error(`${reason}. The recovery phrase will not be saved on this device.`);
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

  function getSeed() {
    const sealed = store.get(SEED_STORE_KEY);
    if (sealed) {
      // Backend no longer trustworthy: keep the blob, don't use it, ask for re-entry.
      if (!available()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
      } catch (err) {
        // Keyring present but this blob won't open (wrong keyring / corruption):
        // keep it, return nothing, let the user re-enter.
        return null;
      }
    }
    // Legacy plaintext from an older build.
    const legacy = store.get(LEGACY_SEED_STORE_KEY);
    if (!legacy) return null;
    // Migrate into secure storage only if we actually can; never re-seal weakly.
    if (available()) {
      try { setSeed(legacy); } catch (_e) { /* keep legacy, user still gets in below */ }
    }
    return legacy; // keep & return so the user is not locked out
  }

  function status() {
    const s = secureStorageStatus(safeStorage);
    return { ...s, hasStoredSeed: !!store.get(SEED_STORE_KEY) || !!store.get(LEGACY_SEED_STORE_KEY) };
  }

  return { available, setSeed, getSeed, status };
}

module.exports = { createSeedStore, SEED_STORE_KEY, LEGACY_SEED_STORE_KEY };
