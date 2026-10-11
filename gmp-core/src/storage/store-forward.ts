/**
 * Sealed store-and-forward, client side.
 *
 * Sending: seal to the contact's static X25519 key, deposit in the contact's
 * bucket on its mailbox host, and report SENT on the host's ack.
 *
 * DELIVERED is proved end to end: the recipient deposits a sealed receipt
 * carrying the message's receipt secret (at its next poll) on the sender's
 * mailbox. To the host a receipt is an ordinary 4 KiB blob.
 *
 * Receiving: every poll sends one FETCH_REQUEST of exactly `fetchBuckets`
 * entries, covering every contact's bucket plus `decoyChannels` decoy
 * channels (indistinguishable from real ones), round-robin and shuffled,
 * padded with random buckets when the set is smaller.
 *
 * Cursors are the host's sequence numbers; a seen-set prevents decrypting a
 * blob twice. No timers here; scheduling lives in sf-scheduler.ts.
 */

import crypto from 'crypto';
import fs from 'fs';
import { EventEmitter } from 'events';
import type { StoreForwardEvents } from '../events.js';
import { writeFileAtomicSync } from '../atomic-file.js';
import logger from '../logger.js';
import { refuse } from '../state-refusal.js';
import type { NodeIdentity } from '../types.js';
import type { GMPTransport } from '../transport/transport.js';
import type { EphemeralKeySource } from '../link/ephemeral-source.js';
import { hostKey, type Separation } from '../relay/role-separation.js';
import { StorageSession, type StorageAddress, type FetchEntry, type FetchResult } from './storage-client.js';
import {
  Channel,
  MAX_SF_PAYLOAD,
  RELEASE_BUCKET_SCHEDULE,
  activeBucketCounts,
  currentBucketCount,
  maxActiveBucketCount,
  openBlob,
  pairSecret,
  sealBlob,
  type BucketEpoch,
} from './sf-crypto.js';

const DAY_S = 86400;
const MAX_WINDOW_EPOCHS = 8; // TTL 7 days: current epoch plus seven before it
const DEFAULT_TTL_MS = 7 * DAY_S * 1000;
const KIND_MESSAGE = 0x00;
const KIND_RECEIPT = 0x01;
const MAX_HISTORY = 512;

export interface StoreForwardHost {
  identity: NodeIdentity | null;
  transport: GMPTransport;
  /** Required: hop identities and ephemerals for every session. */
  ephemeralSource: EphemeralKeySource;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  checkStorageHost(addr: StorageAddress): void;
  noteStorageHost(addr: StorageAddress, nodeIdHex: string): void;
  storageSeparation(addr: StorageAddress): Separation;
}

export interface OutboxEntry {
  localId: string;
  destNodeId: string;
  /** The receipt secret sealed into the message; the recipient's receipt echoes it. */
  receipt: string;
  host: StorageAddress;
  storedAt: number;
}

export interface PollReport {
  reason: string;
  requests: Array<{ host: string; entries: FetchEntry[]; real: number; decoys: number; blobs: number; truncated: boolean }>;
  received: number;
  delivered: number;
  receiptsSent: number;
  /** Blobs the host sent again (already in the seen-set): the cost of rounded cursors. Never re-decrypted. */
  refetched: number;
  errors: string[];
}

/** One bucket this client polls, and why. */
export interface FetchItem {
  bucket: number;
  bucketCount: number;
  decoy: boolean;
}

interface Contact {
  staticPub: string;
  mailbox?: StorageAddress;
}

interface PersistedState {
  v: 2;
  contacts: Record<string, Contact>;
  pollContacts: string[] | null;
  outbox: OutboxEntry[];
  pendingReceipts: Array<{ to: string; receipt: string }>;
  /** blobId -> forget after (ms). */
  seen: Record<string, number>;
  /** bucket -> since. */
  cursors: Record<string, number>;
  /** Sequence numbers this host returned, with when. */
  history: Array<{ at: number; seq: number }>;
  decoys: string[];
  cursor: number;
  lastWrap: number;
}

export class StoreForwardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreForwardError';
    this.code = code;
  }
}

/** Parse GMP_SF_STORAGE_PEER: "host:port" or "host:port#nodeIdHex". */
export function parseStoragePeer(spec: string): StorageAddress | null {
  const m = /^\s*(\[[^\]]+\]|[^:#\s]+):(\d{1,5})(?:#([0-9a-fA-F]{128}))?\s*$/.exec(spec || '');
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return {
    address: m[1].replace(/^\[|\]$/g, ''),
    port,
    ...(m[3] ? { nodeId: m[3].toLowerCase() } : {}),
    operator: 'self',
  };
}

export class StoreForward extends EventEmitter<StoreForwardEvents> {
  private readonly host: StoreForwardHost;
  private readonly stateFile: string | null;
  private readonly strictState: boolean;
  private readonly key: Buffer | null;
  readonly fetchBuckets: number;
  readonly decoyChannels: number;
  readonly cursorQuantumMs: number;
  readonly ttlMs: number;
  readonly bucketSchedule: readonly BucketEpoch[];
  private readonly ownMailboxFn: () => StorageAddress | null;
  clock: () => number;
  /** The blob opener; a property so tests can count trial decryptions. */
  _openBlob = openBlob;
  private state: PersistedState;
  private polling: Promise<PollReport> | null = null;

  constructor(o: {
    host: StoreForwardHost;
    stateFile?: string | null;
    encryptionKey?: Buffer | null;
    /** GMP_STRICT_STATE: refuse to start on a state file that cannot be opened. */
    strictState?: boolean;
    fetchBuckets: number;
    /** This user's mailbox: the self-hosted peer, or the default public storage host. */
    ownMailbox: () => StorageAddress | null;
    decoyChannels?: number;
    cursorQuantumMs?: number;
    ttlMs?: number;
    bucketSchedule?: readonly BucketEpoch[];
    clock?: () => number;
  }) {
    super();
    this.host = o.host;
    this.stateFile = o.stateFile ?? null;
    this.key = o.encryptionKey ?? null;
    this.strictState = o.strictState === true;
    this.fetchBuckets = o.fetchBuckets;
    this.decoyChannels = o.decoyChannels ?? 2;
    this.cursorQuantumMs = o.cursorQuantumMs ?? 300_000;
    this.ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
    this.bucketSchedule = o.bucketSchedule ?? RELEASE_BUCKET_SCHEDULE;
    this.ownMailboxFn = o.ownMailbox;
    this.clock = o.clock ?? (() => Date.now());
    this.state = {
      v: 2, contacts: {}, pollContacts: null, outbox: [], pendingReceipts: [], seen: {}, cursors: {}, history: [],
      decoys: [], cursor: 0, lastWrap: this.clock(),
    };
    this._load();
    while (this.state.decoys.length < this.decoyChannels) this.state.decoys.push(crypto.randomBytes(32).toString('hex'));
    this.state.decoys = this.state.decoys.slice(0, this.decoyChannels);
  }

  // ── contacts ─────────────────────────────────────

  /** Remember a peer's static key (from an authenticated handshake). */
  learnContact(nodeIdHex: string, staticPub: Uint8Array): void {
    const id = nodeIdHex.toLowerCase();
    const pub = Buffer.from(staticPub).toString('hex');
    const c = this.state.contacts[id];
    if (c && c.staticPub === pub) return;
    this.state.contacts[id] = { ...(c || {}), staticPub: pub };
    this._save();
  }

  /** Which contacts to poll for (the app's contact list). Null: every known contact. */
  setPollContacts(nodeIds: string[] | null): void {
    this.state.pollContacts = nodeIds ? [...new Set(nodeIds.map((n) => n.toLowerCase()))] : null;
    this._save();
  }

  isPollContact(nodeIdHex: string): boolean {
    return !!this.state.pollContacts && this.state.pollContacts.includes(nodeIdHex.toLowerCase());
  }

  /** A contact told us (end to end) where its mailbox is. */
  setMailbox(nodeIdHex: string, mailbox: StorageAddress): void {
    const c = this.state.contacts[nodeIdHex.toLowerCase()];
    if (!c) return;
    c.mailbox = { address: mailbox.address, port: mailbox.port, ...(mailbox.nodeId ? { nodeId: mailbox.nodeId } : {}) };
    this._save();
  }

  mailboxOf(nodeIdHex: string): StorageAddress | null {
    return this.state.contacts[nodeIdHex.toLowerCase()]?.mailbox ?? null;
  }

  ownMailbox(): StorageAddress | null {
    return this.ownMailboxFn();
  }

  /** What to tell contacts about our mailbox. The operator is ours to know, not theirs. */
  mailboxAnnouncement(): { address: string; port: number; nodeId?: string } | null {
    const m = this.ownMailbox();
    return m ? { address: m.address, port: m.port, ...(m.nodeId ? { nodeId: m.nodeId } : {}) } : null;
  }

  status(): { host: string | null; separation: Separation | 'none'; selfHosted: boolean; pending: number } {
    const m = this.ownMailbox();
    return {
      host: m ? hostKey(m.address, m.port) : null,
      separation: m ? this.host.storageSeparation(m) : 'none',
      selfHosted: !!m && m.operator === 'self',
      pending: this.state.outbox.length,
    };
  }

  get outbox(): readonly OutboxEntry[] {
    return this.state.outbox;
  }

  // ── sending ──────────────────────────────────────

  private _me(): NodeIdentity {
    const id = this.host.identity;
    if (!id) throw new StoreForwardError('NOT_STARTED', 'Identity not loaded');
    return id;
  }

  private _channel(peerHex: string, recipientHex: string): Channel {
    const me = this._me();
    const c = this.state.contacts[peerHex];
    if (!c) throw new StoreForwardError('NO_STATIC_KEY', `No static key known for ${peerHex.slice(0, 16)}…: connect to this contact once first`);
    const secret = pairSecret(me.staticPrivKey, me.nodeId, Buffer.from(c.staticPub, 'hex'), Buffer.from(peerHex, 'hex'));
    return new Channel(secret, Buffer.from(recipientHex, 'hex'));
  }

  private _hostFor(dest: string): StorageAddress {
    const host = this.state.contacts[dest]?.mailbox ?? this.ownMailbox();
    if (!host) throw new StoreForwardError('NO_STORAGE_HOST', 'No storage host: none announced by the contact, none configured, none listed');
    return host;
  }

  /** Seal `body` (kind-prefixed) for `dest` in its current bucket. */
  private _seal(dest: string, kind: number, body: Buffer, receiptSecret: Buffer): { bucket: number; blob: Buffer } {
    const me = this._me();
    const contact = this.state.contacts[dest];
    if (!contact) throw new StoreForwardError('NO_STATIC_KEY', `No static key known for ${dest.slice(0, 16)}…: connect to this contact once first`);
    const channel = this._channel(dest, dest);
    const tag = channel.tag(channel.epoch(Math.floor(this.clock() / 1000)));
    const bucket = channel.bucket(currentBucketCount(this.clock(), this.bucketSchedule));
    const payload = Buffer.concat([Buffer.from([kind]), body]);
    const blob = sealBlob(Buffer.from(contact.staticPub, 'hex'), { tag, receiptSecret, senderNodeId: Buffer.from(me.nodeId), payload });
    return { bucket, blob };
  }

  /**
   * Deposit a message for an offline contact. Resolves once the storage host
   * has acknowledged it (SENT, stored); rejects otherwise — never a guess.
   */
  async send(destNodeId: string, payload: string, localId: string = crypto.randomBytes(8).toString('hex')): Promise<{ localId: string }> {
    const dest = destNodeId.toLowerCase();
    const body = Buffer.from(payload, 'utf8');
    if (body.length + 1 > MAX_SF_PAYLOAD) throw new StoreForwardError('TOO_LARGE', `Payload exceeds ${MAX_SF_PAYLOAD - 1} bytes`);
    const host = this._hostFor(dest);
    const receipt = crypto.randomBytes(32);
    const { bucket, blob } = this._seal(dest, KIND_MESSAGE, body, receipt);
    const session = await this._open(host);
    try {
      await session.store(bucket, blob);
    } finally {
      session.close();
    }
    this.state.outbox.push({ localId, destNodeId: dest, receipt: receipt.toString('hex'), host, storedAt: this.clock() });
    this._save();
    this.emit('stored', { localId, destNodeId: dest });
    return { localId };
  }

  /** Role checks before and after the hop, then an open session. */
  private async _open(host: StorageAddress): Promise<StorageSession> {
    this.host.checkStorageHost(host);
    const session = await StorageSession.open(this.host.transport, host, { pingIntervalMs: this.host.pingIntervalMs, pongTimeoutMs: this.host.pongTimeoutMs, ephemeralSource: this.host.ephemeralSource });
    try {
      this.host.checkStorageHost({ ...host, nodeId: session.hostNodeId });
    } catch (e) {
      session.close();
      throw e;
    }
    this.host.noteStorageHost(host, session.hostNodeId);
    return session;
  }

  /** Deposit every queued receipt, grouped by the host it goes to. */
  private async _sendReceipts(report: PollReport): Promise<void> {
    const byHost = new Map<string, { host: StorageAddress; items: Array<{ to: string; receipt: string }> }>();
    for (const r of this.state.pendingReceipts) {
      let host: StorageAddress;
      try { host = this._hostFor(r.to); } catch (e) { report.errors.push((e as Error).message); continue; }
      const k = hostKey(host.address, host.port);
      if (!byHost.has(k)) byHost.set(k, { host, items: [] });
      byHost.get(k)!.items.push(r);
    }
    for (const [k, { host, items }] of byHost) {
      let session: StorageSession | null = null;
      try {
        session = await this._open(host);
        for (const r of items) {
          const { bucket, blob } = this._seal(r.to, KIND_RECEIPT, Buffer.from(r.receipt, 'hex'), crypto.randomBytes(32));
          await session.store(bucket, blob);
          this.state.pendingReceipts = this.state.pendingReceipts.filter((p) => p !== r);
          report.receiptsSent++;
        }
      } catch (e) {
        report.errors.push(`${k} receipts: ${(e as Error).message}`);
      } finally {
        if (session) session.close();
      }
    }
    this._save();
  }

  // ── receiving ────────────────────────────────────

  private _pollIds(): string[] {
    const known = Object.keys(this.state.contacts);
    return this.state.pollContacts ? this.state.pollContacts.filter((id) => known.includes(id)) : known;
  }

  /**
   * Every bucket to poll (real and decoy channels, every active bucket count),
   * one item per bucket id.
   */
  fetchSet(): FetchItem[] {
    const me = this._me();
    const myHex = Buffer.from(me.nodeId).toString('hex');
    const channels: Array<{ ch: Channel; decoy: boolean }> = [
      ...this._pollIds().map((id) => ({ ch: this._channel(id, myHex), decoy: false })),
      ...this.state.decoys.map((sec) => ({ ch: new Channel(Buffer.from(sec, 'hex'), me.nodeId), decoy: true })),
    ];
    const items = new Map<number, FetchItem>();
    for (const bucketCount of activeBucketCounts(this.clock(), this.ttlMs, this.bucketSchedule)) {
      for (const { ch, decoy } of channels) {
        const bucket = ch.bucket(bucketCount);
        const prev = items.get(bucket);
        items.set(bucket, prev ? { ...prev, decoy: prev.decoy && decoy } : { bucket, bucketCount, decoy });
      }
    }
    return [...items.values()].sort((a, b) => a.bucket - b.bucket);
  }

  /** Entries per FETCH_REQUEST: fetchBuckets, or fewer while fewer buckets exist (1 at launch). */
  get requestSize(): number {
    return Math.min(this.fetchBuckets, maxActiveBucketCount(this.clock(), this.ttlMs, this.bucketSchedule));
  }

  private _quantize(seq: number): number {
    const q = this.cursorQuantumMs * 1000;
    return q > 0 ? Math.floor(seq / q) * q : seq;
  }

  /** Every cursor value this client may send: sequence numbers the host itself returned. */
  cursorValues(): number[] {
    return this.state.history.map((h) => this._quantize(h.seq));
  }

  /**
   * A bucket's cursor; for one never fetched, one TTL back, which looks like
   * any other cursor.
   */
  private _sinceFor(item: { bucket: number }): number {
    const known = this.state.cursors[String(item.bucket)];
    if (known !== undefined) return known;
    return this._quantize(Math.max(0, this.clock() - this.ttlMs) * 1000);
  }

  /**
   * Pick exactly fetchBuckets entries: the next ones round-robin over the fetch
   * set, then random padding if the set is smaller, shuffled.
   */
  selectFetch(set: FetchItem[], advanceCursor: boolean): { entries: FetchEntry[]; real: number; decoys: number } {
    const n = this.requestSize;
    const chosen: FetchItem[] = [];
    if (set.length > 0) {
      const take = Math.min(n, set.length);
      let cursor = this.state.cursor % set.length;
      for (let i = 0; i < take; i++) chosen.push(set[(cursor + i) % set.length]);
      if (advanceCursor) {
        cursor += take;
        if (cursor >= set.length) this.state.lastWrap = this.clock();
        this.state.cursor = cursor % set.length;
      }
    }
    const entries: FetchEntry[] = chosen.map((it) => ({ bucket: it.bucket, since: this._sinceFor(it) }));
    const used = new Set(entries.map((e) => e.bucket));
    const range = maxActiveBucketCount(this.clock(), this.ttlMs, this.bucketSchedule);
    const past = this.cursorValues();
    while (entries.length < n && used.size < range) {
      const b = crypto.randomInt(range);
      if (used.has(b)) continue;
      used.add(b);
      entries.push({ bucket: b, since: past.length ? past[crypto.randomInt(past.length)] : this._sinceFor({ bucket: b }) });
    }
    for (let i = entries.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    const real = chosen.filter((c) => !c.decoy).length;
    return { entries, real, decoys: n - real };
  }

  /** One poll. Concurrent callers share the poll in flight. */
  poll(reason = 'manual'): Promise<PollReport> {
    if (!this.polling) {
      this.polling = this._poll(reason).finally(() => { this.polling = null; });
    }
    return this.polling;
  }

  private async _poll(reason: string): Promise<PollReport> {
    const report: PollReport = { reason, requests: [], received: 0, delivered: 0, receiptsSent: 0, refetched: 0, errors: [] };
    // Receipts for what was read last time go out first, in their own sessions.
    await this._sendReceipts(report);
    const own = this.ownMailbox();
    if (own) {
      const key = hostKey(own.address, own.port);
      const pick = this.selectFetch(this.fetchSet(), true);
      let session: StorageSession | null = null;
      try {
        session = await this._open(own);
        const res = await session.fetch(pick.entries);
        report.requests.push({ host: key, entries: pick.entries, real: pick.real, decoys: pick.decoys, blobs: res.blobs.length, truncated: res.truncated });
        this._advanceCursors(pick.entries, res);
        const r = this._receive(res);
        report.received += r.received;
        report.delivered += r.delivered;
        report.refetched += r.refetched;
      } catch (e) {
        report.errors.push(`${key}: ${(e as Error).message}`);
      } finally {
        if (session) session.close();
      }
    }
    this._expire();
    this._save();
    this.emit('poll-complete', report);
    return report;
  }

  private _advanceCursors(entries: FetchEntry[], res: FetchResult): void {
    const now = this.clock();
    for (const e of entries) {
      let next = res.seq;
      if (res.truncated) {
        // Only as far as what actually came back for this bucket.
        const inBucket = res.blobs.filter((b) => b.bucket === e.bucket).map((b) => b.seq);
        next = inBucket.length ? Math.max(...inBucket) : e.since;
      }
      this.state.cursors[String(e.bucket)] = this._quantize(next);
      this.state.history.push({ at: now, seq: next });
    }
    this.state.history = this.state.history.slice(-MAX_HISTORY);
  }

  /** Open what is ours, once: messages up (and a receipt queued), receipts settle DELIVERED. */
  private _receive(res: FetchResult): { received: number; delivered: number; refetched: number } {
    const me = this._me();
    const myHex = Buffer.from(me.nodeId).toString('hex');
    const nowS = Math.floor(this.clock() / 1000);
    const expected = new Map<string, string>();
    for (const id of Object.keys(this.state.contacts)) {
      const ch = this._channel(id, myHex);
      const cur = ch.epoch(nowS);
      for (let k = 0; k < MAX_WINDOW_EPOCHS; k++) expected.set(ch.tag(cur - k).toString('hex'), id);
    }
    let received = 0;
    let delivered = 0;
    let refetched = 0;
    for (const b of res.blobs) {
      if (this.state.seen[b.blobId]) { refetched++; continue; }
      this.state.seen[b.blobId] = this.clock() + this.ttlMs;
      const inner = this._openBlob(me.staticPrivKey, me.staticPubKey, b.blob);
      if (!inner || inner.payload.length < 1) continue; // someone else's blob sharing the bucket
      const from = expected.get(inner.tag.toString('hex'));
      // The tag is computable only from the pair's shared secret, so a match
      // authenticates the contact; the sealed sender NodeID must agree.
      if (!from || from !== inner.senderNodeId.toString('hex')) continue;
      const kind = inner.payload[0];
      if (kind === KIND_MESSAGE) {
        this.state.pendingReceipts.push({ to: from, receipt: inner.receiptSecret.toString('hex') });
        this.emit('message', { fromNodeId: from, payload: inner.payload.subarray(1).toString('utf8'), blobId: b.blobId });
        received++;
      } else if (kind === KIND_RECEIPT && inner.payload.length >= 33) {
        const secret = inner.payload.subarray(1, 33).toString('hex');
        const i = this.state.outbox.findIndex((o) => o.destNodeId === from && o.receipt === secret);
        if (i >= 0) {
          const [o] = this.state.outbox.splice(i, 1);
          this.emit('delivered', { localId: o.localId, destNodeId: o.destNodeId });
          delivered++;
        }
      }
    }
    return { received, delivered, refetched };
  }

  /**
   * After two TTLs without a receipt, report 'expired' (not proof of
   * non-delivery).
   */
  private _expire(): void {
    const now = this.clock();
    this.state.outbox = this.state.outbox.filter((o) => {
      if (o.storedAt + 2 * this.ttlMs > now) return true;
      this.emit('expired', { localId: o.localId, destNodeId: o.destNodeId });
      return false;
    });
    for (const [id, exp] of Object.entries(this.state.seen)) if (exp <= now) delete this.state.seen[id];
  }

  // ── persistence ──────────────────────────────────

  private _seal2(data: Buffer): Buffer {
    if (!this.key) return data;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from('gmp-sf-client-v2'));
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  private _load(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    let parsed: PersistedState;
    try {
      let raw = fs.readFileSync(this.stateFile);
      if (this.key) {
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
        d.setAAD(Buffer.from('gmp-sf-client-v2'));
        d.setAuthTag(raw.subarray(12, 28));
        raw = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
      }
      parsed = JSON.parse(raw.toString('utf8')) as PersistedState;
    } catch (e) {
      this._onUnreadableState(e as Error);
      return;
    }
    if (parsed && parsed.v === 2) this.state = parsed;
  }

  /**
   * The state file cannot be opened (e.g. the seed changed). It holds the
   * outbox and contacts, so it is never discarded: strict hosts refuse; others
   * move it aside, log an ERROR, and start fresh.
   */
  private _onUnreadableState(error: Error): void {
    const file = this.stateFile as string;
    const loses = 'store-and-forward state: contacts, the unsent outbox, pending receipts, fetch cursors and the seen-set. Under a changed seed it belonged to the old identity; otherwise, messages already received may be fetched again.';
    if (this.strictState) {
      throw refuse({ what: `the store-and-forward state could not be opened (${error.message}).`, file, action: 'move-aside', loses });
    }
    const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let moved = true;
    try { fs.renameSync(file, aside); } catch { moved = false; }
    logger.error('store-forward', 'state-unreadable', `Store-and-forward state could not be opened; ${moved ? `moved aside to ${aside}` : 'left in place (could not move it)'} and starting fresh: ${error.message}`, { err: error.message, stateFile: file, movedTo: moved ? aside : null });
  }

  private _save(): void {
    if (!this.stateFile) return;
    writeFileAtomicSync(this.stateFile, this._seal2(Buffer.from(JSON.stringify(this.state))));
  }
}
