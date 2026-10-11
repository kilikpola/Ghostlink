import {NativeModules} from 'react-native';
import * as Keychain from 'react-native-keychain';
import {sha256 as nobleSha256} from '@noble/hashes/sha256';
import {hmac as nobleHmac} from '@noble/hashes/hmac';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {gcm} from '@noble/ciphers/aes';
import {p256} from '@noble/curves/p256';
import {x25519} from '@noble/curves/ed25519';
import {sha512} from '@noble/hashes/sha512';
import {WORDLIST, SEED_PHRASE_WORDS} from './wordlist';
import {ghostAddressFromNodeId} from './ghost-address';

/**
 * Primitives come from @noble (React Native has no Web Crypto); randomness from
 * the platform CSPRNG via react-native-get-random-values, imported first in
 * index.js.
 */
function getSecureRandomValues(array) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    // Never fall back to Math.random. A predictable "random" value here is a
    // predictable private key, nonce, or secret share — a silent, total
    // compromise that looks exactly like a working app. Fail instead.
    throw new Error(
      '[GhostLink:crypto] No secure random source. ' +
        "Ensure `import 'react-native-get-random-values';` runs at app startup " +
        '(index.js) before any crypto is used.',
    );
  }
  return c.getRandomValues(array);
}

function getRandomBytes(n) {
  return getSecureRandomValues(new Uint8Array(n));
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const matched = hex.match(/.{2}/g);
  if (!matched) return new Uint8Array(0);
  return new Uint8Array(matched.map(b => parseInt(b, 16)));
}

const utf8 = str => new TextEncoder().encode(str);

/**
 * SHA-256 over the UTF-8 bytes of `data`, hex encoded. Must match the web
 * app's CryptoEngine.sha256 for fingerprints to agree.
 */
async function sha256(data) {
  return bytesToHex(nobleSha256(typeof data === 'string' ? utf8(data) : data));
}

function hmacSha256(key, message) {
  const keyBytes = typeof key === 'string' ? utf8(key) : key;
  const msgBytes = typeof message === 'string' ? utf8(message) : message;
  return bytesToHex(nobleHmac(nobleSha256, keyBytes, msgBytes));
}

/**
 * AES-256-GCM. Wire format matches the web app's CryptoEngine: a 12-byte IV and
 * a ciphertext with the 16-byte tag appended, both hex encoded.
 */
const GCM_IV_BYTES = 12;

/**
 * Key material for the AES functions. A 64-char hex string is used as 32 raw
 * bytes; anything else is padded/truncated to 32 UTF-8 characters, as on web.
 */
function resolveAesKey(key) {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new Error('AES key must be 32 bytes');
    return key;
  }
  if (typeof key !== 'string') throw new Error('AES key must be a string or Uint8Array');
  if (/^[0-9a-fA-F]{64}$/.test(key)) return hexToBytes(key);
  return utf8(key.padEnd(32, '0').slice(0, 32));
}

function aesGcmEncrypt(plaintext, key) {
  const iv = getRandomBytes(GCM_IV_BYTES);
  const sealed = gcm(resolveAesKey(key), iv).encrypt(utf8(plaintext));
  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(sealed),
  };
}

function aesGcmDecrypt(ciphertextHex, ivHex, key) {
  const iv = hexToBytes(ivHex);
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-GCM IV must be 12 bytes');
  // Throws if the tag does not verify. Callers must let that propagate:
  // swallowing it is what turns a detected forgery back into silent acceptance.
  const opened = gcm(resolveAesKey(key), iv).decrypt(hexToBytes(ciphertextHex));
  return new TextDecoder().decode(opened);
}

/**
 * An ECDH P-256 keypair; the public key is the uncompressed point
 * (0x04 ‖ X ‖ Y), matching the web app's raw export.
 */
function generateKeyPairSync() {
  const privateKeyRaw = p256.utils.randomPrivateKey();
  const publicKeyRaw = p256.getPublicKey(privateKeyRaw, false); // uncompressed
  return {
    publicKeyHex: bytesToHex(publicKeyRaw),
    privateKeyRaw: bytesToHex(privateKeyRaw),
  };
}

/**
 * The uncompressed P-256 public key for a private key, hex encoded. Used to
 * prove an unwrapped key belongs to the identity being restored.
 */
function publicKeyFromPrivate(privateKeyHex) {
  return bytesToHex(p256.getPublicKey(hexToBytes(privateKeyHex), false));
}

/**
 * ECDH shared secret with a peer's uncompressed P-256 public key, hashed to a
 * 32-byte AES key. Returns hex, ready to hand to the AES functions above.
 */
function deriveSharedKey(privateKeyHex, peerPublicKeyHex) {
  const shared = p256.getSharedSecret(hexToBytes(privateKeyHex), hexToBytes(peerPublicKeyHex), true);
  // Drop the leading format byte and hash the X coordinate, which is what
  // WebCrypto's ECDH deriveBits yields before its own KDF step.
  return bytesToHex(nobleSha256(shared.slice(1)));
}

/* ─── PBKDF2: native when available, JS otherwise ─────────────────────────── */

/**
 * Pure-JS PBKDF2 takes minutes under Hermes, so Pbkdf2Module runs it in Kotlin
 * on a background thread with byte-identical output. Without the module this
 * falls back to @noble.
 */
const NativePbkdf2 = NativeModules.Pbkdf2 || null;

/** Cleared after a native failure, so one failure does not cost every call a retry. */
let nativePbkdf2Usable = !!NativePbkdf2;

/** Which implementation served the last derivation — read by diagnostics and tests. */
let lastPbkdf2Impl = null;
function getLastPbkdf2Impl() {
  return lastPbkdf2Impl;
}

/**
 * PBKDF2 over the UTF-8 bytes of `phrase` and `salt`.
 *
 * @param {'sha256'|'sha512'} hash
 * @returns {Promise<Uint8Array>} the derived key
 */
async function pbkdf2(phrase, salt, hash, iterations, dkLen) {
  if (nativePbkdf2Usable) {
    try {
      const hex = await NativePbkdf2.derive(phrase, salt, iterations, dkLen, hash);
      const out = hexToBytes(hex);
      if (out.length !== dkLen) {
        throw new Error(`native PBKDF2 returned ${out.length} bytes, expected ${dkLen}`);
      }
      lastPbkdf2Impl = 'native';
      return out;
    } catch (e) {
      // Never silently produce a different key: fall through to the JS
      // implementation, which is the definition of correct here.
      console.warn(
        '[GhostLink:crypto] native PBKDF2 unavailable, falling back to JS (slow):',
        e && e.message ? e.message : e,
      );
      nativePbkdf2Usable = false;
    }
  }
  const prf = hash === 'sha512' ? sha512 : nobleSha256;
  const out = await pbkdf2Async(prf, utf8(phrase), utf8(salt), {c: iterations, dkLen});
  lastPbkdf2Impl = 'js';
  return out;
}

/**
 * The messaging keypair for a recovery phrase: same phrase, same key, on any
 * device. Its salt differs from the mesh derivation's so the keys are
 * unrelated. 100,000 PBKDF2 iterations, so derive once and keep the result.
 *
 * Identities created before this existed have a random stored key that cannot
 * be re-derived; see MOBILE_BUILD.md.
 */
async function deriveIdentityKeyPair(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const seed = await pbkdf2(phrase, 'ghostlink-identity-key-v1', 'sha512', 100000, 32);

  // p256 rejects a scalar outside [1, n-1]. Rejection-sample by re-hashing
  // rather than reducing, which would bias the key.
  let candidate = seed;
  for (let i = 0; i < 64; i++) {
    if (p256.utils.isValidPrivateKey(candidate)) {
      return {
        publicKeyHex: bytesToHex(p256.getPublicKey(candidate, false)),
        privateKeyRaw: bytesToHex(candidate),
      };
    }
    candidate = nobleSha256(candidate);
  }
  throw new Error('could not derive a valid identity key from this phrase');
}

/**
 * The Ghost Mesh identity for a recovery phrase (same as gmp-core/identity.ts):
 *
 *   seed      = PBKDF2-HMAC-SHA512(phrase, "ghostlink-yggdrasil-v1", 100k, 32)
 *   staticPub = X25519(seed)
 *   nodeId    = SHA-512(staticPub)
 *   address   = first 45 bits of nodeId, Crockford base32
 *
 * Slow by design; derive once at setup and keep the result.
 */
async function deriveGhostIdentity(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const seed = await pbkdf2(phrase, 'ghostlink-yggdrasil-v1', 'sha512', 100000, 32);
  const staticPubKey = x25519.getPublicKey(seed);
  const nodeId = sha512(staticPubKey);
  const nodeIdHex = bytesToHex(nodeId);
  return {
    nodeIdHex,
    staticPubKeyHex: bytesToHex(staticPubKey),
    ghostAddress: ghostAddressFromNodeId(nodeIdHex),
  };
}

/**
 * A recovery phrase drawn uniformly from the shared wordlist with the CSPRNG,
 * using rejection sampling to avoid modulo bias.
 */
function generateSeedPhrase(wordCount = SEED_PHRASE_WORDS, wordlist = WORDLIST) {
  const n = wordlist.length;
  if (!n) throw new Error('Wordlist is empty');
  const limit = Math.floor(65536 / n) * n; // largest unbiased multiple
  const words = [];
  while (words.length < wordCount) {
    const b = getRandomBytes(2);
    const value = (b[0] << 8) | b[1];
    if (value >= limit) continue; // discard, do not fold
    words.push(wordlist[value % n]);
  }
  return words;
}

function genInvite() {
  const b = getRandomBytes(16);
  const c = bytesToHex(b);
  return `GL-${c.slice(0, 8)}-${c.slice(8, 16)}-${c.slice(16, 24)}-${c.slice(24, 32)}`.toUpperCase();
}

/**
 * Write the identity keypair to the platform keystore.
 *
 * @throws {Error} if the keypair could not be persisted
 */
async function storeKeyPair(publicKeyHex, privateKeyRaw) {
  try {
    await Keychain.setGenericPassword('ghostlink_keypair', JSON.stringify({publicKeyHex, privateKeyRaw}), {
      service: 'com.ghostlink.keys',
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return true;
  } catch (e) {
    throw new Error(
      `Could not save the identity key to this device's secure storage: ${e.message || e}`,
    );
  }
}

async function loadKeyPair() {
  try {
    const credentials = await Keychain.getGenericPassword({service: 'com.ghostlink.keys'});
    if (credentials) {
      return JSON.parse(credentials.password);
    }
    return null;
  } catch (_e) {
    return null;
  }
}

async function clearKeys() {
  try {
    await Keychain.resetGenericPassword({service: 'com.ghostlink.keys'});
    return true;
  } catch (_e) {
    return false;
  }
}

async function hasBiometrics() {
  try {
    const type = await Keychain.getSupportedBiometryType();
    return type !== null;
  } catch (_e) {
    return false;
  }
}

/**
 * The 256-bit key wrapping the private key at rest: PBKDF2-HMAC-SHA256, salt
 * "ghostlink-v2-salt", 100,000 iterations — the web app's parameters. Slow by
 * design; derive once and keep it in memory.
 */
async function deriveKeyFromSeed(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const bits = await pbkdf2(phrase, 'ghostlink-v2-salt', 'sha256', 100000, 32);
  return bytesToHex(bits);
}

/**
 * The key for message history at rest. A separate derivation from
 * deriveKeyFromSeed — different salt, higher work factor — so the key that
 * wraps the private key and the key that encrypts stored messages are never the
 * same bytes. Mirrors the web app's deriveStorageKey.
 */
async function deriveStorageKey(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const bits = await pbkdf2(phrase, 'ghostlink-storage-v1', 'sha256', 200000, 32);
  return bytesToHex(bits);
}

const ShamirSSS = (() => {
  // GF(2^8) with AES's reduction polynomial 0x11b; 0x03 is a primitive
  // element, so stepping by 3 walks all 255 non-zero values.
  const xtime = a => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;

  const LOG = new Uint8Array(256);
  const EXP = new Uint8Array(512);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = EXP[i + 255] = x;
    LOG[x] = i;
    x = (xtime(x) ^ x) & 0xff; // x *= 3
  }

  const mul = (a, b) => (!a || !b ? 0 : EXP[LOG[a] + LOG[b]]);
  const div = (a, b) => (!a ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);
  const eval_ = (c, xv) => {
    let r = 0;
    for (let i = c.length - 1; i >= 0; i--) {
      r = mul(r, xv) ^ c[i];
    }
    return r;
  };

  return {
    split(secret, n, k) {
      const shares = Array.from({length: n}, (_, i) => ({
        x: i + 1,
        y: new Uint8Array(secret.length),
      }));
      for (let i = 0; i < secret.length; i++) {
        const c = new Uint8Array(k);
        c[0] = secret[i];
        for (let j = 1; j < k; j++) {
          c[j] = getRandomBytes(1)[0];
        }
        shares.forEach(s => {
          s.y[i] = eval_(Array.from(c), s.x);
        });
      }
      return shares;
    },
    combine(shares) {
      const len = shares[0].y.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let j = 0; j < shares.length; j++) {
          let n = shares[j].y[i];
          let d = 1;
          for (let m = 0; m < shares.length; m++) {
            if (m !== j) {
              n = mul(n, shares[m].x);
              d = mul(d, shares[j].x ^ shares[m].x);
            }
          }
          s ^= div(n, d);
        }
        out[i] = s;
      }
      return out;
    },
  };
})();

/**
 * Manual Shamir backup, 3 of 5 by default; three shares plus the recovery
 * phrase restore the identity.
 */
export const FRAGMENT_SHARES = 5;
export const FRAGMENT_THRESHOLD = 3;

function generateBackupFragments(blobStr, shareCount = FRAGMENT_SHARES, threshold = FRAGMENT_THRESHOLD) {
  const dataBytes = new TextEncoder().encode(blobStr);
  const shares = ShamirSSS.split(dataBytes, shareCount, threshold);
  return shares.map(share => {
    const encoded = [share.x, ...share.y].map(b => b.toString(16).padStart(2, '0')).join('');
    return {
      id: share.x,
      label: `Fragment ${share.x} of ${shareCount}`,
      data: encoded,
      check: encoded.slice(0, 8),
      distributed: false,
      peerName: '',
    };
  });
}

function combineFragments(fragmentHexArray) {
  if (fragmentHexArray.length < 3) {
    return {success: false, error: `Need at least 3 fragments, got ${fragmentHexArray.length}`};
  }
  try {
    const shares = fragmentHexArray.map(hex => {
      const bytes = hex
        .trim()
        .match(/.{2}/g)
        .map(b => parseInt(b, 16));
      return {x: bytes[0], y: new Uint8Array(bytes.slice(1))};
    });
    const reconstructed = ShamirSSS.combine(shares);
    const blob = JSON.parse(new TextDecoder().decode(reconstructed));
    return {success: true, blob};
  } catch (e) {
    return {success: false, error: 'Fragment reconstruction failed'};
  }
}

export const CryptoEngine = {
  generateKeyPair: generateKeyPairSync,
  deriveSharedKey,
  publicKeyFromPrivate,
  deriveGhostIdentity,
  sha256,
  hmacSha256,
  encrypt: aesGcmEncrypt,
  decrypt: aesGcmDecrypt,
  generateSeedPhrase,
  genInvite,
  storeKeyPair,
  getLastPbkdf2Impl,
  loadKeyPair,
  clearKeys,
  deriveIdentityKeyPair,
  hasBiometrics,
  deriveKeyFromSeed,
  deriveStorageKey,
  bytesToHex,
  hexToBytes,
  getRandomBytes,
};

export {ShamirSSS, generateBackupFragments, combineFragments, hmacSha256, sha256, generateSeedPhrase, deriveGhostIdentity};
export default CryptoEngine;
