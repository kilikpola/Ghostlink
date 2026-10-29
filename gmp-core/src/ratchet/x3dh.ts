/**
 * X3DH-lite: the root secret of a new ratchet session (identity-v2.md §4.2,
 * D1, D2, D8, Q3; task R6). One path for online and offline first contact:
 * the GMP link handshake exports nothing (D2).
 *
 *   EK_a = fresh X25519 (the initiator's; its public half travels in the
 *          kind 0x02 header, so it also names the session)
 *   DH1  = DH(S_a, S_b)     static–static: authenticates A to B
 *   DH2  = DH(EK_a, S_b)    ephemeral–static: freshness
 *   IKM  = 0xFF×32 ‖ DH1 ‖ DH2          (X3DH's F prefix; a TRUE concatenated IKM, D1)
 *   SK   = HKDF-SHA256(IKM, salt = 0×32, info = "gl-x3dh-v1" ‖ NodeID_a ‖ NodeID_b ‖ EK_a, 32)
 *
 * The recipient's static key plays identity key AND signed prekey; it needs no
 * signature because the NodeID is SHA-512 of it (checked here: a static key
 * that does not hash to the claimed NodeID is refused before any DH).
 *
 * Stated plainly (Q3): the initial messages have NO forward secrecy against
 * the recipient's static key. Whoever later obtains S_b and kept them can
 * compute SK and read them. Every message after the recipient's first reply
 * has full ratchet forward secrecy. Key-compromise impersonation: whoever
 * holds S_b can impersonate anyone TO B. Same as X3DH without one-time prekeys.
 *
 * Pure: no I/O, no clock; randomness from the injected rng.
 */
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

export const X3DH_LABEL = 'gl-x3dh-v1';
/** D8: initial messages older than TTL + 1 day are rejected before any DH. */
export const MAX_INITIAL_AGE_MS = 8 * 24 * 60 * 60 * 1000;
/** D8 / §4.4: or more than 5 minutes in the future. */
export const MAX_INITIAL_SKEW_MS = 5 * 60 * 1000;

const F = new Uint8Array(32).fill(0xff);
const ZERO32 = new Uint8Array(32);
const enc = new TextEncoder();
const NODE_ID_HEX = /^[0-9a-f]{128}$/;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface X3dhObserve { onRootKey?(role: 'initiator' | 'responder', skHex: string): void }

/** The NodeID a static X25519 public key self-certifies (SHA-512, hex). */
export const nodeIdOfStatic = (staticPub: Uint8Array): string => hex(sha512(staticPub));

function rootKey(dh1: Uint8Array, dh2: Uint8Array, initiatorNodeId: string, responderNodeId: string, ekPub: Uint8Array): Uint8Array {
  const info = concat(enc.encode(X3DH_LABEL), unhex(initiatorNodeId), unhex(responderNodeId), ekPub);
  return hkdf(sha256, concat(F, dh1, dh2), ZERO32, info, 32);
}
function checkParties(selfNodeId: string, peerNodeId: string, peerStaticPub: Uint8Array): void {
  if (!NODE_ID_HEX.test(selfNodeId) || !NODE_ID_HEX.test(peerNodeId) || selfNodeId === peerNodeId) throw new Error('x3dh: two different 128-hex NodeIDs');
  if (!(peerStaticPub instanceof Uint8Array) || peerStaticPub.length !== 32) throw new Error('x3dh: the peer static key is 32 bytes');
}

/** Does this static key belong to this NodeID? */
export function staticMatchesNodeId(staticPub: Uint8Array, nodeId: string): boolean {
  return staticPub instanceof Uint8Array && staticPub.length === 32 && nodeIdOfStatic(staticPub) === nodeId;
}

/**
 * Initiator (A). → { rootKey: SK, ekPub }. EK's private half is used here and
 * dropped: nothing derived later needs it.
 */
export function x3dhInitiate(
  o: { selfStaticPriv: Uint8Array; selfNodeId: string; peerStaticPub: Uint8Array; peerNodeId: string },
  deps: { rng(n: number): Uint8Array }, observe?: X3dhObserve,
): { rootKey: Uint8Array; ekPub: Uint8Array } {
  checkParties(o.selfNodeId, o.peerNodeId, o.peerStaticPub);
  const ekPriv = deps.rng(32);
  if (!(ekPriv instanceof Uint8Array) || ekPriv.length !== 32) throw new Error('x3dh: rng must return 32 bytes');
  const ekPub = x25519.getPublicKey(ekPriv);
  const sk = rootKey(x25519.getSharedSecret(o.selfStaticPriv, o.peerStaticPub), x25519.getSharedSecret(ekPriv, o.peerStaticPub), o.selfNodeId, o.peerNodeId, ekPub);
  observe?.onRootKey?.('initiator', hex(sk));
  return { rootKey: sk, ekPub };
}

/** Responder (B), from the EK_a in a kind 0x02 header. Throws on an unusable key (e.g. low order). */
export function x3dhRespond(
  o: { selfStaticPriv: Uint8Array; selfNodeId: string; peerStaticPub: Uint8Array; peerNodeId: string; ekPub: Uint8Array },
  observe?: X3dhObserve,
): Uint8Array {
  checkParties(o.selfNodeId, o.peerNodeId, o.peerStaticPub);
  if (!(o.ekPub instanceof Uint8Array) || o.ekPub.length !== 32) throw new Error('x3dh: EK_a is 32 bytes');
  const sk = rootKey(x25519.getSharedSecret(o.selfStaticPriv, o.peerStaticPub), x25519.getSharedSecret(o.selfStaticPriv, o.ekPub), o.peerNodeId, o.selfNodeId, o.ekPub);
  observe?.onRootKey?.('responder', hex(sk));
  return sk;
}

/** D8 bound on an initial message's sentAt, checked before any DH. */
export function initialAgeProblem(sentAt: number, now: number): 'initial-too-old' | 'initial-from-future' | null {
  if (now - sentAt > MAX_INITIAL_AGE_MS) return 'initial-too-old';
  if (sentAt - now > MAX_INITIAL_SKEW_MS) return 'initial-from-future';
  return null;
}
