/**
 * GhostLink Mobile — Crypto Service
 *
 * Cryptographic operations backed by `react-native-quick-crypto` (OpenSSL,
 * synchronous), resolved lazily because it is not a dependency of this build.
 *
 * @module CryptoService
 */

// react-native-quick-crypto is not installed in this build (only the disabled
// Ghost Mesh setup modal uses this file). Resolve it lazily so any call fails
// loudly instead of breaking Metro resolution.
const QUICK_CRYPTO_MISSING =
  '[GhostLink:Crypto] react-native-quick-crypto is not installed in this build. ' +
  'Ghost Mesh identity derivation is unavailable. Install it and rebuild to enable ' +
  'the mesh, or use the desktop/web build.';

const QuickCrypto = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`${QUICK_CRYPTO_MISSING} (tried to use crypto.${String(prop)})`);
    },
  },
);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer / Uint8Array to a hex string.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
function bufToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate cryptographically secure random bytes.
 * @param {number} length
 * @returns {Uint8Array}
 */
function randomBytes(length) {
  return new Uint8Array(QuickCrypto.randomBytes(length));
}

// ─── CryptoService ──────────────────────────────────────────────────────────

const CryptoService = {
  /**
   * Generate an ECDH P-256 key pair.
   *
   * Returns the public key as a hex-encoded uncompressed point and the
   * private key as a hex-encoded 32-byte scalar, matching the format the
   * web client exchanges over signaling.
   *
   * @returns {{ publicKey: string, privateKey: string }}
   */
  generateKeyPair() {
    const ecdh = QuickCrypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey('hex'),
      privateKey: ecdh.getPrivateKey('hex'),
    };
  },

  /**
   * Compute a shared secret from our private key and a peer's public key.
   * The result is a raw 32-byte hex string suitable as an AES-256 key.
   *
   * @param {string} privateKeyHex Our ECDH private key (hex).
   * @param {string} peerPublicKeyHex Peer's ECDH public key (hex).
   * @returns {string} 32-byte shared secret (hex).
   */
  deriveSharedSecret(privateKeyHex, peerPublicKeyHex) {
    const ecdh = QuickCrypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    const shared = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
    return shared.toString('hex');
  },

  /**
   * SHA-256 hash of arbitrary data.
   *
   * @param {string|Uint8Array} data UTF-8 string or raw bytes.
   * @returns {string} Hex-encoded hash.
   */
  sha256(data) {
    const hash = QuickCrypto.createHash('sha256');
    if (typeof data === 'string') {
      hash.update(data, 'utf8');
    } else {
      hash.update(Buffer.from(data));
    }
    return hash.digest('hex');
  },

  /**
   * Encrypt plaintext with AES-256-GCM.
   *
   * @param {string} text Plaintext to encrypt.
   * @param {string} keyHex 32-byte key as hex (64 hex chars).
   * @returns {{ iv: string, ciphertext: string, tag: string }}
   *   All fields are hex-encoded.
   */
  encrypt(text, keyHex) {
    const iv = randomBytes(12); // 96-bit IV for GCM
    const key = Buffer.from(keyHex, 'hex');
    const cipher = QuickCrypto.createCipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv),
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      iv: bufToHex(iv),
      ciphertext: encrypted,
      tag,
    };
  },

  /**
   * Decrypt AES-256-GCM ciphertext.
   *
   * @param {{ iv: string, ciphertext: string, tag: string }} encrypted
   *   All fields hex-encoded.
   * @param {string} keyHex 32-byte key as hex.
   * @returns {string} Decrypted plaintext.
   * @throws {Error} If authentication tag verification fails.
   */
  decrypt(encrypted, keyHex) {
    const { iv, ciphertext, tag } = encrypted;
    const key = Buffer.from(keyHex, 'hex');
    const decipher = QuickCrypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(hexToBuf(iv)),
    );
    decipher.setAuthTag(Buffer.from(hexToBuf(tag)));

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  },

  /**
   * Derive a 256-bit key from a seed phrase using PBKDF2.
   *
   * @param {string} words Space-separated seed words (e.g. BIP-39 mnemonic).
   * @param {string} [salt='ghostlink-seed'] Optional salt.
   * @returns {Promise<string>} Hex-encoded 32-byte derived key.
   */
  deriveKeyFromSeed(words, salt = 'ghostlink-seed') {
    return new Promise((resolve, reject) => {
      QuickCrypto.pbkdf2(
        words,
        salt,
        100000, // 100k iterations
        32, // 256-bit key
        'sha256',
        (err, derivedKey) => {
          if (err) return reject(err);
          resolve(Buffer.from(derivedKey).toString('hex'));
        },
      );
    });
  },

  /**
   * Wrap (encrypt) an ECDH private key with a wrapping key using AES-256-GCM.
   *
   * @param {string} privateKeyHex ECDH private key to wrap (hex).
   * @param {string} wrappingKeyHex 32-byte wrapping key (hex).
   * @returns {{ iv: string, ciphertext: string, tag: string }}
   */
  wrapPrivKey(privateKeyHex, wrappingKeyHex) {
    return CryptoService.encrypt(privateKeyHex, wrappingKeyHex);
  },

  /**
   * Unwrap (decrypt) an ECDH private key.
   *
   * @param {{ iv: string, ciphertext: string, tag: string }} wrapped
   * @param {string} wrappingKeyHex 32-byte wrapping key (hex).
   * @returns {string} Recovered ECDH private key (hex).
   */
  unwrapPrivKey(wrapped, wrappingKeyHex) {
    return CryptoService.decrypt(wrapped, wrappingKeyHex);
  },

  /**
   * Generate a GhostLink invite code in the format GL-XXXX-XXXX-XXXX-XXXX.
   * Uses crypto-random bytes mapped to uppercase alphanumeric characters.
   *
   * @returns {string} e.g. "GL-A3F7-K9B2-M4X1-Q8Z5"
   */
  genInvite() {
    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(16);
    const groups = [];

    for (let g = 0; g < 4; g++) {
      let segment = '';
      for (let i = 0; i < 4; i++) {
        segment += CHARSET[bytes[g * 4 + i] % CHARSET.length];
      }
      groups.push(segment);
    }

    return `GL-${groups.join('-')}`;
  },

  /**
   * Generate secure random bytes (exposed for external use).
   * @param {number} length
   * @returns {Uint8Array}
   */
  randomBytes,

  // ─── Ghost Mesh (Yggdrasil) Key Derivation ──────────────────────────────

  /**
   * Derive the legacy Yggdrasil IPv6 address for a seed phrase.
   *
   * ⚠ MUST NOT BE USED TO DERIVE A GHOST ADDRESS OR ANY IDENTITY. ⚠
   *
   * A routing address for a self-hosted Yggdrasil daemon, used only by the
   * (disabled) Ghost Mesh setup modal. Its KDF differs from identity derivation:
   *
   *   this function   PBKDF2-HMAC-SHA256, salt "ghostlink-yggdrasil-v1"
   *   Ghost Address   PBKDF2-HMAC-SHA512, same salt — see
   *                   CryptoEngine.deriveGhostIdentity in utils/crypto.js
   *
   * Mirrors CryptoEngine.deriveLegacyYggdrasilIP in the web app.
   *
   * @param {string[]} words Array of 12 or 24 seed words.
   * @returns {Promise<{ publicKeyHex: string, privateKeyHex: string, address: string }>}
   */
  async deriveLegacyYggdrasilIP(words) {
    // Step 1: PBKDF2 → 32-byte seed
    const seedHex = await new Promise((resolve, reject) => {
      QuickCrypto.pbkdf2(
        words.join(' '),
        'ghostlink-yggdrasil-v1',
        100000,
        32,
        'sha256',
        (err, derivedKey) => {
          if (err) return reject(err);
          resolve(Buffer.from(derivedKey).toString('hex'));
        },
      );
    });

    const rawKeyBytes = hexToBuf(seedHex);

    // Step 2: X25519 public key from seed
    const publicKeyBytes = CryptoService.curve25519PublicKeyFromSeed(rawKeyBytes);

    // Step 3: Yggdrasil IPv6 address from public key
    const address = await CryptoService._legacyYggdrasilIPFromKey(publicKeyBytes);

    const publicKeyHex = bufToHex(publicKeyBytes);
    const privateKeyHex = bufToHex(rawKeyBytes);

    return {publicKeyHex, privateKeyHex, address};
  },

  /**
   * Compute the X25519 (Curve25519) public key from a 32-byte private key seed.
   *
   * Uses @noble/curves for a pure-JS, audited X25519 scalar-basepoint multiplication.
   * This is the standard operation: publicKey = clamp(seed) * G, where G is the
   * Curve25519 base point (9).
   *
   * @param {Uint8Array} seedBytes 32-byte private key seed.
   * @returns {Uint8Array} 32-byte X25519 public key.
   */
  curve25519PublicKeyFromSeed(seedBytes) {
    // @noble/curves x25519 provides getPublicKey(privateKey) which performs
    // the standard Curve25519 scalar multiplication against base point 9.
    const {x25519} = require('@noble/curves/ed25519');
    return x25519.getPublicKey(seedBytes);
  },

  /**
   * Yggdrasil IPv6 address from an X25519 public key (as in yggdrasil-go
   * address.go): 0x02, the count of leading 1-bits of SHA-512(key), then the
   * 112 hash bits after the first following 0-bit. Private helper of
   * deriveLegacyYggdrasilIP — see the warning there.
   *
   * @param {Uint8Array} publicKeyBytes 32-byte X25519 public key.
   * @returns {Promise<string>} Yggdrasil IPv6 address string.
   * @private
   */
  async _legacyYggdrasilIPFromKey(publicKeyBytes) {
    const {sha512} = require('@noble/hashes/sha512');
    const hash = sha512(publicKeyBytes);

    // Count leading 1-bits
    let leadingOnes = 0;
    for (let i = 0; i < hash.length; i++) {
      const byte = hash[i];
      let mask = 0x80;
      while (mask > 0) {
        if ((byte & mask) !== 0) {
          leadingOnes++;
          mask >>= 1;
        } else {
          break;
        }
      }
      if (mask > 0) {
        break;
      }
    }

    // Build 16-byte address
    const addr = new Uint8Array(16);
    addr[0] = 0x02;
    addr[1] = leadingOnes;

    let bitSrc = leadingOnes + 1;
    for (let i = 0; i < 112; i++) {
      const srcBitPos = bitSrc + i;
      const srcByteIdx = Math.floor(srcBitPos / 8);
      const srcBitIdx = 7 - (srcBitPos % 8);
      const bitVal = (hash[srcByteIdx] >> srcBitIdx) & 1;

      const destBitPos = 16 + i;
      const destByteIdx = Math.floor(destBitPos / 8);
      const destBitIdx = 7 - (destBitPos % 8);

      if (bitVal) {
        addr[destByteIdx] |= 1 << destBitIdx;
      }
    }

    // Format as IPv6 with :: compression
    const segments = [];
    for (let i = 0; i < 16; i += 2) {
      const val = (addr[i] << 8) | addr[i + 1];
      segments.push(val.toString(16));
    }

    const rawIp = segments.join(':');
    const segs = rawIp.split(':');
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < segs.length; i++) {
      if (parseInt(segs[i], 16) === 0) {
        if (curStart === -1) {
          curStart = i;
          curLen = 1;
        } else {
          curLen++;
        }
        if (curLen > bestLen) {
          bestStart = curStart;
          bestLen = curLen;
        }
      } else {
        curStart = -1;
        curLen = 0;
      }
    }
    if (bestLen > 1) {
      const before = segs.slice(0, bestStart).join(':');
      const after = segs.slice(bestStart + bestLen).join(':');
      return (before === '' ? '' : before) + '::' + (after === '' ? '' : after);
    }
    return rawIp;
  },
};

export default CryptoService;
