/**
 * GhostLink Mobile — what goes to disk, and how.
 *
 * Secret values are sealed before reaching AsyncStorage: XChaCha20-Poly1305
 * under a random 32-byte data key, with the storage key as associated data.
 * The data key lives in react-native-encrypted-storage (Keystore / Keychain);
 * bulk data stays in AsyncStorage.
 *
 * No fallback: if the data key is unavailable, a secret write fails.
 *
 * Pure module: backends and randomness are injected; storage.js wires them.
 */
import {xchacha20poly1305} from '@noble/ciphers/chacha';

export const SEALED_PREFIX = 'gl-sealed:v1:';
export const DATA_KEY_NAME = 'gl_data_key_v1';

/**
 * Every AsyncStorage key the app writes. `secret` values are sealed;
 * `retired` keys are never written again and are deleted at upgrade.
 */
export const STORAGE_CLASSIFICATION = Object.freeze({
  '@ghostlink/identity': {
    secret: true,
    why: 'public key, display name and Ghost Address: attributes this device to an identity (AppContext.js, persist identity)',
  },
  '@ghostlink/messages': {
    secret: true,
    why: 'message content (AppContext.js, persist messages)',
  },
  '@ghostlink/peers': {
    secret: true,
    why: 'contacts and their addresses: the social graph (AppContext.js, persist peers)',
  },
  '@ghostlink/ghost_mesh': {
    secret: true,
    why: 'mesh address and public key: a network identifier tied to the identity (AppContext.js, persist ghostMesh)',
  },
  gl_recovery_bundle: {
    secret: true,
    why: 'private key wrapped under the recovery phrase, an offline guessing target, with name, public key and Ghost Address beside it (utils/recovery.js saveRecoveryBundle)',
  },
  '@ghostlink/recovery-fragments': {
    secret: true,
    why: 'recovery shares other people asked this device to hold (services/MobileDistributor.js)',
  },
  '@ghostlink/settings': {
    secret: false,
    why: 'schema version, font size and an optional LAN bridge URL: no content, keys or contacts, and needed before anything else loads (AppContext.js, persist settings)',
  },
  gl_shamir_fragments: {
    secret: true,
    retired: true,
    legacyPending: true,
    why: 'all Shamir shares of the recovery bundle stored together (any 3 rebuild it). Never written again. Sealed in place, and deleted by the recovery migration (utils/recovery.js) only once it is safe: a matching modern bundle exists, or the user has confirmed their phrase',
  },
  gl_wrapped_privkey: {
    secret: true,
    retired: true,
    legacyPending: true,
    why: '0.0.0-0.0.2 builds: the private key wrapped under a 32-bit legacy hash of the phrase (effectively unprotected). Same handling as the fragments',
  },
  gl_seed_check: {
    secret: true,
    retired: true,
    legacyPending: true,
    why: '0.0.0-0.0.2 builds: a 32-bit legacy hash of the recovery phrase. Kept, sealed, only to verify the phrase a 0.0.x user confirms; deleted with the other legacy copies',
  },
  gl_invite_code: {
    retired: true,
    why: 'a random token the Ghost Address replaced: written at setup, never read. Never written again; deleted at upgrade (was SetupScreen.js)',
  },
});

export const SECRET_KEYS = Object.freeze(Object.keys(STORAGE_CLASSIFICATION).filter((k) => STORAGE_CLASSIFICATION[k].secret));
/** Deleted at upgrade outright. */
export const RETIRED_KEYS = Object.freeze(Object.keys(STORAGE_CLASSIFICATION).filter((k) => STORAGE_CLASSIFICATION[k].retired && !STORAGE_CLASSIFICATION[k].legacyPending));
/**
 * Retired, but possibly an install's only way back to its identity: sealed in
 * place and left for the recovery migration to delete once that is safe.
 */
export const LEGACY_PENDING_KEYS = Object.freeze(Object.keys(STORAGE_CLASSIFICATION).filter((k) => STORAGE_CLASSIFICATION[k].legacyPending));

export class SecretStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecretStorageError';
    this.code = code;
  }
}

const te = new TextEncoder();
const td = new TextDecoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => {
  if (typeof h !== 'string' || !/^[0-9a-f]*$/i.test(h) || h.length % 2) throw new SecretStorageError('malformed hex', 'MALFORMED');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * @param {object} deps
 * @param {{getItem, setItem, removeItem}} deps.plain   AsyncStorage
 * @param {{getItem, setItem, removeItem}} deps.secure  react-native-encrypted-storage
 * @param {(n: number) => Uint8Array} deps.randomBytes  CSPRNG
 */
export function createSecretStorage({plain, secure, randomBytes}) {
  if (!plain || !secure || typeof randomBytes !== 'function') {
    throw new SecretStorageError('secret storage needs plain, secure and randomBytes', 'MISCONFIGURED');
  }
  let keyPromise = null;

  /** The data key; created on first need, and only after it reads back. */
  function dataKey() {
    if (!keyPromise) {
      keyPromise = (async () => {
        const existing = await secure.getItem(DATA_KEY_NAME);
        if (existing) {
          const key = fromHex(existing);
          if (key.length !== 32) throw new SecretStorageError('stored data key has the wrong length', 'BAD_KEY');
          return key;
        }
        const key = randomBytes(32);
        if (!(key instanceof Uint8Array) || key.length !== 32) throw new SecretStorageError('randomBytes did not return 32 bytes', 'NO_RNG');
        await secure.setItem(DATA_KEY_NAME, toHex(key));
        const back = await secure.getItem(DATA_KEY_NAME);
        if (back !== toHex(key)) throw new SecretStorageError('data key did not read back from secure storage', 'KEY_NOT_DURABLE');
        return key;
      })().catch((e) => {
        keyPromise = null; // allow a later retry; never fall back
        throw e instanceof SecretStorageError ? e : new SecretStorageError(`secure storage unavailable: ${e && e.message}`, 'SECURE_UNAVAILABLE');
      });
    }
    return keyPromise;
  }

  async function seal(name, value) {
    const key = await dataKey();
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(key, nonce, te.encode(name)).encrypt(te.encode(value));
    return `${SEALED_PREFIX}${toHex(nonce)}:${toHex(ct)}`;
  }

  async function open(name, stored) {
    const [nonceHex, ctHex] = stored.slice(SEALED_PREFIX.length).split(':');
    const key = await dataKey();
    try {
      return td.decode(xchacha20poly1305(key, fromHex(nonceHex), te.encode(name)).decrypt(fromHex(ctHex)));
    } catch {
      throw new SecretStorageError(`${name} could not be opened (wrong key, or moved from another slot)`, 'UNREADABLE');
    }
  }

  const isSecret = (name) => SECRET_KEYS.includes(name);
  const isRetired = (name) => !!STORAGE_CLASSIFICATION[name]?.retired;

  const api = {
    async getItem(name) {
      const stored = await plain.getItem(name);
      if (stored == null) return null;
      if (!isSecret(name)) return stored;
      if (stored.startsWith(SEALED_PREFIX)) return open(name, stored);
      // A pre-sealing plaintext value: seal it in place and serve it. If sealing
      // fails it is still served (it is already on disk); writes stay fail-closed.
      try {
        await plain.setItem(name, await seal(name, stored));
      } catch (e) {
        console.warn(`[secret-storage] ${name} left unsealed: ${e && e.message}`);
      }
      return stored;
    },

    async setItem(name, value) {
      if (isRetired(name)) throw new SecretStorageError(`${name} is retired and must not be written`, 'RETIRED');
      if (!(name in STORAGE_CLASSIFICATION)) throw new SecretStorageError(`${name} is not classified in secret-storage.js`, 'UNCLASSIFIED');
      if (typeof value !== 'string') throw new SecretStorageError('values are strings', 'TYPE');
      return plain.setItem(name, isSecret(name) ? await seal(name, value) : value);
    },

    async removeItem(name) {
      return plain.removeItem(name);
    },

    async multiRemove(names) {
      for (const n of names) await plain.removeItem(n);
    },

    /**
     * Seal every plaintext secret and delete retired keys that cannot be a way
     * back to the identity (legacy recovery copies are left for the recovery
     * migration). Idempotent and restartable.
     */
    async migrate() {
      const report = {sealed: [], alreadySealed: [], deleted: [], absent: []};
      for (const name of RETIRED_KEYS) {
        if ((await plain.getItem(name)) != null) {
          await plain.removeItem(name);
          report.deleted.push(name);
        }
      }
      for (const name of SECRET_KEYS) {
        const stored = await plain.getItem(name);
        if (stored == null) report.absent.push(name);
        else if (stored.startsWith(SEALED_PREFIX)) report.alreadySealed.push(name);
        else {
          await plain.setItem(name, await seal(name, stored));
          report.sealed.push(name);
        }
      }
      return report;
    },

    /** Wipe: forget the data key, so any sealed value left behind is unreadable. */
    async forgetKey() {
      keyPromise = null;
      await secure.removeItem(DATA_KEY_NAME);
    },
  };
  return api;
}
