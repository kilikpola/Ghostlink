/**
 * End-to-end sealing of a relayed circuit, so the relay cannot read the
 * cleartext HELLO / HELLO_ACK (NodeIDs and keys) of the GMP handshake inside:
 *
 *   dialer:  e = fresh X25519 keypair; first circuit frame = e.pub (32 bytes)
 *   both:    ikm  = X25519(e.priv, callee.staticPub) = X25519(callee.staticPriv, e.pub)
 *            keys = HKDF-SHA256(ikm, salt = e.pub || callee.staticPub,
 *                               info = "gmp-relay-circuit-v1", 64 bytes)
 *            dialer->callee key = keys[0..32], callee->dialer key = keys[32..64]
 *   records: AES-256-GCM, IV = 4 zero bytes || 64-bit counter (per direction),
 *            wire = [16-byte tag][ciphertext]
 *
 * Authentication and forward secrecy remain the inner GMP handshake's.
 */

import crypto from 'crypto';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { decodeRelayData } from './relay-protocol.js';

export const CIRCUIT_HELLO_LEN = 32;
const TAG_LEN = 16;

// ── Record padding ──────────────────────
//
// Every sealed record's plaintext is exactly one bucket long:
//
//   [kind 1B][length u16 BE][payload][zero padding to the bucket]
//
// Traffic class is fixed by the dialer's first sealed (CLASS) record:
//
//   interactive  buckets 256 / 1024 / 4096 — the smallest that fits
//   bulk         every record 16384; the final one padded
//
// No cover traffic or timing jitter. See docs/relay-metadata.md.

export type TrafficClass = 'interactive' | 'bulk';
export const INTERACTIVE_BUCKETS = [256, 1024, 4096] as const;
export const BULK_RECORD = 16384;
const RECORD_HEADER = 3;
export const RECORD_KIND_DATA = 0;
export const RECORD_KIND_CLASS = 1;
const CLASS_IDS: Record<TrafficClass, number> = { interactive: 1, bulk: 2 };

/** Largest payload one record of this class carries. */
export function maxRecordPayload(cls: TrafficClass): number {
  return (cls === 'bulk' ? BULK_RECORD : INTERACTIVE_BUCKETS[INTERACTIVE_BUCKETS.length - 1]) - RECORD_HEADER;
}

/** Frame a payload into one padded record plaintext of its class's bucket size. */
export function padRecord(kind: number, payload: Uint8Array, cls: TrafficClass): Buffer {
  if (payload.length > maxRecordPayload(cls)) throw new Error('record payload too large for its class');
  const need = RECORD_HEADER + payload.length;
  const size = cls === 'bulk' ? BULK_RECORD : INTERACTIVE_BUCKETS.find((b) => b >= need);
  const out = Buffer.alloc(size, 0);
  out[0] = kind;
  out.writeUInt16BE(payload.length, 1);
  out.set(payload, RECORD_HEADER);
  return out;
}

/** Inverse of padRecord. Throws on a length that does not fit. */
export function unpadRecord(plaintext: Buffer): { kind: number; payload: Buffer } {
  if (plaintext.length < RECORD_HEADER) throw new Error('short record');
  const len = plaintext.readUInt16BE(1);
  if (RECORD_HEADER + len > plaintext.length) throw new Error('record length exceeds record');
  return { kind: plaintext[0], payload: plaintext.subarray(RECORD_HEADER, RECORD_HEADER + len) };
}

export function classRecord(cls: TrafficClass): Buffer {
  return padRecord(RECORD_KIND_CLASS, Buffer.from([CLASS_IDS[cls]]), cls);
}

export function classFromId(id: number): TrafficClass | null {
  return id === CLASS_IDS.interactive ? 'interactive' : id === CLASS_IDS.bulk ? 'bulk' : null;
}
const INFO = new TextEncoder().encode('gmp-relay-circuit-v1');

function deriveKeys(ikm: Uint8Array, ephPub: Uint8Array, calleeStaticPub: Uint8Array): { d2c: Buffer; c2d: Buffer } {
  const salt = new Uint8Array(ephPub.length + calleeStaticPub.length);
  salt.set(ephPub, 0);
  salt.set(calleeStaticPub, ephPub.length);
  const okm = hkdf(sha256, ikm, salt, INFO, 64);
  return { d2c: Buffer.from(okm.slice(0, 32)), c2d: Buffer.from(okm.slice(32, 64)) };
}

function iv(counter: number): Buffer {
  const out = Buffer.alloc(12, 0);
  out.writeBigUInt64BE(BigInt(counter), 4);
  return out;
}

export class CircuitCipher {
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private sendCounter = 0;
  private recvCounter = 0;

  private constructor(sendKey: Buffer, recvKey: Buffer) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
  }

  /** Dialer side: returns the cipher and the 32-byte circuit hello to send first. */
  static forDialer(calleeStaticPub: Uint8Array): { cipher: CircuitCipher; hello: Buffer } {
    const ephPriv = crypto.getRandomValues(new Uint8Array(32));
    const ephPub = x25519.getPublicKey(ephPriv);
    const ikm = x25519.getSharedSecret(ephPriv, new Uint8Array(calleeStaticPub));
    const { d2c, c2d } = deriveKeys(ikm, ephPub, calleeStaticPub);
    return { cipher: new CircuitCipher(d2c, c2d), hello: Buffer.from(ephPub) };
  }

  /** Callee side, from the dialer's circuit hello. Throws on a malformed or low-order key. */
  static forCallee(ownStaticPriv: Uint8Array, ownStaticPub: Uint8Array, hello: Uint8Array): CircuitCipher {
    if (hello.length !== CIRCUIT_HELLO_LEN) throw new Error('bad circuit hello');
    const ikm = x25519.getSharedSecret(new Uint8Array(ownStaticPriv), new Uint8Array(hello));
    const { d2c, c2d } = deriveKeys(ikm, hello, ownStaticPub);
    return new CircuitCipher(c2d, d2c);
  }

  seal(plaintext: Uint8Array): Buffer {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, iv(this.sendCounter++));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([cipher.getAuthTag(), body]);
  }

  /** Throws on any tampering, reordering, replay or wrong key; the counter only advances on success. */
  open(record: Uint8Array): Buffer {
    if (record.length < TAG_LEN) throw new Error('short circuit record');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, iv(this.recvCounter));
    decipher.setAuthTag(Buffer.from(record.subarray(0, TAG_LEN)));
    const out = Buffer.concat([decipher.update(record.subarray(TAG_LEN)), decipher.final()]);
    this.recvCounter++;
    return out;
  }
}

/**
 * Test helper: try to open the first record of any circuit with the given
 * X25519 private keys. Returns the plaintext, or null.
 */
export function openFirstRecordForTest(payloads: Buffer[], privKeys: Uint8Array[]): Buffer | null {
  const frames = payloads.map((p) => decodeRelayData(p)).filter((f) => f !== null);
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].data.length !== CIRCUIT_HELLO_LEN) continue;
    const next = frames.slice(i + 1).find((f) => f.circuitId === frames[i].circuitId);
    if (!next) continue;
    for (const priv of privKeys) {
      try {
        const pub = x25519.getPublicKey(new Uint8Array(priv));
        return CircuitCipher.forCallee(priv, pub, frames[i].data).open(next.data);
      } catch {
        // not this key
      }
    }
  }
  return null;
}
