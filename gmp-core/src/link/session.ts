/**
 * GMP session cryptography:
 *
 *   X25519 (ephemeral<->ephemeral  ||  static<->static)
 *     -> deriveSessionKeys (identity.ts)
 *     -> directional send/recv keys
 *     -> AES-256-GCM with a 64-bit per-direction counter as the nonce
 *
 * Sealed payload: [16-byte auth tag][ciphertext]; IV = 4 zero bytes + counter
 * (BE); the 5-byte frame header is the AAD. Counters are owned by the link.
 */

import crypto from 'crypto';
import {
  x25519DeriveSharedSecret,
  deriveSessionKeys,
  concatBytes,
} from '../identity.js';
import { frameHeader } from './frame.js';

export const AUTH_TAG_LEN = 16;
/** Session-key set capacity; not a security parameter. */
export const SESSION_KEY_LRU_SIZE = 4096;

// Build a 12-byte AES-GCM IV from a 64-bit counter value
// IV structure: 4 bytes zero + 8 bytes counter (big-endian)
export function buildGCMIV(counter: number): Buffer {
  const iv = Buffer.alloc(12, 0);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

export function encryptAESGCM(
  key: Uint8Array,
  nonceCounter: number,
  plaintext: Uint8Array,
  aad: Uint8Array | null
): Buffer {
  const iv = buildGCMIV(nonceCounter);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([authTag, encrypted]);
}

export function decryptAESGCM(
  key: Uint8Array,
  nonceCounter: number,
  ciphertext: Buffer,
  aad: Uint8Array | null
): Buffer {
  const iv = buildGCMIV(nonceCounter);
  const authTag = ciphertext.slice(0, AUTH_TAG_LEN);
  const encrypted = ciphertext.slice(AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** Encrypt a frame payload with its frame header as AAD. */
export function sealFramePayload(
  key: Uint8Array,
  nonceCounter: number,
  type: number,
  plaintext: Uint8Array
): Buffer {
  return encryptAESGCM(key, nonceCounter, plaintext, frameHeader(plaintext.length, type));
}

/**
 * Decrypt a frame payload sealed by sealFramePayload. Throws on any
 * authentication failure, including a payload shorter than the auth tag.
 */
export function openFramePayload(
  key: Uint8Array,
  nonceCounter: number,
  type: number,
  sealed: Buffer
): Buffer {
  return decryptAESGCM(key, nonceCounter, sealed, frameHeader(sealed.length - AUTH_TAG_LEN, type));
}

export interface LinkKeyInput {
  isInitiator: boolean;
  localEphemeralPriv: Uint8Array;
  remoteEphemeralPub: Uint8Array;
  localStaticPriv: Uint8Array;
  remoteStaticPub: Uint8Array;
  localNodeId: Uint8Array;
  remoteNodeId: Uint8Array;
}

export interface LinkKeys {
  sendKey: Buffer;
  recvKey: Buffer;
}

/**
 * Derive this side's send/recv keys from ephemeral<->ephemeral (forward
 * secrecy) and static<->static (identity) X25519 exchanges, so only the holder
 * of the static private key behind a NodeID reaches the session key. Keys bind
 * to (initiatorNodeId, responderNodeId). Throws on a malformed or low-order
 * peer key.
 */
export function deriveLinkKeys(input: LinkKeyInput): LinkKeys {
  const ssEphemeral = x25519DeriveSharedSecret(
    new Uint8Array(input.localEphemeralPriv),
    new Uint8Array(input.remoteEphemeralPub)
  );
  const ssStatic = x25519DeriveSharedSecret(
    new Uint8Array(input.localStaticPriv),
    new Uint8Array(input.remoteStaticPub)
  );
  const initiatorNodeId = input.isInitiator ? input.localNodeId : input.remoteNodeId;
  const responderNodeId = input.isInitiator ? input.remoteNodeId : input.localNodeId;
  const { initiatorKey, responderKey } = deriveSessionKeys(
    concatBytes(ssEphemeral, ssStatic),
    new Uint8Array(initiatorNodeId),
    new Uint8Array(responderNodeId)
  );
  return input.isInitiator
    ? { sendKey: Buffer.from(initiatorKey), recvKey: Buffer.from(responderKey) }
    : { sendKey: Buffer.from(responderKey), recvKey: Buffer.from(initiatorKey) };
}

// Compare two buffers for equality (timing-safe)
export function bufferEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Compute a fingerprint of a session key for LRU tracking
export function fingerprintKey(sessionKey: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(sessionKey)).digest('hex').slice(0, 32);
}

/**
 * In-process session-key dedupe; defence-in-depth, not the replay guard
 * (entries precede key confirmation and evict oldest-first). The guard is
 * ephemeral non-repetition (link/ephemeral-source.ts).
 */
export class SessionKeyLRUSet {
  private _maxSize: number;
  private _map = new Map<string, boolean>();
  private _order: string[] = [];

  constructor(maxSize: number = SESSION_KEY_LRU_SIZE) {
    this._maxSize = maxSize;
  }

  _touch(key: string): void {
    const idx = this._order.indexOf(key);
    if (idx !== -1) {
      this._order.splice(idx, 1);
    }
    this._order.push(key);
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  add(key: string): boolean {
    if (this._map.has(key)) {
      this._touch(key);
      return false;
    }

    if (this._order.length >= this._maxSize) {
      const oldest = this._order.shift();
      this._map.delete(oldest);
    }

    this._map.set(key, true);
    this._order.push(key);
    return true;
  }

  clear(): void {
    this._map.clear();
    this._order = [];
  }

  size(): number {
    return this._order.length;
  }
}
