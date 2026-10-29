/**
 * Double Ratchet core (identity-v2.md §3.1, §4.3, §4.4, §5; task R4).
 *
 * Written from Signal's public-domain Double Ratchet specification, not from
 * libsignal code. Pure: no I/O, no timers, no globals. Randomness and the clock
 * are injected (`deps`), the state is a plain JSON-serialisable value, and
 * every operation returns a NEW state; the input is never mutated. A failed
 * decryption returns `{ ok: false }` and no state, so the caller's state stays
 * exactly as it was (the classic ratchet bug is advancing it anyway).
 *
 *   KDF_RK(rk, dh) = HKDF-SHA256(IKM = dh, salt = rk, info = "gl-ratchet-rk-v1", 64) -> (rk', ck)
 *   KDF_CK(ck)     = mk = HMAC-SHA256(ck, 0x01);  ck' = HMAC-SHA256(ck, 0x02)
 *   message key    = HKDF-SHA256(mk, salt = 0x00*32, info = "gl-ratchet-mk-v1", 44)
 *                    -> AES-256-GCM-SIV key (32) ‖ nonce (12)   (RFC 8452; R4b)
 *   AD             = "gl-ratchet-ad-v1" ‖ header ‖ sender NodeID ‖ recipient NodeID
 *
 * Wire (§3.1): version 0x01 ‖ kind ‖ messageId(16) [‖ EK_s(32) ‖ sentAt(8), kind
 * 0x02] ‖ DHr(32) ‖ PN(4) ‖ N(4) ‖ ciphertext ‖ tag(16). The plaintext is
 * whatever the caller passes; padding is R7. Kind 0x02 (an initial message,
 * R6) is the same ratchet message with EK_s and sentAt in the header, so both
 * sit inside the AD: `encrypt(..., { initial })` produces one, and `decrypt`
 * accepts one only with `allowInitial` (the store, after its dedup, sentAt and
 * X3DH-lite checks; x3dh.ts). Plain decrypt still refuses kind 0x02.
 *
 * A replay fails because the message key was deleted when it was first used
 * (same chain: N is behind Nr; earlier chain: the skipped key is gone).
 *
 * One message key, one encryption: `encrypt` derives the key from CKs and
 * returns a state whose CKs is past it. A pure function cannot stop a caller
 * from encrypting twice with the SAME input state, which repeats the key and
 * the derived nonce (test 5 of §7 shows it). The AEAD is therefore
 * AES-256-GCM-SIV, not GCM: under a repeated (key, nonce) GCM repeats its
 * keystream (c1 XOR c2 = p1 XOR p2) and loses tag security, while GCM-SIV only
 * reveals whether two messages had the same header AND plaintext. Never
 * re-using a state, including after a restore, stays the caller's rule (§4.5,
 * task R5); GCM-SIV makes breaking it far less costly.
 *
 * @noble only (curves, hashes, ciphers), so the same file runs in Node,
 * Electron main and React Native.
 */
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { gcmsiv } from '@noble/ciphers/aes';

export const RATCHET_VERSION = 0x01;
export const KIND_RATCHET = 0x01;
export const KIND_INITIAL = 0x02;
/** Per chain step (§4.4). */
export const MAX_SKIP = 1000;
/** Whole skipped-key store per contact; oldest evicted (§4.4). */
export const MAX_SKIPPED_KEYS = 2000;
/** Skipped keys live 8 days: mailbox TTL + 1 day (§4.4). */
export const SKIPPED_TTL_MS = 8 * 24 * 60 * 60 * 1000;
export const LABELS = Object.freeze({
  RK: 'gl-ratchet-rk-v1',
  MK: 'gl-ratchet-mk-v1',
  AD: 'gl-ratchet-ad-v1',
});
export const HEADER_LEN = Object.freeze({ [KIND_RATCHET]: 58, [KIND_INITIAL]: 98 });
export const TAG_LEN = 16;
/** Fixed overhead per message (§3.1): 74 for kind 0x01, 114 for kind 0x02. */
export const OVERHEAD = Object.freeze({ [KIND_RATCHET]: 58 + TAG_LEN, [KIND_INITIAL]: 98 + TAG_LEN });

const NODE_ID_HEX = /^[0-9a-f]{128}$/;
const KEY_HEX = /^[0-9a-f]{64}$/;
const ZERO32 = new Uint8Array(32);
const enc = new TextEncoder();

export interface RatchetDeps {
  /** `n` fresh random bytes. */
  rng(n: number): Uint8Array;
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface SkippedKey { dh: string; n: number; mk: string; at: number }

/** §4.1, plus selfNodeId (the AD needs both NodeIDs). Hex strings throughout. */
export interface RatchetState {
  v: 1;
  selfNodeId: string;
  peerNodeId: string;
  rootKey: string;
  dhSelf: { priv: string; pub: string };
  dhRemote: string | null;
  CKs: string | null;
  CKr: string | null;
  Ns: number;
  Nr: number;
  PN: number;
  skipped: SkippedKey[];
  createdAt: number;
}

export interface Header {
  version: number;
  kind: number;
  messageId: Uint8Array;
  ek?: Uint8Array;
  sentAt?: number;
  dh: Uint8Array;
  pn: number;
  n: number;
}

export type DecryptFailure =
  | 'malformed' | 'truncated' | 'unsupported-version' | 'unsupported-kind'
  | 'too-many-skipped' | 'no-key' | 'auth-failed';

/** Test-only observation of the AES key ‖ nonce each operation used. */
export interface Observe { onMessageKey?(op: 'encrypt' | 'decrypt', keyAndNonceHex: string): void }

// ── bytes ────────────────────────────────────────────────────────────────
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
const u32 = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };
const clone = (s: RatchetState): RatchetState => JSON.parse(JSON.stringify(s));

// ── KDFs (§4.3) ──────────────────────────────────────────────────────────
function kdfRk(rootKey: Uint8Array, dhOut: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const out = hkdf(sha256, dhOut, rootKey, LABELS.RK, 64);
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}
function kdfCk(chainKey: Uint8Array): { chainKey: Uint8Array; mk: Uint8Array } {
  return { mk: hmac(sha256, chainKey, Uint8Array.of(0x01)), chainKey: hmac(sha256, chainKey, Uint8Array.of(0x02)) };
}
function messageKey(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array; both: Uint8Array } {
  const both = hkdf(sha256, mk, ZERO32, LABELS.MK, 44);
  return { key: both.slice(0, 32), nonce: both.slice(32, 44), both };
}

// ── header (§3.1) ────────────────────────────────────────────────────────
export function encodeHeader(h: Header): Uint8Array {
  if (h.version !== RATCHET_VERSION) throw new Error('ratchet header: unknown version');
  if (h.messageId.length !== 16 || h.dh.length !== 32) throw new Error('ratchet header: bad field length');
  if (!Number.isInteger(h.pn) || h.pn < 0 || h.pn > 0xffffffff || !Number.isInteger(h.n) || h.n < 0 || h.n > 0xffffffff) {
    throw new Error('ratchet header: PN and N are u32');
  }
  const parts: Uint8Array[] = [Uint8Array.of(h.version, h.kind), h.messageId];
  if (h.kind === KIND_INITIAL) {
    if (!h.ek || h.ek.length !== 32 || !Number.isSafeInteger(h.sentAt) || (h.sentAt as number) < 0) {
      throw new Error('ratchet header: an initial message needs EK_s and sentAt');
    }
    const t = new Uint8Array(8);
    new DataView(t.buffer).setBigUint64(0, BigInt(h.sentAt as number));
    parts.push(h.ek, t);
  } else if (h.kind !== KIND_RATCHET) {
    throw new Error('ratchet header: unknown kind');
  }
  parts.push(h.dh, u32(h.pn), u32(h.n));
  return concat(...parts);
}

/** → { header, headerBytes, body } or a failure reason. Never throws. */
export function decodeMessage(msg: Uint8Array): { header: Header; headerBytes: Uint8Array; body: Uint8Array } | DecryptFailure {
  if (!(msg instanceof Uint8Array) || msg.length < 2) return 'malformed';
  if (msg[0] !== RATCHET_VERSION) return 'unsupported-version';
  const kind = msg[1];
  const hlen = HEADER_LEN[kind as 1 | 2];
  if (!hlen) return 'unsupported-kind';
  if (msg.length < hlen + TAG_LEN) return 'truncated';
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let o = 18;
  const header: Header = { version: msg[0], kind, messageId: msg.slice(2, 18), dh: new Uint8Array(0), pn: 0, n: 0 };
  if (kind === KIND_INITIAL) {
    header.ek = msg.slice(18, 50);
    header.sentAt = Number(dv.getBigUint64(50));
    o = 58;
  }
  header.dh = msg.slice(o, o + 32);
  header.pn = dv.getUint32(o + 32);
  header.n = dv.getUint32(o + 36);
  return { header, headerBytes: msg.slice(0, hlen), body: msg.slice(hlen) };
}

function associatedData(headerBytes: Uint8Array, senderNodeId: string, recipientNodeId: string): Uint8Array {
  return concat(enc.encode(LABELS.AD), headerBytes, unhex(senderNodeId), unhex(recipientNodeId));
}

// ── state ────────────────────────────────────────────────────────────────
function checkIds(selfNodeId: string, peerNodeId: string): void {
  if (!NODE_ID_HEX.test(selfNodeId) || !NODE_ID_HEX.test(peerNodeId)) throw new Error('ratchet: NodeIDs are 128 lower-case hex');
  if (selfNodeId === peerNodeId) throw new Error('ratchet: a session needs two different NodeIDs');
}
function keyPair(deps: RatchetDeps): { priv: string; pub: string } {
  const priv = deps.rng(32);
  if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error('ratchet: rng must return 32 bytes');
  return { priv: hex(priv), pub: hex(x25519.getPublicKey(priv)) };
}
const dh = (priv: string, pub: string): Uint8Array => x25519.getSharedSecret(unhex(priv), unhex(pub));

function emptyState(selfNodeId: string, peerNodeId: string, rootKey: Uint8Array, deps: RatchetDeps): RatchetState {
  checkIds(selfNodeId, peerNodeId);
  if (!(rootKey instanceof Uint8Array) || rootKey.length !== 32) throw new Error('ratchet: the root secret is 32 bytes');
  return {
    v: 1, selfNodeId, peerNodeId, rootKey: hex(rootKey), dhSelf: { priv: '', pub: '' }, dhRemote: null,
    CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: [], createdAt: deps.now(),
  };
}

/**
 * The side that sends first (Signal's RatchetInitAlice): an agreed root secret
 * and the peer's ratchet public key (for X3DH-lite, the peer's static key; R6).
 */
export function initSender(
  o: { rootKey: Uint8Array; remoteDhPub: Uint8Array; selfNodeId: string; peerNodeId: string }, deps: RatchetDeps,
): RatchetState {
  const s = emptyState(o.selfNodeId, o.peerNodeId, o.rootKey, deps);
  if (!(o.remoteDhPub instanceof Uint8Array) || o.remoteDhPub.length !== 32) throw new Error('ratchet: the remote ratchet key is 32 bytes');
  s.dhSelf = keyPair(deps);
  s.dhRemote = hex(o.remoteDhPub);
  const r = kdfRk(o.rootKey, dh(s.dhSelf.priv, s.dhRemote));
  s.rootKey = hex(r.rootKey);
  s.CKs = hex(r.chainKey);
  return s;
}

/**
 * The side that receives first (Signal's RatchetInitBob): the same root secret
 * and the key pair whose public half the sender was given as `remoteDhPub`. It
 * cannot send until it has received.
 */
export function initReceiver(
  o: { rootKey: Uint8Array; selfDh: { priv: Uint8Array; pub: Uint8Array }; selfNodeId: string; peerNodeId: string }, deps: RatchetDeps,
): RatchetState {
  const s = emptyState(o.selfNodeId, o.peerNodeId, o.rootKey, deps);
  if (o.selfDh.priv.length !== 32 || hex(x25519.getPublicKey(o.selfDh.priv)) !== hex(o.selfDh.pub)) {
    throw new Error('ratchet: the receiver key pair does not match');
  }
  s.dhSelf = { priv: hex(o.selfDh.priv), pub: hex(o.selfDh.pub) };
  return s;
}

const pruneSkipped = (s: RatchetState, now: number): void => {
  s.skipped = s.skipped.filter((k) => now - k.at < SKIPPED_TTL_MS);
};

// ── encrypt ──────────────────────────────────────────────────────────────
export function encrypt(
  state: RatchetState, plaintext: Uint8Array, deps: RatchetDeps,
  opts: { observe?: Observe; initial?: { ek: Uint8Array; sentAt: number } } = {},
): { state: RatchetState; message: Uint8Array; messageId: string } {
  if (!state.CKs) throw new Error('ratchet: no sending chain yet (the receiving side sends after its first message arrives)');
  if (!(plaintext instanceof Uint8Array)) throw new Error('ratchet: plaintext is bytes');
  if (state.Ns >= 0xffffffff) throw new Error('ratchet: sending chain exhausted');
  const s = clone(state);
  const step = kdfCk(unhex(state.CKs));
  const messageId = deps.rng(16);
  if (!(messageId instanceof Uint8Array) || messageId.length !== 16) throw new Error('ratchet: rng must return 16 bytes');
  const header: Header = {
    version: RATCHET_VERSION, kind: opts.initial ? KIND_INITIAL : KIND_RATCHET, messageId,
    ek: opts.initial?.ek, sentAt: opts.initial?.sentAt, dh: unhex(s.dhSelf.pub), pn: s.PN, n: s.Ns,
  };
  const headerBytes = encodeHeader(header);
  const mk = messageKey(step.mk);
  opts.observe?.onMessageKey?.('encrypt', hex(mk.both));
  const sealed = gcmsiv(mk.key, mk.nonce, associatedData(headerBytes, s.selfNodeId, s.peerNodeId)).encrypt(plaintext);
  s.CKs = hex(step.chainKey);
  s.Ns += 1;
  // One message key, one encryption: the returned state is exactly one step
  // past the key just used, so nothing derived from it reaches that key again.
  if (s.Ns !== state.Ns + 1 || s.CKs !== hex(kdfCk(unhex(state.CKs)).chainKey) || s.CKs === state.CKs) {
    throw new Error('ratchet: sending chain did not advance by exactly one step');
  }
  pruneSkipped(s, deps.now());
  return { state: s, message: concat(headerBytes, sealed), messageId: hex(messageId) };
}

// ── decrypt ──────────────────────────────────────────────────────────────
function open(mkRaw: Uint8Array, headerBytes: Uint8Array, body: Uint8Array, s: RatchetState, observe?: Observe): Uint8Array | null {
  const mk = messageKey(mkRaw);
  observe?.onMessageKey?.('decrypt', hex(mk.both));
  try {
    return gcmsiv(mk.key, mk.nonce, associatedData(headerBytes, s.peerNodeId, s.selfNodeId)).decrypt(body);
  } catch {
    return null;
  }
}

/** Derive and store receiving-chain keys up to (not including) `until`. */
function skipTo(s: RatchetState, until: number, now: number): boolean {
  if (until - s.Nr > MAX_SKIP) return false;
  if (!s.CKr) return true;
  let ck = unhex(s.CKr);
  while (s.Nr < until) {
    const step = kdfCk(ck);
    s.skipped.push({ dh: s.dhRemote as string, n: s.Nr, mk: hex(step.mk), at: now });
    ck = step.chainKey;
    s.Nr += 1;
  }
  s.CKr = hex(ck);
  if (s.skipped.length > MAX_SKIPPED_KEYS) s.skipped = s.skipped.slice(s.skipped.length - MAX_SKIPPED_KEYS);
  return true;
}

/**
 * → `{ ok: true, state, plaintext, messageId }`, or `{ ok: false, reason }`
 * with NO state: on any failure the caller keeps the state it passed in. All
 * work happens on a private copy that is returned only after the AEAD opens.
 */
export function decrypt(
  state: RatchetState, message: Uint8Array, deps: RatchetDeps, opts: { observe?: Observe; allowInitial?: boolean } = {},
): { ok: true; state: RatchetState; plaintext: Uint8Array; messageId: string } | { ok: false; reason: DecryptFailure } {
  const parsed = decodeMessage(message);
  if (typeof parsed === 'string') return { ok: false, reason: parsed };
  const { header, headerBytes, body } = parsed;
  if (header.kind !== KIND_RATCHET && !(header.kind === KIND_INITIAL && opts.allowInitial)) return { ok: false, reason: 'unsupported-kind' };
  const now = deps.now();
  const id = hex(header.messageId);
  const dhHex = hex(header.dh);

  // A key skipped earlier.
  const si = state.skipped.findIndex((k) => k.dh === dhHex && k.n === header.n && now - k.at < SKIPPED_TTL_MS);
  if (si >= 0) {
    const s = clone(state);
    const plaintext = open(unhex(s.skipped[si].mk), headerBytes, body, s, opts.observe);
    if (!plaintext) return { ok: false, reason: 'auth-failed' };
    s.skipped.splice(si, 1);                    // used: deleted
    pruneSkipped(s, now);
    return { ok: true, state: s, plaintext, messageId: id };
  }

  const s = clone(state);
  if (dhHex !== s.dhRemote) {
    // A new ratchet key from the peer: close the old receiving chain, then step.
    if (!skipTo(s, header.pn, now)) return { ok: false, reason: 'too-many-skipped' };
    s.PN = s.Ns;
    s.Ns = 0;
    s.Nr = 0;
    s.dhRemote = dhHex;
    try {
      const r1 = kdfRk(unhex(s.rootKey), dh(s.dhSelf.priv, dhHex));
      s.rootKey = hex(r1.rootKey);
      s.CKr = hex(r1.chainKey);
      s.dhSelf = keyPair(deps);
      const r2 = kdfRk(unhex(s.rootKey), dh(s.dhSelf.priv, dhHex));
      s.rootKey = hex(r2.rootKey);
      s.CKs = hex(r2.chainKey);
    } catch {
      return { ok: false, reason: 'malformed' };   // not a usable X25519 public key (e.g. low order)
    }
  } else if (header.n < s.Nr) {
    // Current chain, already past this number and no skipped key: used, expired or evicted.
    return { ok: false, reason: 'no-key' };
  }
  if (!skipTo(s, header.n, now)) return { ok: false, reason: 'too-many-skipped' };
  const step = kdfCk(unhex(s.CKr as string));
  const plaintext = open(step.mk, headerBytes, body, s, opts.observe);
  if (!plaintext) return { ok: false, reason: 'auth-failed' };
  s.CKr = hex(step.chainKey);                   // the key just used is not kept
  s.Nr += 1;
  pruneSkipped(s, now);
  return { ok: true, state: s, plaintext, messageId: id };
}

// ── serialisation ────────────────────────────────────────────────────────
export function serializeState(state: RatchetState): string {
  return JSON.stringify(state);
}

export function deserializeState(text: string): RatchetState {
  const s = JSON.parse(text) as RatchetState;
  const keyOrNull = (v: unknown) => v === null || (typeof v === 'string' && KEY_HEX.test(v));
  const counter = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
  const ok = !!s && typeof s === 'object' && s.v === 1 && NODE_ID_HEX.test(s.selfNodeId) && NODE_ID_HEX.test(s.peerNodeId) &&
    s.selfNodeId !== s.peerNodeId && KEY_HEX.test(s.rootKey) && !!s.dhSelf && KEY_HEX.test(s.dhSelf.priv) &&
    KEY_HEX.test(s.dhSelf.pub) && hex(x25519.getPublicKey(unhex(s.dhSelf.priv))) === s.dhSelf.pub &&
    keyOrNull(s.dhRemote) && keyOrNull(s.CKs) && keyOrNull(s.CKr) && counter(s.Ns) && counter(s.Nr) && counter(s.PN) &&
    Array.isArray(s.skipped) && s.skipped.length <= MAX_SKIPPED_KEYS &&
    s.skipped.every((k) => KEY_HEX.test(k.dh) && counter(k.n) && KEY_HEX.test(k.mk) && Number.isFinite(k.at)) &&
    Number.isFinite(s.createdAt);
  if (!ok) throw new Error('ratchet: not a valid serialised state');
  return s;
}
