// contact-vault.js — desktop secret storage, mirroring mobile's
// mobile/src/utils/secret-storage.js EXACTLY: same envelope (XChaCha20-Poly1305,
// 24-byte nonce, key name as AAD), same 'gl-sealed:v1:' prefix. The 32-byte data
// key comes from Electron safeStorage (OS keyring) via the main process; this
// module never generates or falls back to a key of its own — if no key is
// available it FAILS CLOSED (throws on write; refuses to serve a secret).
//
// Bundled to vendor/contact-vault.js (ESM, reached via the "@ghostlink/contact-vault"
// importmap entry) by build-vendor.js, and imported directly by
// test/contact-vault.test.mjs, so one source is both shipped and tested.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const SEALED_PREFIX = 'gl-sealed:v1:';
const te = new TextEncoder();
const td = new TextDecoder();

export class SecretStorageError extends Error {
  constructor(message, code) { super(message); this.name = 'SecretStorageError'; this.code = code; }
}

function toHex(u8) { return Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(h) { const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; }
function randomBytes(n) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    // Both the Electron renderer and Node >=20 expose globalThis.crypto; if it
    // is missing we cannot make a nonce, so fail closed rather than use a weak one.
    throw new SecretStorageError('no CSPRNG (globalThis.crypto) available', 'SECURE_UNAVAILABLE');
  }
  const u = new Uint8Array(n); c.getRandomValues(u); return u;
}
function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new SecretStorageError('no 32-byte data key; secure storage unavailable', 'SECURE_UNAVAILABLE');
  }
}

export function isSealed(stored) { return typeof stored === 'string' && stored.startsWith(SEALED_PREFIX); }

// ── Crash-safe migration (plaintext -> sealed) ──
// Order: write the sealed copy to a STAGING key, read it back and verify it
// opens to the original, and ONLY THEN overwrite the real key. The real key is
// never left unreadable: before the final overwrite it still holds the readable
// plaintext; the overwrite to a verified-openable sealed value is one atomic
// localStorage write; a crash at any point leaves either the plaintext or the
// verified sealed value (and at worst an orphaned staging entry, cleaned on the
// next boot). If verification fails we keep the plaintext and retry next boot.
export const STAGING_SUFFIX = '::sealing';

export function migrateKeyCrashSafe(storage, key, dataKey, name = key) {
  const raw = storage.getItem(key);
  if (raw == null) return 'absent';
  if (isSealed(raw)) return 'already-sealed';
  const sealed = seal(dataKey, name, raw);
  const staging = key + STAGING_SUFFIX;
  storage.setItem(staging, sealed);                 // 1. sealed copy to staging
  let ok = false;
  try { ok = open(dataKey, name, storage.getItem(staging)) === raw; } catch { ok = false; } // 2. read back + verify
  if (ok) {
    storage.setItem(key, sealed);                   // 3. promote (atomic; plaintext gone only now)
    storage.removeItem(staging);                    // 4. drop staging
    return 'sealed';
  }
  storage.removeItem(staging);                      // verify failed: keep plaintext, retry later
  return 'kept-plaintext';
}

/** Remove any orphaned staging entries left by a crashed migration. */
export function cleanupStaging(storage, keys) {
  for (const k of keys) { try { storage.removeItem(k + STAGING_SUFFIX); } catch { /* ignore */ } }
}

/** Migrate all given keys crash-safely; `keys` are both the storage key and the AAD. */
export function migrateAllCrashSafe(storage, keys, dataKey) {
  cleanupStaging(storage, keys);
  const report = {};
  for (const key of keys) report[key] = migrateKeyCrashSafe(storage, key, dataKey, key);
  return report;
}

/** Seal `value` (a string) under `name` (bound as AAD). Fails closed without a key. */
export function seal(key, name, value) {
  assertKey(key);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, te.encode(name)).encrypt(te.encode(value));
  return `${SEALED_PREFIX}${toHex(nonce)}:${toHex(ct)}`;
}

/** Open a sealed value. AAD-bound to `name`: a value moved to another key fails. */
export function open(key, name, stored) {
  assertKey(key);
  const [nonceHex, ctHex] = stored.slice(SEALED_PREFIX.length).split(':');
  try {
    return td.decode(xchacha20poly1305(key, fromHex(nonceHex), te.encode(name)).decrypt(fromHex(ctHex)));
  } catch {
    throw new SecretStorageError(`${name} could not be opened (wrong key, or moved from another slot)`, 'UNREADABLE');
  }
}

/**
 * A localStorage-shaped secret store over a sync `storage` ({getItem,setItem,removeItem})
 * and a `getKey()` that returns the cached 32-byte data key or null (fail closed).
 *   - getItem: sealed -> open; plaintext (pre-migration) -> seal in place then serve;
 *     missing key -> throw (never serve a secret we cannot re-protect).
 *   - setItem: fail closed — no key, no write.
 *   - migrate(names): seal any still-plaintext secret keys; per-key and idempotent,
 *     so a crash mid-sweep leaves every key individually readable (plaintext OR sealed).
 */
export function createContactVault({ storage, getKey, onUnavailable = () => {} }) {
  const available = () => { const k = getKey(); return k instanceof Uint8Array && k.length === 32; };
  return {
    available,
    getItem(name) {
      const raw = storage.getItem(name);
      if (raw == null) return null;
      const key = getKey();
      assertKey(key); // no key -> cannot safely serve a secret
      if (isSealed(raw)) return open(key, name, raw);
      // Pre-migration plaintext: seal in place (best effort) and serve it.
      try { storage.setItem(name, seal(key, name, raw)); }
      catch (e) { console.warn(`[contact-vault] ${name} left unsealed: ${e && e.message}`); }
      return raw;
    },
    setItem(name, value) {
      const key = getKey();
      if (!(key instanceof Uint8Array) || key.length === 0 || key.length !== 32) {
        onUnavailable(name);
        throw new SecretStorageError(`refusing to write ${name}: secure storage unavailable`, 'SECURE_UNAVAILABLE');
      }
      storage.setItem(name, seal(key, name, value));
    },
    /** Startup migration: seal each still-plaintext secret key, atomically per key. */
    migrate(names) {
      const key = getKey();
      if (!(key instanceof Uint8Array) || key.length !== 32) return { sealed: [], skipped: names.slice() };
      const sealed = [];
      for (const name of names) {
        const raw = storage.getItem(name);
        if (raw == null || isSealed(raw)) continue;
        try { storage.setItem(name, seal(key, name, raw)); sealed.push(name); }
        catch (e) { console.error(`[contact-vault] migration could not seal ${name}: ${e && e.message}`); }
      }
      return { sealed, skipped: [] };
    },
  };
}
