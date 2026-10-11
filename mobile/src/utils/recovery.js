/**
 * GhostLink Mobile — identity recovery.
 *
 * Both restore paths share one bundle shape and one unlock routine. The
 * private key is stored wrapped in AES-256-GCM under a PBKDF2 key derived from
 * the recovery phrase; the GCM tag proves the phrase was right.
 */
import {storage} from './storage';
import {CryptoEngine, combineFragments} from './crypto';
import {legacySha256} from './legacy-hash';

export const RECOVERY_BUNDLE_VERSION = 1;
export const BUNDLE_STORAGE_KEY = 'gl_recovery_bundle';
/**
 * Retired key that held all fragments together. Never written; sealed if an
 * older build left it, and deleted by the legacy migration below.
 */
export const FRAGMENTS_STORAGE_KEY = 'gl_shamir_fragments';
export const RECOVERY_TAG_PREFIX = 'ghostlink:recovery:';

/**
 * Errors carry a `code` so the UI can say which of these actually happened
 * instead of collapsing them into one "recovery failed".
 */
export const RecoveryError = {
  NO_LOCAL_BUNDLE: 'NO_LOCAL_BUNDLE',
  WRONG_PHRASE: 'WRONG_PHRASE',
  BAD_FRAGMENTS: 'BAD_FRAGMENTS',
  KEY_MISMATCH: 'KEY_MISMATCH',
  MALFORMED_BUNDLE: 'MALFORMED_BUNDLE',
};

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The object stored on device and split into Shamir fragments. */
export function createRecoveryBundle({wrappedKey, publicKeyHex, name, ghostAddress}) {
  return {
    v: RECOVERY_BUNDLE_VERSION,
    wrappedKey,
    publicKeyHex,
    name: name || '',
    // Carried rather than re-derived: deriving it costs another 100,000 PBKDF2
    // iterations, and it is a public name, not a secret.
    ghostAddress: ghostAddress || '',
  };
}

/**
 * Wrap a freshly generated private key under the recovery phrase and return the
 * bundle to store and to split. Used at setup.
 */
export async function wrapIdentity({privateKeyRaw, publicKeyHex, name, ghostAddress}, words) {
  const wrapKey = await CryptoEngine.deriveKeyFromSeed(words);
  const wrappedKey = CryptoEngine.encrypt(privateKeyRaw, wrapKey);
  return createRecoveryBundle({wrappedKey, publicKeyHex, name, ghostAddress});
}

/**
 * Turn a bundle plus a phrase back into a usable identity. A wrong phrase fails
 * the GCM tag, costing an attacker a full PBKDF2 run per guess.
 */
export async function unlockBundle(bundle, words) {
  if (!bundle || !bundle.wrappedKey || !bundle.wrappedKey.iv || !bundle.wrappedKey.ciphertext) {
    throw fail(RecoveryError.MALFORMED_BUNDLE, 'This recovery data is missing the wrapped key.');
  }

  const wrapKey = await CryptoEngine.deriveKeyFromSeed(words);

  let privateKeyRaw;
  try {
    privateKeyRaw = CryptoEngine.decrypt(bundle.wrappedKey.ciphertext, bundle.wrappedKey.iv, wrapKey);
  } catch (_e) {
    throw fail(RecoveryError.WRONG_PHRASE, 'That recovery phrase does not unlock this identity.');
  }

  // Derive the public key from what we just unwrapped rather than trusting the
  // copy that travelled in the same blob. If they disagree, the bundle was
  // tampered with or assembled from fragments of two different identities.
  let derivedPublicKey;
  try {
    derivedPublicKey = CryptoEngine.publicKeyFromPrivate(privateKeyRaw);
  } catch (_e) {
    throw fail(RecoveryError.KEY_MISMATCH, 'The recovered private key is not a valid P-256 key.');
  }

  if (bundle.publicKeyHex && bundle.publicKeyHex !== derivedPublicKey) {
    throw fail(
      RecoveryError.KEY_MISMATCH,
      'The recovered key does not match the identity it claims to belong to.',
    );
  }

  const fingerprint = await CryptoEngine.sha256(derivedPublicKey);
  return {
    name: bundle.name || 'Restored',
    publicKeyHex: derivedPublicKey,
    privateKeyRaw,
    fingerprint: fingerprint.slice(0, 16),
    ghostAddress: bundle.ghostAddress || '',
  };
}

/**
 * The lookup key peers store a backup under, derived from the phrase through
 * the PBKDF2 key (with a domain-separating prefix), so a tag is no cheaper to
 * attack than the wrapped key. A blank device has only the phrase to go on.
 */
export async function deriveRecoveryTag(words) {
  const key = await CryptoEngine.deriveKeyFromSeed(words);
  const digest = await CryptoEngine.sha256('ghostlink-recovery-tag-v1:' + key);
  return RECOVERY_TAG_PREFIX + digest.slice(0, 32);
}

export async function saveRecoveryBundle(bundle) {
  await storage.setItem(BUNDLE_STORAGE_KEY, JSON.stringify(bundle));
}

export async function loadRecoveryBundle() {
  const raw = await storage.getItem(BUNDLE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * Same-device restore: the wrapped key is already here, the phrase unlocks it.
 */
export async function restoreFromPhrase(words) {
  const bundle = await loadRecoveryBundle();
  if (!bundle) {
    throw fail(
      RecoveryError.NO_LOCAL_BUNDLE,
      'There is no saved identity on this device. Restore with your recovery fragments instead.',
    );
  }
  const identity = await unlockBundle(bundle, words);
  await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
  return identity;
}

/**
 * New-device restore: 3 of the fragments (5 by default) rebuild the bundle, then the phrase
 * unlocks it. Both are required — fragments alone carry only the wrapped key,
 * and the phrase alone has nothing on a fresh device to unwrap.
 */
export async function restoreFromFragments(fragmentHexes, words) {
  const combined = combineFragments(fragmentHexes);
  if (!combined.success) {
    throw fail(
      RecoveryError.BAD_FRAGMENTS,
      combined.error || 'Those fragments did not reconstruct a recovery bundle.',
    );
  }

  const identity = await unlockBundle(combined.blob, words);

  // The device is now set up: keep the bundle so a later restore here needs
  // only the phrase, and put the key in the keychain for normal use.
  await saveRecoveryBundle(createRecoveryBundle({
    wrappedKey: combined.blob.wrappedKey,
    publicKeyHex: identity.publicKeyHex,
    name: identity.name,
    ghostAddress: identity.ghostAddress,
  }));
  await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
  return identity;
}

// ─── Legacy recovery copies: delete only what nobody needs ────────

/**
 * Legacy recovery data from older builds (stored fragments; on 0.0.0-0.0.2 a
 * wrapped key and phrase check). Sealed at upgrade and deleted here only once
 * a modern bundle for the current identity exists, is rebuilt from the
 * fragments, or is written after the user confirms the phrase.
 */
export const LEGACY_RECOVERY_KEYS = ['gl_shamir_fragments', 'gl_wrapped_privkey', 'gl_seed_check'];

async function presentLegacyKeys() {
  const present = [];
  for (const k of LEGACY_RECOVERY_KEYS) if ((await storage.getItem(k)) != null) present.push(k);
  return present;
}

async function deleteLegacy() {
  for (const k of LEGACY_RECOVERY_KEYS) await storage.removeItem(k);
}

/** A modern bundle that belongs to the identity whose key is in the keychain. */
function bundleMatches(bundle, keyPair) {
  return !!(bundle && bundle.v && bundle.wrappedKey && bundle.wrappedKey.iv && bundle.wrappedKey.ciphertext
    && keyPair && bundle.publicKeyHex === keyPair.publicKeyHex);
}

/**
 * Run at every start (AppContext). Returns
 *   {state: 'none'}                     nothing legacy on the device
 *   {state: 'resolved', how, deleted}   deleted, because nothing depends on it
 *   {state: 'needs-phrase', present}    kept; ask the user to confirm the phrase
 */
export async function assessLegacyRecovery() {
  const present = await presentLegacyKeys();
  if (present.length === 0) return {state: 'none'};
  const keyPair = await CryptoEngine.loadKeyPair();

  if (bundleMatches(await loadRecoveryBundle(), keyPair)) {
    await deleteLegacy();
    return {state: 'resolved', how: 'modern-bundle-present', deleted: present};
  }

  // No usable bundle here: do the stored fragments rebuild one?
  const rawFragments = await storage.getItem('gl_shamir_fragments');
  if (rawFragments) {
    try {
      const hexes = JSON.parse(rawFragments).map((f) => f.data);
      const combined = combineFragments(hexes.slice(0, 3));
      if (combined.success && bundleMatches(combined.blob, keyPair)) {
        await saveRecoveryBundle(createRecoveryBundle(combined.blob));
        if (bundleMatches(await loadRecoveryBundle(), keyPair)) {
          await deleteLegacy();
          return {state: 'resolved', how: 'bundle-restored-from-fragments', deleted: present};
        }
      }
    } catch (_e) {
      // unreadable fragments: fall through, and keep everything
    }
  }
  return {state: 'needs-phrase', present};
}

/**
 * The user has (re)recorded their recovery phrase and entered it. Verify it
 * really is this identity's phrase, make sure a modern bundle wrapped under it
 * exists, and only then delete the legacy copies.
 *
 * Verified by any of: the phrase re-derives the identity key (0.0.3 and
 * later); it unlocks the modern bundle; it matches the 0.0.x phrase check.
 * A wrong phrase deletes nothing.
 */
export async function finishLegacyMigration(words, {name = '', ghostAddress = ''} = {}) {
  const keyPair = await CryptoEngine.loadKeyPair();
  if (!keyPair || !keyPair.privateKeyRaw) {
    throw fail(RecoveryError.NO_LOCAL_BUNDLE,
      'The identity key is not in the keychain, so there is nothing to re-wrap. The older recovery data has been kept.');
  }
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);

  let verified = false;
  try {
    const derived = await CryptoEngine.deriveIdentityKeyPair(words);
    verified = derived.publicKeyHex === keyPair.publicKeyHex;
  } catch (_e) { /* not a phrase-derived identity */ }
  if (!verified) {
    const bundle = await loadRecoveryBundle();
    if (bundle) {
      try { verified = (await unlockBundle(bundle, words)).publicKeyHex === keyPair.publicKeyHex; } catch (_e) { /* wrong phrase or old format */ }
    }
  }
  if (!verified) {
    const check = await storage.getItem('gl_seed_check');
    if (check) verified = (await legacySha256(phrase)) === check;
  }
  if (!verified) {
    throw fail(RecoveryError.WRONG_PHRASE, 'That is not this identity\'s recovery phrase. Nothing was deleted.');
  }

  const bundle = await wrapIdentity(
    {privateKeyRaw: keyPair.privateKeyRaw, publicKeyHex: keyPair.publicKeyHex, name, ghostAddress},
    words,
  );
  await saveRecoveryBundle(bundle);
  if (!bundleMatches(await loadRecoveryBundle(), keyPair)) {
    throw fail(RecoveryError.MALFORMED_BUNDLE, 'The new recovery bundle did not save. The older recovery data has been kept.');
  }
  const present = await presentLegacyKeys();
  await deleteLegacy();
  return {deleted: present};
}
