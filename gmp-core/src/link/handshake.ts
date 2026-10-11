/**
 * GMP handshake messages, both Ed25519-signed over every preceding field:
 *
 *   HELLO (265 bytes, initiator -> responder)
 *     0      version (0x01)
 *     1-64   NodeID
 *     65-96  static X25519 public key
 *     97-128 Ed25519 signing public key
 *     129-160 ephemeral X25519 public key
 *     161-168 timestamp (ms, uint64 BE)
 *     169-200 initiator nonce
 *     201-264 signature over bytes 0..200
 *
 *   HELLO_ACK (280 bytes, responder -> initiator)
 *     0-63   NodeID
 *     64-95  static X25519 public key
 *     96-127 Ed25519 signing public key
 *     128-159 ephemeral X25519 public key
 *     160-167 timestamp (ms, uint64 BE)
 *     168-215 proof: the initiator nonce sealed under the responder's send key
 *     216-279 signature over bytes 0..215
 *
 * Layouts and stateless checks only; the sequence is driven by GMPLink.
 */

import { sha512, signMessage, verifySignature } from '../identity.js';
import { bufferEquals } from './session.js';

/**
 * The version byte. Nothing about relay hops is signalled in cleartext; any
 * other value is refused.
 */
export const PROTOCOL_VERSION = 0x01;

export const HELLO_PAYLOAD_LEN = 265;
export const HELLO_SIGNED_LEN = 201;
export const HELLO_ACK_PAYLOAD_LEN = 280;
export const HELLO_ACK_SIGNED_LEN = 216;

/** Used when a link has no node to supply its configured window. */
export const DEFAULT_TIMESTAMP_WINDOW_MS = 120000;
/** A handshake this far off is accepted (if in window) but reported as skew. */
export const CLOCK_SKEW_REPORT_MS = 5 * 60 * 1000;
/** How long a responder waits for the initiator's key-confirmation PING. */
export const HANDSHAKE_CONFIRM_TIMEOUT_MS = 10000;

/** The identity fields a handshake message carries about its sender. */
export interface HandshakeSigner {
  nodeId: Uint8Array;
  staticPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  signingPrivKey: Uint8Array;
}

export interface HelloFields {
  version: number;
  nodeId: Buffer;
  staticPubkey: Buffer;
  signingPubkey: Buffer;
  ephemeralPubkey: Buffer;
  timestamp: number;
  nonce: Buffer;
  signature: Buffer;
  /** Bytes the signature covers. */
  signedPortion: Buffer;
}

export interface HelloAckFields {
  nodeId: Buffer;
  staticPubkey: Buffer;
  signingPubkey: Buffer;
  ephemeralPubkey: Buffer;
  timestamp: number;
  /** 48 bytes: 16-byte tag + 32-byte ciphertext. */
  encryptedProof: Buffer;
  signature: Buffer;
  signedPortion: Buffer;
}

export function buildHello(
  identity: HandshakeSigner,
  ephemeralPub: Uint8Array,
  timestamp: number,
  initiatorNonce: Uint8Array
): Buffer {
  const signedPayload = Buffer.alloc(HELLO_SIGNED_LEN);
  signedPayload[0] = PROTOCOL_VERSION;                                   // 0: version
  signedPayload.set(Buffer.from(identity.nodeId), 1);                    // 1-64: nodeId
  signedPayload.set(Buffer.from(identity.staticPubKey), 65);             // 65-96: staticPubkey
  signedPayload.set(Buffer.from(identity.signingPubKey), 97);            // 97-128: signingPubkey
  signedPayload.set(Buffer.from(ephemeralPub), 129);                     // 129-160: ephemeralPubkey
  signedPayload.writeBigUInt64BE(BigInt(timestamp), 161);                // 161-168: timestamp
  signedPayload.set(initiatorNonce, 169);                                // 169-200: nonce

  const signature = signMessage(
    new Uint8Array(identity.signingPrivKey),
    new Uint8Array(signedPayload)
  );

  const payload = Buffer.alloc(HELLO_PAYLOAD_LEN);
  payload.set(signedPayload, 0);
  payload.set(Buffer.from(signature), HELLO_SIGNED_LEN);
  return payload;
}

/** Slice a HELLO into its fields. The caller has checked the length. */
export function parseHello(payload: Buffer): HelloFields {
  return {
    version: payload[0],
    nodeId: payload.slice(1, 65),
    staticPubkey: payload.slice(65, 97),
    signingPubkey: payload.slice(97, 129),
    ephemeralPubkey: payload.slice(129, 161),
    timestamp: Number(payload.readBigUInt64BE(161)),
    nonce: payload.slice(169, 201),
    signature: payload.slice(201, 265),
    signedPortion: payload.slice(0, HELLO_SIGNED_LEN),
  };
}

export function buildHelloAck(
  identity: HandshakeSigner,
  ephemeralPub: Uint8Array,
  timestamp: number,
  encryptedProof: Uint8Array
): Buffer {
  const signedPayload = Buffer.alloc(HELLO_ACK_SIGNED_LEN);
  signedPayload.set(Buffer.from(identity.nodeId), 0);
  signedPayload.set(Buffer.from(identity.staticPubKey), 64);
  signedPayload.set(Buffer.from(identity.signingPubKey), 96);
  signedPayload.set(Buffer.from(ephemeralPub), 128);
  signedPayload.writeBigUInt64BE(BigInt(timestamp), 160);
  signedPayload.set(encryptedProof, 168);

  const signature = signMessage(
    new Uint8Array(identity.signingPrivKey),
    new Uint8Array(signedPayload)
  );

  const payload = Buffer.alloc(HELLO_ACK_PAYLOAD_LEN);
  payload.set(signedPayload, 0);
  payload.set(Buffer.from(signature), HELLO_ACK_SIGNED_LEN);
  return payload;
}

/** Slice a HELLO_ACK into its fields. The caller has checked the length. */
export function parseHelloAck(payload: Buffer): HelloAckFields {
  return {
    nodeId: payload.slice(0, 64),
    staticPubkey: payload.slice(64, 96),
    signingPubkey: payload.slice(96, 128),
    ephemeralPubkey: payload.slice(128, 160),
    timestamp: Number(payload.readBigUInt64BE(160)),
    encryptedProof: payload.slice(168, 216),
    signature: payload.slice(216, 280),
    signedPortion: payload.slice(0, HELLO_ACK_SIGNED_LEN),
  };
}

/**
 * NodeID = SHA-512(staticPubkey), or SHA-512(signingPubkey) after key
 * rotation. Timing-safe. Does not prove key possession; the static<->static
 * term in the session key does.
 */
export function nodeIdMatchesKeys(
  nodeId: Uint8Array,
  staticPubkey: Uint8Array,
  signingPubkey: Uint8Array
): boolean {
  return bufferEquals(sha512(staticPubkey), nodeId) || bufferEquals(sha512(signingPubkey), nodeId);
}

/** Absolute distance between the peer's timestamp and our clock. */
export function timestampDelta(now: number, timestamp: number): number {
  return Math.abs(now - timestamp);
}

export function verifyHandshakeSignature(
  signingPubkey: Uint8Array,
  signedPortion: Uint8Array,
  signature: Uint8Array
): boolean {
  return verifySignature(signingPubkey, new Uint8Array(signedPortion), new Uint8Array(signature));
}
