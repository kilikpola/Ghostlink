/**
 * Sealed ratchet store: write-ahead persistence and rollback detection
 * (identity-v2.md §4.5, D12, Q8; task R5). Nothing outside tests uses it yet;
 * R7 wires it. Built only through createGMPNode's `ratchets` option.
 *
 * At rest. One file per contact, named HMAC(fileKey, 0x01 ‖ peerNodeId) so the
 * directory does not list who the user talks to:
 *
 *   "GLRS" ‖ 0x01 ‖ installId(16) ‖ generation(u64 BE) ‖ nonce(12) ‖ AES-256-GCM(state JSON) ‖ tag(16)
 *   key   = #34 = derivePurposeKey(meshSeed, RATCHET_SEAL); random nonce
 *   AAD   = "gl-ratchet-state-v1" ‖ peerNodeId(64) ‖ installId(16) ‖ generation(u64 BE)
 *
 * plus `store.id` = "GLRM" ‖ 0x01 ‖ installId ‖ HMAC(fileKey, 0x02 ‖ installId),
 * a key check: under a wrong seal key no file name matches, which must read as
 * "cannot open" (refuse, keep every byte), never as "files missing" (rollback,
 * which deletes). fileKey = HKDF-SHA256(#34, info "gl-ratchet-file-v1").
 *
 * The anchor (installId + one generation per contact) lives OUTSIDE these files,
 * in OS secure storage supplied by the entry point (AnchorProvider; Electron
 * main: safeStorage, in R7). Restoring the store's files does not restore it.
 *
 * Write order (doc §4.5: the generation is incremented in secure storage
 * FIRST, like the boot counter):
 *   send:    anchor[peer] = gen+1 → derive key + encrypt → write state(gen+1) → release ciphertext
 *   receive: decrypt (pure; a failure changes nothing) → anchor = gen+1 → write state → release plaintext
 * A crash anywhere after the anchor step leaves the file behind the anchor, so
 * the next start sees a rollback and discards the ratchet: a key derived before
 * the crash is never derived again. A state-file write that fails after the key
 * was derived poisons that contact for the rest of the run, for the same reason.
 * Cost: such a crash resets the session even though nothing was rolled back.
 *
 * On load: file generation ≥ anchor → accept (and raise the anchor); lower, or
 * the anchor names a contact whose file is gone, or a file has no anchor entry,
 * or the installId differs, or files exist with no anchor → ROLLBACK: every
 * ratchet is discarded (never resumed), every contact needs a new handshake,
 * a 'ratchet-rollback' event fires and a CRITICAL line is logged (CRITICAL is
 * the top level, so no GMP_LOG_LEVEL hides it).
 *
 * No anchor available (keyring locked / insecure / missing): memory-only for
 * this run, with an event and a log line; nothing is written, not even the
 * directory. The browser build has no secure storage and is always memory-only
 * (Q8). A file that fails to open is refused and never overwritten; only
 * moveAsideUnreadable() moves it, unchanged.
 *
 * One process owns a store: open() claims `owner.json` under withFileLock and
 * refuses while another live process holds it (a dead owner is taken over);
 * every write re-checks the claim under the file's lock.
 *
 * Residual (same as boot-counter.ts:8-9): restoring a full disk image that
 * includes the keyring rolls the anchor back with the files, and is not detected.
 *
 * R6 — sessions (identity-v2.md §4.2, §4.4, D8, Q2, Q3). A contact's record
 * (file format 0x02) holds its sessions, a messageId dedup set and the
 * messages sent but not yet acknowledged:
 *   - initiate(): X3DH-lite (x3dh.ts) → a session named by EK_a; every message
 *     on it is kind 0x02 until the first reply arrives on it.
 *   - receive(): dedup, then for kind 0x02 the sentAt bound (8 days old /
 *     5 min ahead) and the NodeID↔static-key check, all before any DH. A new
 *     session is created only if its first message authenticates (the
 *     static–static term); nothing is stored for a message that does not.
 *   - Glare (both initiated, neither acknowledged): the session initiated by the
 *     lower NodeID sends (doc §4.2); the other is kept for receiving.
 *   - A valid initial on an ESTABLISHED session means the peer lost its state
 *     (R5 rollback / crash reset): it replaces the session for sending, the old
 *     one is kept for receiving, and 'ratchet-session-replaced' lists every
 *     message sent and never acknowledged, by messageId (the app resends or
 *     marks them failed: R7/R9). A reply arriving on a session this side
 *     initiated makes that session the sending one, which also resolves an
 *     initial that arrives after the tie-break was already settled.
 *   - Q2 residual: whoever holds the phrase holds the static key, so they can
 *     produce a valid initial and force this replacement. The event and log
 *     line are the only signal.
 *   - Q3: initial messages have no forward secrecy against the recipient's
 *     static key (x3dh.ts).
 *   - R6b: a stale initial cannot reset a newer session. Each session keeps
 *     `establishedAt`, the sentAt of the initial that made it (the peer's clock
 *     for a session the peer started; our start time for one we started). An
 *     initial for a NEW session that is not later than the sending session's
 *     establishedAt (minus MAX_INITIAL_SKEW_MS when the reference is our own
 *     clock) never replaces it: it is kept for receiving only and logged at WARN.
 *     This closes the hole where the host withholds an older session's initial
 *     (or a dedup entry is evicted) and releases it inside the 8-day window.
 *     Kept receivable, not refused, so a genuine late message (e.g. glare) is
 *     still delivered once. A replay of the initial of a session still held is
 *     refused anyway: its message key is gone. Residual: a peer whose clock runs
 *     more than 5 minutes behind ours cannot reset a session WE started within
 *     that margin; its messages still arrive (receive-only).
 * Dedup entries and receive-only sessions expire after TTL + 1 day. Every
 * change is written ahead, as above, before anything is released.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import logger from '../logger.js';
import { writeFileAtomicSync, removeFileDurableSync } from '../atomic-file.js';
import { withFileLock } from '../file-lock.js';
import { derivePurposeKey, Purpose } from '../keys.js';
import type { RatchetStoreEvents } from '../events.js';
import {
  encrypt, decrypt, serializeState, deserializeState, initSender, initReceiver, decodeMessage, KIND_INITIAL,
  type RatchetState, type RatchetDeps, type Observe, type DecryptFailure,
} from './ratchet.js';
import { x3dhInitiate, x3dhRespond, initialAgeProblem, staticMatchesNodeId, MAX_INITIAL_AGE_MS, MAX_INITIAL_SKEW_MS, type X3dhObserve } from './x3dh.js';
import { x25519 } from '@noble/curves/ed25519';

export const STORE_LABELS = Object.freeze({ STATE_AAD: 'gl-ratchet-state-v1', FILE: 'gl-ratchet-file-v1' });
const FILE_MAGIC = 'GLRS';
const MARKER_MAGIC = 'GLRM';
const FORMAT = 0x02;                              // 0x02: contact records with sessions (R6)
const HEADER_LEN = 4 + 1 + 16 + 8 + 12;          // 41
const NODE_ID_HEX = /^[0-9a-f]{128}$/;
const enc = new TextEncoder();

// ── errors ───────────────────────────────────────────────────────────────
class NamedError extends Error {
  constructor(name: string, message: string) { super(message); this.name = name; }
}
/** Persisting failed: nothing was released. */
export class RatchetPersistError extends NamedError { constructor(m: string) { super('RatchetPersistError', m); } }
/** Another live process owns this store. */
export class RatchetStoreInUseError extends NamedError { constructor(m: string) { super('RatchetStoreInUseError', m); } }
/** The contact's state file (or the whole store, under a wrong key) cannot be opened; it is left as it is. */
export class RatchetStateUnreadableError extends NamedError { constructor(m: string) { super('RatchetStateUnreadableError', m); } }
/** A key was derived but its state never persisted: this contact is unusable until restart (which discards it). */
export class RatchetSessionPoisonedError extends NamedError { constructor(m: string) { super('RatchetSessionPoisonedError', m); } }
/** No ratchet session for this contact (none stored, or discarded): a new handshake is needed. */
export class RatchetNoSessionError extends NamedError { constructor(m: string) { super('RatchetNoSessionError', m); } }
/** Used after close(). */
export class RatchetStoreClosedError extends NamedError { constructor(m: string) { super('RatchetStoreClosedError', m); } }
/** initiate() while an established session exists (pass { replace: true } to start over deliberately). */
export class RatchetSessionExistsError extends NamedError { constructor(m: string) { super('RatchetSessionExistsError', m); } }
/** A static key that does not hash to the contact's NodeID. */
export class RatchetPeerKeyError extends NamedError { constructor(m: string) { super('RatchetPeerKeyError', m); } }
/** A ratchet node with no store and no explicit memory-only mode (bug family 1). */
export class RatchetStoreRequiredError extends NamedError { constructor(m: string) { super('RatchetStoreRequiredError', m); } }

// ── anchor (OS secure storage, supplied by the entry point) ──────────────
export interface RatchetAnchor { v: 1; installId: string; gens: Record<string, number> }
export type AnchorLoad =
  | { status: 'ok'; anchor: RatchetAnchor }
  | { status: 'absent' }
  | { status: 'locked' | 'insecure' | 'unavailable'; detail?: string };
export interface AnchorProvider {
  load(): AnchorLoad;
  /** Persist durably or throw. */
  save(anchor: RatchetAnchor): void;
}

export type RollbackReason = 'generation-behind' | 'file-missing' | 'orphan-file' | 'install-mismatch' | 'anchor-missing';
export interface StartupReport {
  mode: 'sealed' | 'memory-only';
  memoryOnlyReason?: string;
  rollback?: { reason: RollbackReason; peers: string[] };
  /** Contacts whose file could not be opened (left untouched). */
  unreadable: string[];
  /** The store key check failed: wrong seal key. Nothing readable, nothing written. */
  keyMismatch?: boolean;
}
export type CheckpointPoint =
  | 'send:anchored' | 'send:computed' | 'send:persisted'
  | 'receive:computed' | 'receive:anchored' | 'receive:persisted'
  | 'put:anchored' | 'put:persisted'
  | 'initiate:anchored' | 'initiate:computed' | 'initiate:persisted'
  | 'ack:anchored' | 'ack:persisted';

/** One ratchet session with a contact. `id` = hex EK_a for X3DH-lite sessions. */
export interface StoredSession {
  id: string;
  /** NodeID that sent the initial message (null for put()). */
  initiator: string | null;
  sending: boolean;
  /** Set on a session this side initiated until a reply arrives on it. */
  initPending: { ek: string } | null;
  state: RatchetState;
  createdAt: number;
  lastUsedAt: number;
  /** R6b: sentAt of the initial that established it (peer's clock), or our start time; null for put(). */
  establishedAt: number | null;
}
export interface ContactRecord {
  v: 2;
  peer: string;
  sessions: StoredSession[];
  dedup: { id: string; exp: number }[];
  unacked: { id: string; sessionId: string; sentAt: number }[];
}
/** Our static identity (the node's): needed to start and accept sessions. */
export interface StoreIdentity { staticPrivKey: Uint8Array; staticPubKey: Uint8Array; nodeIdHex: string }
export type ReceiveFailure = DecryptFailure | 'duplicate' | 'initial-too-old' | 'initial-from-future' | 'peer-key-mismatch' | 'no-session';
export type StoreObserve = Observe & X3dhObserve;
/** §4.4: dedup and receive-only sessions live TTL + 1 day. */
export const DEDUP_TTL_MS = MAX_INITIAL_AGE_MS;
export const MAX_DEDUP_ENTRIES = 10_000;
export const MAX_UNACKED = 2000;

export interface RatchetStoreOptions {
  dir: string;
  /** #34: ratchetSealKey(meshSeed). */
  sealKey: Uint8Array;
  anchor: AnchorProvider;
  /** Listeners attached before open(), so startup events reach them. */
  on?: Partial<{ [K in keyof RatchetStoreEvents]: (...args: RatchetStoreEvents[K]) => void }>;
  lockTimeoutMs?: number;
  /** Test-only crash points. */
  checkpoint?: (point: CheckpointPoint) => void;
  randomBytes?: (n: number) => Uint8Array;
  identity?: StoreIdentity;
  /** Test-only: a smaller dedup cap (default MAX_DEDUP_ENTRIES), so eviction can be exercised on a sealed store quickly. */
  maxDedupEntries?: number;
}

/** #34 from the mesh seed. */
export function ratchetSealKey(meshSeed: Uint8Array): Uint8Array {
  return derivePurposeKey(meshSeed, Purpose.RATCHET_SEAL);
}
const fileKeyOf = (sealKey: Uint8Array): Uint8Array => hkdf(sha256, sealKey, undefined, STORE_LABELS.FILE, 32);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const u64 = (v: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };

/** The on-disk name of a contact's state file. */
export function ratchetFileName(sealKey: Uint8Array, peerNodeId: string): string {
  return `${hex(hmac(sha256, fileKeyOf(sealKey), Buffer.concat([Buffer.of(0x01), Buffer.from(peerNodeId, 'hex')]))).slice(0, 40)}.ratchet`;
}

type Owner = { pid: number; hostname: string; token: string; at: number };

export class RatchetStore extends EventEmitter<RatchetStoreEvents> {
  readonly mode: 'sealed' | 'memory-only';
  startup!: StartupReport;
  private readonly opts: RatchetStoreOptions | null;
  private readonly memoryReason: string | null;
  private readonly records = new Map<string, ContactRecord>();
  private readonly droppedLogged = new Set<string>();
  private readonly identity: StoreIdentity | null;
  private readonly poisoned = new Set<string>();
  private unreadable = new Set<string>();
  private keyMismatch = false;
  private rehandshake = new Set<string>();
  private anchor: RatchetAnchor | null = null;
  private token: string | null = null;
  private opened = false;
  private closed = false;

  /** Use openRatchetStore / memoryOnlyRatchetStore. */
  constructor(spec: { sealed: RatchetStoreOptions } | { memoryOnly: string; identity?: StoreIdentity }) {
    super();
    const id = 'memoryOnly' in spec ? spec.identity : spec.sealed?.identity;
    if (id !== undefined) {
      if (!id || !(id.staticPrivKey instanceof Uint8Array) || !(id.staticPubKey instanceof Uint8Array) ||
          Buffer.from(x25519.getPublicKey(id.staticPrivKey)).toString('hex') !== Buffer.from(id.staticPubKey).toString('hex') ||
          !staticMatchesNodeId(id.staticPubKey, id.nodeIdHex)) {
        throw new RatchetStoreRequiredError('ratchet store identity: staticPrivKey, staticPubKey and nodeIdHex must belong together');
      }
    }
    this.identity = id ?? null;
    if ('memoryOnly' in spec) {
      if (typeof spec.memoryOnly !== 'string' || !spec.memoryOnly.trim()) throw new RatchetStoreRequiredError('memory-only ratchets need a stated reason');
      this.mode = 'memory-only'; this.opts = null; this.memoryReason = spec.memoryOnly;
    } else {
      const o = spec.sealed;
      if (!o || typeof o.dir !== 'string' || !o.dir || !(o.sealKey instanceof Uint8Array) || o.sealKey.length !== 32 ||
          !o.anchor || typeof o.anchor.load !== 'function' || typeof o.anchor.save !== 'function') {
        throw new RatchetStoreRequiredError('a sealed ratchet store needs dir, a 32-byte sealKey and an anchor provider');
      }
      this.opts = o; this.memoryReason = null;
      this.mode = 'sealed';
    }
  }

  // ── open ───────────────────────────────────────────────────────────────
  open(): StartupReport {
    if (this.opened) return this.startup;
    this.opened = true;
    if (!this.opts) return this.goMemoryOnly(this.memoryReason as string);
    const loaded = this.opts.anchor.load();
    if (loaded.status !== 'ok' && loaded.status !== 'absent') {
      return this.goMemoryOnly(`OS secure storage is ${loaded.status}${loaded.detail ? ` (${loaded.detail})` : ''}: ratchets are kept in memory for this run; nothing is written`);
    }
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    this.claimOwner();
    try {
      this.load(loaded.status === 'ok' ? loaded.anchor : null);
    } catch (e) {
      this.releaseOwner();
      throw e;
    }
    return this.startup;
  }

  private goMemoryOnly(reason: string): StartupReport {
    (this as { mode: string }).mode = 'memory-only';
    this.startup = { mode: 'memory-only', memoryOnlyReason: reason, unreadable: [] };
    logger.warn('ratchet-store', 'ratchet-memory-only', `Ratchet sessions are memory-only: ${reason}`, {});
    this.emit('ratchet-memory-only', { reason });
    return this.startup;
  }

  private load(anchor: RatchetAnchor | null): void {
    const o = this.opts as RatchetStoreOptions;
    const present = new Set(fs.readdirSync(o.dir).filter((f) => f.endsWith('.ratchet')));
    const marker = this.readMarker();
    // Key check first: under a wrong key every name misses, which is not a rollback.
    if (marker === 'mismatch' || (marker === null && present.size > 0)) {
      this.keyMismatch = true;
      const peers = anchor ? Object.keys(anchor.gens) : [];
      this.unreadable = new Set(peers);
      this.anchor = anchor;
      this.startup = { mode: 'sealed', unreadable: peers, keyMismatch: true };
      logger.error('ratchet-store', 'ratchet-unreadable',
        marker === 'mismatch'
          ? 'The ratchet store was sealed under a different key; refusing to read or write it (nothing deleted)'
          : 'Ratchet state files exist without a key check; refusing to read or write them (nothing deleted)',
        { files: present.size });
      this.emit('ratchet-unreadable', { peers, keyMismatch: true });
      return;
    }
    let rollback: RollbackReason | null = null;
    if (!anchor) {
      anchor = { v: 1, installId: hex(this.random(16)), gens: {} };
      if (present.size) rollback = 'anchor-missing';
    } else if (marker && marker !== anchor.installId) {
      rollback = 'install-mismatch';
    }
    const loaded = new Map<string, { record: ContactRecord; gen: number }>();
    const attributed = new Set<string>();
    const peers = Object.keys(anchor.gens);
    if (!rollback) {
      for (const peer of peers) {
        const name = ratchetFileName(o.sealKey, peer);
        attributed.add(name);
        if (!present.has(name)) { rollback ||= 'file-missing'; continue; }
        const r = this.openFile(peer, path.join(o.dir, name), anchor.installId);
        if (r === 'unreadable') { this.unreadable.add(peer); continue; }
        if (r === 'install-mismatch') { rollback ||= 'install-mismatch'; continue; }
        if (r.gen < anchor.gens[peer]) { rollback ||= 'generation-behind'; continue; }
        loaded.set(peer, r);
      }
      if (!rollback && [...present].some((f) => !attributed.has(f))) rollback = 'orphan-file';
    }
    if (rollback) {
      this.discardAll(rollback, anchor, present, peers);
      return;
    }
    let raised = false;
    for (const [peer, { record, gen }] of loaded) {
      this.records.set(peer, record);
      if (gen > anchor.gens[peer]) { anchor.gens[peer] = gen; raised = true; }
    }
    if (raised || marker !== anchor.installId) this.saveAnchor(anchor, 'record the anchor');
    this.anchor = anchor;
    if (marker !== anchor.installId) this.writeMarker(anchor.installId);
    this.startup = { mode: 'sealed', unreadable: [...this.unreadable] };
    if (this.unreadable.size) this.reportUnreadable();
  }

  /** Every ratchet goes: files the store can attribute are removed (unreadable ones stay), generations cleared. */
  private discardAll(reason: RollbackReason, anchor: RatchetAnchor, present: Set<string>, peers: string[]): void {
    const o = this.opts as RatchetStoreOptions;
    const keep = new Set([...this.unreadable].map((p) => ratchetFileName(o.sealKey, p)));
    for (const f of present) if (!keep.has(f)) removeFileDurableSync(path.join(o.dir, f));
    const fresh: RatchetAnchor = { v: 1, installId: anchor.installId, gens: {} };
    for (const p of this.unreadable) if (anchor.gens[p] !== undefined) fresh.gens[p] = anchor.gens[p];
    this.saveAnchor(fresh, 'record the discard');
    this.writeMarker(fresh.installId);
    this.anchor = fresh;
    const discarded = peers.filter((p) => !this.unreadable.has(p));
    this.rehandshake = new Set(discarded);
    this.startup = { mode: 'sealed', rollback: { reason, peers: discarded }, unreadable: [...this.unreadable] };
    // Without an anchor the (HMAC) file names cannot be attributed to contacts.
    const who = reason === 'anchor-missing'
      ? `${present.size} ratchet file(s) belonged to unknown contacts; every contact's secure session starts over`
      : `${discarded.length} contact(s) need a new secure session`;
    logger.log('CRITICAL', 'ratchet-store', 'ratchet-rollback',
      `Ratchet state rollback detected (${reason}): every ratchet was discarded; ${who}. ` +
      'Possible causes: a backup or snapshot of the data directory was restored, files were copied in, or the app crashed mid-write.',
      { reason, contacts: discarded.length, files: present.size, peerPrefixes: discarded.map((p) => p.slice(0, 16)).join(',') });
    this.emit('ratchet-rollback', { reason, peers: discarded });
    if (this.unreadable.size) this.reportUnreadable();
  }

  private reportUnreadable(): void {
    logger.error('ratchet-store', 'ratchet-unreadable',
      `${this.unreadable.size} ratchet state file(s) could not be opened; refusing to use or overwrite them`,
      { contacts: this.unreadable.size, peerPrefixes: [...this.unreadable].map((p) => p.slice(0, 16)).join(',') });
    this.emit('ratchet-unreadable', { peers: [...this.unreadable], keyMismatch: false });
  }

  // ── files ──────────────────────────────────────────────────────────────
  private aad(peer: string, installId: Buffer, gen: Buffer): Buffer {
    return Buffer.concat([Buffer.from(STORE_LABELS.STATE_AAD), Buffer.from(peer, 'hex'), installId, gen]);
  }

  private openFile(peer: string, file: string, installId: string): { record: ContactRecord; gen: number } | 'unreadable' | 'install-mismatch' {
    let b: Buffer;
    try { b = fs.readFileSync(file); } catch { return 'unreadable'; }
    if (b.length < HEADER_LEN + 16 || b.toString('latin1', 0, 4) !== FILE_MAGIC || b[4] !== FORMAT) return 'unreadable';
    if (b.subarray(5, 21).toString('hex') !== installId) return 'install-mismatch';
    const genBytes = b.subarray(21, 29);
    try {
      const plain = gcm((this.opts as RatchetStoreOptions).sealKey, b.subarray(29, 41), this.aad(peer, b.subarray(5, 21), genBytes)).decrypt(b.subarray(41));
      const record = parseRecord(Buffer.from(plain).toString('utf8'), peer);
      return record ? { record, gen: Number(genBytes.readBigUInt64BE(0)) } : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  private seal(peer: string, record: ContactRecord, gen: number, installId: string): Buffer {
    const id = Buffer.from(installId, 'hex');
    const g = u64(gen);
    const nonce = this.random(12);
    const ct = gcm((this.opts as RatchetStoreOptions).sealKey, nonce, this.aad(peer, id, g)).encrypt(enc.encode(JSON.stringify(record)));
    return Buffer.concat([Buffer.from(FILE_MAGIC, 'latin1'), Buffer.of(FORMAT), id, g, Buffer.from(nonce), Buffer.from(ct)]);
  }

  private markerPath(): string { return path.join((this.opts as RatchetStoreOptions).dir, 'store.id'); }
  private markerCheck(installId: Buffer): Buffer {
    return Buffer.from(hmac(sha256, fileKeyOf((this.opts as RatchetStoreOptions).sealKey), Buffer.concat([Buffer.of(0x02), installId])));
  }
  /** installId (hex) when the key check passes, 'mismatch' when it fails, null when there is no marker. */
  private readMarker(): string | 'mismatch' | null {
    let b: Buffer;
    try { b = fs.readFileSync(this.markerPath()); } catch { return null; }
    if (b.length !== 4 + 1 + 16 + 32 || b.toString('latin1', 0, 4) !== MARKER_MAGIC || b[4] !== FORMAT) return 'mismatch';
    const id = b.subarray(5, 21);
    return b.subarray(21).equals(this.markerCheck(id)) ? id.toString('hex') : 'mismatch';
  }
  private writeMarker(installId: string): void {
    const id = Buffer.from(installId, 'hex');
    writeFileAtomicSync(this.markerPath(), Buffer.concat([Buffer.from(MARKER_MAGIC, 'latin1'), Buffer.of(FORMAT), id, this.markerCheck(id)]));
  }

  private saveAnchor(anchor: RatchetAnchor, why: string): void {
    try {
      (this.opts as RatchetStoreOptions).anchor.save({ v: 1, installId: anchor.installId, gens: { ...anchor.gens } });
    } catch (e) {
      throw new RatchetPersistError(`could not write the ratchet anchor to secure storage (${why}): ${(e as Error).message}`);
    }
  }

  // ── ownership ──────────────────────────────────────────────────────────
  private ownerPath(): string { return path.join((this.opts as RatchetStoreOptions).dir, 'owner.json'); }
  private readOwner(): Owner | null {
    try { return JSON.parse(fs.readFileSync(this.ownerPath(), 'utf8')) as Owner; } catch { return null; }
  }
  private claimOwner(): void {
    const o = this.opts as RatchetStoreOptions;
    withFileLock(this.ownerPath(), () => {
      const cur = this.readOwner();
      if (cur && !ownerIsDead(cur)) {
        throw new RatchetStoreInUseError(`the ratchet store at ${o.dir} is owned by pid ${cur.pid} on ${cur.hostname}; one process per store`);
      }
      if (cur) logger.warn('ratchet-store', 'owner-taken-over', `Taking over the ratchet store from dead pid ${cur.pid}`, { pid: cur.pid });
      this.token = hex(this.random(12));
      writeFileAtomicSync(this.ownerPath(), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: this.token, at: Date.now() }));
    }, { timeoutMs: o.lockTimeoutMs ?? 5000 });
  }
  private releaseOwner(): void {
    if (!this.opts || !this.token) return;
    try {
      withFileLock(this.ownerPath(), () => {
        if (this.readOwner()?.token === this.token) removeFileDurableSync(this.ownerPath());
      }, { timeoutMs: this.opts.lockTimeoutMs ?? 5000 });
    } catch { /* best effort: a dead owner is taken over */ }
    this.token = null;
  }

  // ── public API ─────────────────────────────────────────────────────────
  /** Is there a session to send on? */
  has(peer: string): boolean { return !!sendingOf(this.records.get(peer)); }
  /** The sending session's ratchet state (a copy). */
  get(peer: string): RatchetState | null { const s = sendingOf(this.records.get(peer)); return s ? deserializeState(serializeState(s.state)) : null; }
  peers(): string[] { return [...this.records.keys()].filter((p) => this.has(p)); }
  needsRehandshake(): string[] { return [...this.rehandshake]; }
  sessionInfo(peer: string): { sending: string | null; sessions: { id: string; initiator: string | null; sending: boolean; initPending: boolean; createdAt: number; lastUsedAt: number }[] } {
    const r = this.records.get(peer);
    return {
      sending: sendingOf(r)?.id ?? null,
      sessions: (r?.sessions || []).map((x) => ({ id: x.id, initiator: x.initiator, sending: x.sending, initPending: !!x.initPending, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt })),
    };
  }
  /** messageIds sent to this contact and not yet acknowledged, oldest first. */
  unacknowledged(peer: string): string[] { return (this.records.get(peer)?.unacked || []).map((u) => u.id); }
  /** messageIds currently held for dedup. */
  dedupIds(peer: string): string[] { return (this.records.get(peer)?.dedup || []).map((d) => d.id); }

  /** Store a ready session (tests, and any future non-X3DH path), write-ahead like every write. */
  put(peer: string, state: RatchetState): void {
    this.usable(peer, false);
    if (state.peerNodeId !== peer) throw new Error('ratchet store: the state belongs to a different contact');
    const now = Date.now();
    const next = cloneRecord(this.records.get(peer) || emptyRecord(peer));
    for (const x of next.sessions) x.sending = false;
    next.sessions.push({ id: `direct-${hex(this.random(8))}`, initiator: null, sending: true, initPending: null, state: deserializeState(serializeState(state)), createdAt: now, lastUsedAt: now, establishedAt: null });
    prune(next, now);
    this.persist(peer, next, 'put');
    this.rehandshake.delete(peer);
  }

  /**
   * Start a session with X3DH-lite (§4.2). The EK and SK are derived after the
   * anchor step, so a crash cannot make them derive again on the same state.
   * Messages sent next are kind 0x02 until a reply arrives on this session.
   */
  initiate(peer: string, o: { peerStaticPub: Uint8Array; replace?: boolean }, deps: RatchetDeps, opts: { observe?: StoreObserve } = {}): string {
    this.usable(peer, false);
    const me = this.needIdentity();
    if (!staticMatchesNodeId(o.peerStaticPub, peer)) throw new RatchetPeerKeyError('that static key does not hash to the contact NodeID');
    const current = sendingOf(this.records.get(peer));
    if (current && !current.initPending && !o.replace) throw new RatchetSessionExistsError('an established session exists; pass { replace: true } to start over');
    const now = deps.now();
    let id = '';
    this.persist(peer, null, 'initiate', () => {
      const { rootKey, ekPub } = x3dhInitiate({ selfStaticPriv: me.staticPrivKey, selfNodeId: me.nodeIdHex, peerStaticPub: o.peerStaticPub, peerNodeId: peer }, deps, opts.observe);
      const state = initSender({ rootKey, remoteDhPub: o.peerStaticPub, selfNodeId: me.nodeIdHex, peerNodeId: peer }, deps);
      const next = cloneRecord(this.records.get(peer) || emptyRecord(peer));
      for (const x of next.sessions) x.sending = false;
      id = hex(ekPub);
      next.sessions.push({ id, initiator: me.nodeIdHex, sending: true, initPending: { ek: id }, state, createdAt: now, lastUsedAt: now, establishedAt: now });
      prune(next, now);
      return next;
    });
    this.rehandshake.delete(peer);
    return id;
  }

  /** Encrypt on the sending session, persist, and only then return the ciphertext. */
  send(peer: string, plaintext: Uint8Array, deps: RatchetDeps, opts: { observe?: Observe } = {}): Uint8Array {
    this.usable(peer, true);
    const now = deps.now();
    let message: Uint8Array | null = null;
    let dropped: string[] = [];
    this.persist(peer, null, 'send', () => {
      const next = cloneRecord(this.records.get(peer) as ContactRecord);
      const s = sendingOf(next) as StoredSession;
      const initial = s.initPending ? { ek: unhexB(s.initPending.ek), sentAt: now } : undefined;
      const e = encrypt(s.state, plaintext, deps, { observe: opts.observe, initial });
      s.state = e.state; s.lastUsedAt = now;
      next.unacked.push({ id: e.messageId, sessionId: s.id, sentAt: now });
      dropped = prune(next, now);
      message = e.message;
      return next;
    });
    this.reportDropped(peer, dropped);
    return message as unknown as Uint8Array;
  }

  /**
   * Decrypt, persist (dedup entry included), and only then return the
   * plaintext. Every check that can fail runs before anything is written, so
   * a rejected message changes nothing.
   */
  receive(peer: string, message: Uint8Array, deps: RatchetDeps, opts: { observe?: StoreObserve; peerStaticPub?: Uint8Array } = {}):
    { ok: true; plaintext: Uint8Array; messageId: string } | { ok: false; reason: ReceiveFailure } {
    this.usable(peer, false);
    const parsed = decodeMessage(message);
    if (typeof parsed === 'string') return { ok: false, reason: parsed };
    const { header } = parsed;
    const now = deps.now();
    const rec = this.records.get(peer);
    const id = hex(header.messageId);
    if (rec?.dedup.some((d) => d.id === id && d.exp > now)) return { ok: false, reason: 'duplicate' };

    let decrypted: { state: RatchetState; plaintext: Uint8Array } | null = null;
    let sessionId = '';
    let created: StoredSession | null = null;
    if (header.kind === KIND_INITIAL) {
      const age = initialAgeProblem(header.sentAt as number, now);
      if (age) return { ok: false, reason: age };
      sessionId = hex(header.ek as Uint8Array);
      const known = rec?.sessions.find((x) => x.id === sessionId);
      if (known) {
        const d = decrypt(known.state, message, deps, { observe: opts.observe, allowInitial: true });
        if (!d.ok) return { ok: false, reason: (d as { reason: DecryptFailure }).reason };
        decrypted = d;
      } else {
        const me = this.needIdentity();
        if (!opts.peerStaticPub) throw new RatchetPeerKeyError('an initial message needs the contact static key (peerStaticPub)');
        if (!staticMatchesNodeId(opts.peerStaticPub, peer)) return { ok: false, reason: 'peer-key-mismatch' };
        let start: RatchetState;
        try {
          const sk = x3dhRespond({ selfStaticPriv: me.staticPrivKey, selfNodeId: me.nodeIdHex, peerStaticPub: opts.peerStaticPub, peerNodeId: peer, ekPub: header.ek as Uint8Array }, opts.observe);
          start = initReceiver({ rootKey: sk, selfDh: { priv: me.staticPrivKey, pub: me.staticPubKey }, selfNodeId: me.nodeIdHex, peerNodeId: peer }, deps);
        } catch {
          return { ok: false, reason: 'malformed' };       // e.g. a low-order EK_s
        }
        const d = decrypt(start, message, deps, { observe: opts.observe, allowInitial: true });
        if (!d.ok) return { ok: false, reason: (d as { reason: DecryptFailure }).reason };
        decrypted = d;
        created = { id: sessionId, initiator: peer, sending: false, initPending: null, state: d.state, createdAt: now, lastUsedAt: now, establishedAt: header.sentAt as number };
      }
    } else {
      if (!rec || !rec.sessions.length) return { ok: false, reason: 'no-session' };
      const order = [...rec.sessions].sort((x, y) => (x.sending === y.sending ? y.lastUsedAt - x.lastUsedAt : x.sending ? -1 : 1));
      let first: DecryptFailure | null = null;
      for (const x of order) {
        const d = decrypt(x.state, message, deps, { observe: opts.observe });
        if (d.ok) { decrypted = d; sessionId = x.id; break; }
        first ||= (d as { reason: DecryptFailure }).reason;
      }
      if (!decrypted) return { ok: false, reason: first as DecryptFailure };
    }
    this.opts?.checkpoint?.('receive:computed');

    const next = cloneRecord(rec || emptyRecord(peer));
    const events: { reason: 'peer-reset' | 'glare'; previous: string | null; current: string; unacknowledged: string[] }[] = [];
    const me = this.identity;
    let stale = false;
    if (created) {
      const cur = sendingOf(next);
      next.sessions.push(created);
      if (!cur) {
        created.sending = true;
      } else if (cur.initPending && me && cur.initiator === me.nodeIdHex) {
        // Glare (§4.2): the session initiated by the lower NodeID sends; both stay receivable.
        if (peer < me.nodeIdHex) {
          cur.sending = false; created.sending = true;
          events.push({ reason: 'glare', previous: cur.id, current: created.id, unacknowledged: [] });
        }
      } else if (isStale(created, cur, peer)) {
        // R6b: not later than the session it would replace: receive-only, never a reset.
        stale = true;
      } else {
        // The peer started over on an established session: it lost its state.
        cur.sending = false; created.sending = true;
        events.push({ reason: 'peer-reset', previous: cur.id, current: created.id, unacknowledged: next.unacked.map((u) => u.id) });
      }
    } else {
      const x = next.sessions.find((y) => y.id === sessionId) as StoredSession;
      x.state = (decrypted as { state: RatchetState }).state;
      x.lastUsedAt = now;
      if (x.initPending && me && x.initiator === me.nodeIdHex) {
        // A reply on a session we initiated: the peer holds it, so it is the one to send on.
        x.initPending = null;
        if (!x.sending) {
          const cur = sendingOf(next);
          if (cur) cur.sending = false;
          x.sending = true;
          events.push({ reason: 'glare', previous: cur?.id ?? null, current: x.id, unacknowledged: [] });
        }
      }
    }
    next.dedup.push({ id, exp: now + DEDUP_TTL_MS });
    const dropped = prune(next, now, this.opts?.maxDedupEntries);
    this.persist(peer, next, 'receive');
    this.rehandshake.delete(peer);
    if (stale) {
      logger.warn('ratchet-store', 'ratchet-stale-initial',
        'An initial message older than the current session arrived; it is kept for receiving only and does not replace the session',
        { peerPrefix: peer.slice(0, 16) });
      this.emit('ratchet-stale-initial', { peer, sessionId: (created as StoredSession).id });
    }
    for (const ev of events) {
      if (ev.reason === 'peer-reset') {
        logger.warn('ratchet-store', 'ratchet-session-replaced',
          `A contact started a new secure session over an established one (it lost its ratchet state, or someone holding its phrase did this); ${ev.unacknowledged.length} sent message(s) were never acknowledged`,
          { peerPrefix: peer.slice(0, 16), unacknowledged: ev.unacknowledged.length });
      }
      this.emit('ratchet-session-replaced', { peer, ...ev });
    }
    this.reportDropped(peer, dropped);
    return { ok: true, plaintext: (decrypted as { plaintext: Uint8Array }).plaintext, messageId: id };
  }

  /** The app received a receipt for these messages (R7/R9): they are no longer reported. */
  acknowledge(peer: string, messageIds: string[]): void {
    this.usable(peer, false);
    const rec = this.records.get(peer);
    if (!rec) return;
    const drop = new Set(messageIds);
    if (!rec.unacked.some((u) => drop.has(u.id))) return;
    const next = cloneRecord(rec);
    next.unacked = next.unacked.filter((u) => !drop.has(u.id));
    this.persist(peer, next, 'ack');
  }

  /** The one explicit way to deal with an unreadable file: move it aside, unchanged. */
  moveAsideUnreadable(peer: string): string {
    if (this.closed) throw new RatchetStoreClosedError('ratchet store is closed');
    if (!this.opts || !this.unreadable.has(peer) || this.keyMismatch) throw new Error('ratchet store: that contact has no unreadable file to move aside');
    const from = path.join(this.opts.dir, ratchetFileName(this.opts.sealKey, peer));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const to = `${from}.unreadable-${stamp}`;
    fs.renameSync(from, to);
    this.unreadable.delete(peer);
    if (this.anchor) {
      const next = { ...this.anchor, gens: { ...this.anchor.gens } };
      delete next.gens[peer];
      this.saveAnchor(next, 'forget the moved-aside contact');
      this.anchor = next;
    }
    this.rehandshake.add(peer);
    logger.warn('ratchet-store', 'ratchet-unreadable-moved-aside', 'An unreadable ratchet state file was moved aside unchanged', { file: path.basename(to) });
    return to;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseOwner();
    this.records.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────
  private needIdentity(): StoreIdentity {
    if (!this.identity) throw new RatchetStoreRequiredError('starting or accepting a session needs the node identity (store option `identity`)');
    return this.identity;
  }

  /** The event fires for every drop; the WARN line once per contact per run (R7). */
  private reportDropped(peer: string, ids: string[]): void {
    if (!ids.length) return;
    if (!this.droppedLogged.has(peer)) {
      this.droppedLogged.add(peer);
      logger.warn('ratchet-store', 'ratchet-unacknowledged-dropped',
        `The unacknowledged-message list for a contact reached its cap (${MAX_UNACKED}); older ids are now dropped from it, each reported by event (logged once)`,
        { peerPrefix: peer.slice(0, 16), count: ids.length });
    }
    this.emit('ratchet-unacknowledged-dropped', { peer, messageIds: ids });
  }

  private usable(peer: string, needSession: boolean): ContactRecord | null {
    if (this.closed) throw new RatchetStoreClosedError('ratchet store is closed');
    if (!this.opened) throw new RatchetStoreRequiredError('ratchet store used before open()');
    if (!NODE_ID_HEX.test(peer)) throw new Error('ratchet store: a contact is a 128-hex NodeID');
    if (this.keyMismatch || this.unreadable.has(peer)) {
      throw new RatchetStateUnreadableError('the state file for this contact cannot be opened; it is kept unchanged (moveAsideUnreadable to replace it)');
    }
    if (this.poisoned.has(peer)) {
      throw new RatchetSessionPoisonedError('a key for this contact was derived but its state could not be saved; the session ends with this run');
    }
    const r = this.records.get(peer) || null;
    if (needSession && !sendingOf(r)) throw new RatchetNoSessionError('no ratchet session for this contact; a new handshake is needed');
    return r;
  }

  /**
   * The write-ahead sequence. `compute` (initiate, send) runs after the anchor
   * step and before the file write, so every key it derives is covered by the
   * anchor: a crash in between reads as rollback, never as a reusable state.
   */
  private persist(peer: string, next: ContactRecord | null, op: 'put' | 'send' | 'receive' | 'initiate' | 'ack', compute?: () => ContactRecord): void {
    const cp = this.opts?.checkpoint;
    if (this.mode === 'memory-only' || !this.opts) {     // memory-only: nothing is ever written
      this.records.set(peer, compute ? compute() : (next as ContactRecord));
      return;
    }
    const anchor = this.anchor as RatchetAnchor;
    const gen = (anchor.gens[peer] ?? 0) + 1;
    const bumped: RatchetAnchor = { v: 1, installId: anchor.installId, gens: { ...anchor.gens, [peer]: gen } };
    this.saveAnchor(bumped, `generation ${gen}`);        // throws RatchetPersistError; nothing derived yet
    this.anchor = bumped;
    cp?.(`${op}:anchored` as CheckpointPoint);
    let record = next as ContactRecord;
    if (compute) {
      record = compute();
      cp?.(`${op}:computed` as CheckpointPoint);
    }
    try {
      const file = path.join(this.opts.dir, ratchetFileName(this.opts.sealKey, peer));
      const bytes = this.seal(peer, record, gen, anchor.installId);
      withFileLock(file, () => {
        if (this.readOwner()?.token !== this.token) throw new RatchetStoreInUseError('this process no longer owns the ratchet store');
        writeFileAtomicSync(file, bytes);
      }, { timeoutMs: this.opts.lockTimeoutMs ?? 5000 });
    } catch (e) {
      if (compute) this.poisoned.add(peer);              // keys exist that no file covers
      logger.error('ratchet-store', 'ratchet-persist-failed', `Could not save ratchet state (${op}); nothing was released`, { err: (e as Error).message });
      throw new RatchetPersistError(`could not save ratchet state (${op}): ${(e as Error).message}`);
    }
    cp?.(`${op}:persisted` as CheckpointPoint);
    this.records.set(peer, record);
  }

  private random(n: number): Uint8Array {
    const r = (this.opts?.randomBytes ?? nobleRandomBytes)(n);
    if (!(r instanceof Uint8Array) || r.length !== n) throw new Error('ratchet store: randomBytes returned the wrong length');
    return r;
  }
}

function ownerIsDead(o: Owner): boolean {
  if (o.hostname !== os.hostname()) return false;        // another host: never assume it is gone
  try { process.kill(o.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

const cloneRecord = (r: ContactRecord): ContactRecord => JSON.parse(JSON.stringify(r));
const unhexB = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const emptyRecord = (peer: string): ContactRecord => ({ v: 2, peer, sessions: [], dedup: [], unacked: [] });
const sendingOf = (r: ContactRecord | undefined | null): StoredSession | undefined => r?.sessions.find((x) => x.sending);

/** Parse and validate a contact record; null if anything is off. */
function parseRecord(text: string, peer: string): ContactRecord | null {
  try {
    const r = JSON.parse(text) as ContactRecord;
    if (!r || r.v !== 2 || r.peer !== peer || !Array.isArray(r.sessions) || !Array.isArray(r.dedup) || !Array.isArray(r.unacked)) return null;
    if (r.sessions.filter((x) => x.sending).length > 1) return null;
    for (const x of r.sessions) {
      if (typeof x.id !== 'string' || typeof x.sending !== 'boolean' || !Number.isFinite(x.createdAt) || !Number.isFinite(x.lastUsedAt)) return null;
      if (x.initPending !== null && !(x.initPending && /^[0-9a-f]{64}$/.test(x.initPending.ek))) return null;
      if (x.establishedAt === undefined) x.establishedAt = null;
      if (x.establishedAt !== null && !Number.isFinite(x.establishedAt)) return null;
      x.state = deserializeState(JSON.stringify(x.state));
      if (x.state.peerNodeId !== peer) return null;
    }
    if (!r.dedup.every((d) => /^[0-9a-f]{32}$/.test(d.id) && Number.isFinite(d.exp))) return null;
    if (!r.unacked.every((u) => /^[0-9a-f]{32}$/.test(u.id) && typeof u.sessionId === 'string' && Number.isFinite(u.sentAt))) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * R6b: may `created` (a session the peer just started) NOT replace `cur`? Its
 * initial must be strictly later than cur's establishing initial; when cur was
 * started by us the reference is our clock, so allow the 5-minute skew.
 */
function isStale(created: StoredSession, cur: StoredSession, peer: string): boolean {
  if (cur.establishedAt === null || created.establishedAt === null) return false;
  const ref = cur.initiator === peer ? cur.establishedAt : cur.establishedAt - MAX_INITIAL_SKEW_MS;
  return created.establishedAt <= ref;
}

/** TTL + 1 day for dedup entries and for sessions that only receive; caps on both lists. */
function prune(r: ContactRecord, now: number, maxDedup = MAX_DEDUP_ENTRIES): string[] {
  r.dedup = r.dedup.filter((d) => d.exp > now);
  if (r.dedup.length > maxDedup) r.dedup = r.dedup.slice(r.dedup.length - maxDedup);
  r.sessions = r.sessions.filter((x) => x.sending || now - x.lastUsedAt <= DEDUP_TTL_MS);
  let dropped: string[] = [];
  if (r.unacked.length > MAX_UNACKED) {
    dropped = r.unacked.slice(0, r.unacked.length - MAX_UNACKED).map((u) => u.id);
    r.unacked = r.unacked.slice(r.unacked.length - MAX_UNACKED);
  }
  return dropped;
}

/** Build and open a sealed store. Production code reaches this only through createGMPNode. */
export function openRatchetStore(opts: RatchetStoreOptions): RatchetStore {
  const s = new RatchetStore({ sealed: opts });
  for (const [ev, fn] of Object.entries(opts.on || {})) s.on(ev as keyof RatchetStoreEvents, fn as never);
  s.open();
  return s;
}

/** An explicit memory-only store (browser build, Q8; or a locked keyring). A reason is required. */
export function memoryOnlyRatchetStore(reason: string, opts: { on?: RatchetStoreOptions['on']; identity?: StoreIdentity } = {}): RatchetStore {
  const s = new RatchetStore({ memoryOnly: reason, identity: opts.identity });
  for (const [ev, fn] of Object.entries(opts.on || {})) s.on(ev as keyof RatchetStoreEvents, fn as never);
  s.open();
  return s;
}
