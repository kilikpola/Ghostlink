/**
 * GhostLink Mobile — app-layer session encryption for the direct WebRTC path.
 *
 * Mesh traffic is end-to-end via GMP. A direct data channel only has DTLS per
 * hop, so the transport seals payloads here. Not wire-compatible with the web
 * client's per-payload ECIES (see MOBILE_BUILD.md).
 *
 *     shared  = X25519(ourPrivate, theirPublic)          // same on both sides
 *     lo, hi  = the two node ids, sorted                 // same on both sides
 *     key A→B = HKDF-SHA256(shared, salt, info = `ghostlink-v2-${lo}->${hi}`)
 *     key B→A = HKDF-SHA256(shared, salt, info = `ghostlink-v2-${hi}->${lo}`)
 *
 * AES-256-GCM with a fresh 12-byte IV per message. No forward secrecy or
 * ratchet: one key pair per session.
 */

import {x25519} from '@noble/curves/ed25519';
import {hkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha256';
import {gcm} from '@noble/ciphers/aes';

/** AES-GCM standard nonce length. Also what the web client uses. */
const IV_BYTES = 12;
/**
 * Bumped when the derivation or wire shape changes, so a mismatch fails at the
 * version check:
 *
 *   1 — PBKDF2-HMAC-SHA256, 100k iterations
 *   2 — HKDF-SHA256 (current)
 */
const WIRE_VERSION = 2;
/** Domain separation for the HKDF extract step. */
const HKDF_SALT = 'ghostlink-session-v2';

const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('expected an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    out[i] = byte;
  }
  return out;
}

/** A fresh X25519 keypair for one session. */
export function generateSessionKeyPair() {
  const privateKey = x25519.utils.randomPrivateKey();
  return {privateKey, publicKey: x25519.getPublicKey(privateKey), publicKeyHex: toHex(x25519.getPublicKey(privateKey))};
}

/**
 * Derive the directional keys for a peer pair.
 *
 * Both sides call this with their own private key and the other's public key
 * and arrive at the same two keys, mirrored: our send key is their receive key.
 *
 * @param {Uint8Array} ourPrivateKey
 * @param {Uint8Array|string} theirPublicKey raw bytes or hex
 * @param {string} ourId our node id / peer id
 * @param {string} theirId their node id / peer id
 * @returns {Promise<{sendKey: Uint8Array, recvKey: Uint8Array}>}
 */
export async function deriveSessionKeys(ourPrivateKey, theirPublicKey, ourId, theirId) {
  if (!ourId || !theirId) throw new Error('both peer ids are required to derive session keys');
  if (ourId === theirId) throw new Error('refusing to derive a session with ourselves');

  const theirKey = typeof theirPublicKey === 'string' ? fromHex(theirPublicKey) : theirPublicKey;
  const shared = x25519.getSharedSecret(ourPrivateKey, theirKey);

  // Sorted so that neither side needs to know who dialled whom.
  const [lo, hi] = ourId < theirId ? [ourId, theirId] : [theirId, ourId];
  const forward = `ghostlink-v${WIRE_VERSION}-${lo}->${hi}`;
  const backward = `ghostlink-v${WIRE_VERSION}-${hi}->${lo}`;

  // HKDF: the X25519 secret is already uniform, so there is nothing for a
  // PBKDF2 work factor to protect.
  const salt = encoder.encode(HKDF_SALT);
  const forwardKey = hkdf(sha256, shared, salt, encoder.encode(forward), 32);
  const backwardKey = hkdf(sha256, shared, salt, encoder.encode(backward), 32);

  // We send along the arrow that points away from us.
  return ourId === lo
    ? {sendKey: forwardKey, recvKey: backwardKey}
    : {sendKey: backwardKey, recvKey: forwardKey};
}

/**
 * Seal a string for the peer.
 *
 * @param {string} plaintext
 * @param {Uint8Array} sendKey
 * @returns {{v: number, iv: string, ct: string}} safe to JSON.stringify onto the wire
 */
export function encryptMessage(plaintext, sendKey) {
  if (!sendKey) throw new Error('no session key: refusing to send unencrypted');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = gcm(sendKey, iv).encrypt(encoder.encode(String(plaintext)));
  return {v: WIRE_VERSION, iv: toHex(iv), ct: toHex(ciphertext)};
}

/**
 * Open a sealed envelope from the peer. Throws on any failure.
 *
 * @param {{v: number, iv: string, ct: string}} envelope
 * @param {Uint8Array} recvKey
 * @returns {string}
 */
export function decryptMessage(envelope, recvKey) {
  if (!recvKey) throw new Error('no session key for this peer');
  if (!envelope || typeof envelope !== 'object') throw new Error('not an encrypted envelope');
  if (envelope.v !== WIRE_VERSION) throw new Error(`unsupported envelope version ${envelope.v}`);
  const plaintext = gcm(recvKey, fromHex(envelope.iv)).decrypt(fromHex(envelope.ct));
  return new TextDecoder().decode(plaintext);
}

/**
 * Is this one of our sealed envelopes, of any version? Shape-based, so every
 * envelope stays on the encrypted path; decryptMessage() decides readability.
 */
export function isEncryptedEnvelope(value) {
  return !!value && typeof value === 'object' &&
    typeof value.v === 'number' &&
    typeof value.iv === 'string' && typeof value.ct === 'string';
}

export const WIRE = {VERSION: WIRE_VERSION, IV_BYTES, KDF: 'HKDF-SHA256'};
