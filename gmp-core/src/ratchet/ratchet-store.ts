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
  encrypt, decrypt, serializeState, deserializeState,
  type RatchetState, type RatchetDeps, type Observe, type DecryptFailure,
} from './ratchet.js';

export const STORE_LABELS = Object.freeze({ STATE_AAD: 'gl-ratchet-state-v1', FILE: 'gl-ratchet-file-v1' });
const FILE_MAGIC = 'GLRS';
const MARKER_MAGIC = 'GLRM';
const FORMAT = 0x01;
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
  | 'put:anchored' | 'put:persisted';

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
  private readonly states = new Map<string, RatchetState>();
  private readonly poisoned = new Set<string>();
  private unreadable = new Set<string>();
  private keyMismatch = false;
  private rehandshake = new Set<string>();
  private anchor: RatchetAnchor | null = null;
  private token: string | null = null;
  private opened = false;
  private closed = false;

  /** Use openRatchetStore / memoryOnlyRatchetStore. */
  constructor(spec: { sealed: RatchetStoreOptions } | { memoryOnly: string }) {
    super();
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
    const loaded = new Map<string, { state: RatchetState; gen: number }>();
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
    for (const [peer, { state, gen }] of loaded) {
      this.states.set(peer, state);
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

  private openFile(peer: string, file: string, installId: string): { state: RatchetState; gen: number } | 'unreadable' | 'install-mismatch' {
    let b: Buffer;
    try { b = fs.readFileSync(file); } catch { return 'unreadable'; }
    if (b.length < HEADER_LEN + 16 || b.toString('latin1', 0, 4) !== FILE_MAGIC || b[4] !== FORMAT) return 'unreadable';
    if (b.subarray(5, 21).toString('hex') !== installId) return 'install-mismatch';
    const genBytes = b.subarray(21, 29);
    try {
      const plain = gcm((this.opts as RatchetStoreOptions).sealKey, b.subarray(29, 41), this.aad(peer, b.subarray(5, 21), genBytes)).decrypt(b.subarray(41));
      const state = deserializeState(Buffer.from(plain).toString('utf8'));
      if (state.peerNodeId !== peer) return 'unreadable';
      return { state, gen: Number(genBytes.readBigUInt64BE(0)) };
    } catch {
      return 'unreadable';
    }
  }

  private seal(peer: string, state: RatchetState, gen: number, installId: string): Buffer {
    const id = Buffer.from(installId, 'hex');
    const g = u64(gen);
    const nonce = this.random(12);
    const ct = gcm((this.opts as RatchetStoreOptions).sealKey, nonce, this.aad(peer, id, g)).encrypt(enc.encode(serializeState(state)));
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
  has(peer: string): boolean { return this.states.has(peer); }
  get(peer: string): RatchetState | null { const s = this.states.get(peer); return s ? deserializeState(serializeState(s)) : null; }
  peers(): string[] { return [...this.states.keys()]; }
  needsRehandshake(): string[] { return [...this.rehandshake]; }

  /** Store a new session (from the handshake, R6), write-ahead like every write. */
  put(peer: string, state: RatchetState): void {
    this.usable(peer, false);
    if (state.peerNodeId !== peer) throw new Error('ratchet store: the state belongs to a different contact');
    const copy = deserializeState(serializeState(state));
    this.persist(peer, copy, 'put');
    this.states.set(peer, copy);
    this.poisoned.delete(peer);
    this.rehandshake.delete(peer);
  }

  /** Encrypt, persist the new state, and only then return the ciphertext. */
  send(peer: string, plaintext: Uint8Array, deps: RatchetDeps, opts: { observe?: Observe } = {}): Uint8Array {
    const state = this.usable(peer, true) as RatchetState;
    let message: Uint8Array | null = null;
    this.persist(peer, null, 'send', () => {
      const e = encrypt(state, plaintext, deps, opts);
      message = e.message;
      return e.state;
    });
    return message as unknown as Uint8Array;
  }

  /** Decrypt, persist the new state, and only then return the plaintext. A failed decrypt changes nothing. */
  receive(peer: string, message: Uint8Array, deps: RatchetDeps, opts: { observe?: Observe } = {}):
    { ok: true; plaintext: Uint8Array; messageId: string } | { ok: false; reason: DecryptFailure } {
    const state = this.usable(peer, true) as RatchetState;
    const d = decrypt(state, message, deps, opts);
    if (!d.ok) return d;
    this.opts?.checkpoint?.('receive:computed');
    this.persist(peer, d.state, 'receive');
    return { ok: true, plaintext: d.plaintext, messageId: d.messageId };
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
    this.states.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────
  private usable(peer: string, needSession: boolean): RatchetState | null {
    if (this.closed) throw new RatchetStoreClosedError('ratchet store is closed');
    if (!this.opened) throw new RatchetStoreRequiredError('ratchet store used before open()');
    if (!NODE_ID_HEX.test(peer)) throw new Error('ratchet store: a contact is a 128-hex NodeID');
    if (this.keyMismatch || this.unreadable.has(peer)) {
      throw new RatchetStateUnreadableError('the state file for this contact cannot be opened; it is kept unchanged (moveAsideUnreadable to replace it)');
    }
    if (this.poisoned.has(peer)) {
      throw new RatchetSessionPoisonedError('a message key for this contact was derived but its state could not be saved; the session ends with this run');
    }
    const s = this.states.get(peer) || null;
    if (needSession && !s) throw new RatchetNoSessionError('no ratchet session for this contact; a new handshake is needed');
    return s;
  }

  /**
   * The write-ahead sequence. `compute` (send) runs after the anchor step and
   * before the file write, so a derived key is always covered by the anchor.
   */
  private persist(peer: string, next: RatchetState | null, op: 'put' | 'send' | 'receive', compute?: () => RatchetState): void {
    const cp = this.opts?.checkpoint;
    if (this.mode === 'memory-only' || !this.opts) {     // memory-only: nothing is ever written
      this.states.set(peer, compute ? compute() : (next as RatchetState));
      return;
    }
    const anchor = this.anchor as RatchetAnchor;
    const gen = (anchor.gens[peer] ?? 0) + 1;
    const bumped: RatchetAnchor = { v: 1, installId: anchor.installId, gens: { ...anchor.gens, [peer]: gen } };
    this.saveAnchor(bumped, `generation ${gen}`);        // throws RatchetPersistError; nothing derived yet
    this.anchor = bumped;
    cp?.(`${op}:anchored` as CheckpointPoint);
    let state = next as RatchetState;
    if (compute) {
      state = compute();
      cp?.('send:computed');
    }
    try {
      const file = path.join(this.opts.dir, ratchetFileName(this.opts.sealKey, peer));
      const bytes = this.seal(peer, state, gen, anchor.installId);
      withFileLock(file, () => {
        if (this.readOwner()?.token !== this.token) throw new RatchetStoreInUseError('this process no longer owns the ratchet store');
        writeFileAtomicSync(file, bytes);
      }, { timeoutMs: this.opts.lockTimeoutMs ?? 5000 });
    } catch (e) {
      if (compute) this.poisoned.add(peer);              // a sending key exists that no file covers
      logger.error('ratchet-store', 'ratchet-persist-failed', `Could not save ratchet state (${op}); nothing was released`, { err: (e as Error).message });
      throw new RatchetPersistError(`could not save ratchet state (${op}): ${(e as Error).message}`);
    }
    cp?.(`${op}:persisted` as CheckpointPoint);
    this.states.set(peer, state);
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

/** Build and open a sealed store. Production code reaches this only through createGMPNode. */
export function openRatchetStore(opts: RatchetStoreOptions): RatchetStore {
  const s = new RatchetStore({ sealed: opts });
  for (const [ev, fn] of Object.entries(opts.on || {})) s.on(ev as keyof RatchetStoreEvents, fn as never);
  s.open();
  return s;
}

/** An explicit memory-only store (browser build, Q8; or a locked keyring). A reason is required. */
export function memoryOnlyRatchetStore(reason: string, on?: RatchetStoreOptions['on']): RatchetStore {
  const s = new RatchetStore({ memoryOnly: reason });
  for (const [ev, fn] of Object.entries(on || {})) s.on(ev as keyof RatchetStoreEvents, fn as never);
  s.open();
  return s;
}
