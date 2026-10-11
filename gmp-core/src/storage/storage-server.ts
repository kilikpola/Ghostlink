/**
 * Storage host, server side:
 *
 *   STORE   bucket in the release range; blob exactly one at-rest size
 *           (4 KiB / 64 KiB / 1 MiB); one token from the depositor's subnet
 *           bucket.
 *   FETCH   exactly `fetchBuckets` distinct { bucket, since } entries with
 *           integer cursors. Returns blobs after each cursor, oldest first,
 *           at most `fetchMaxBlobs`, then the current sequence as next cursor.
 *   0x15    retired; ignored.
 */

import { MESSAGETYPES } from '../link/frame.js';
import type { GMPLink } from '../link/link.js';
import { subnetKey } from '../relay/relay-protocol.js';
import { SubnetTokenBucket } from '../relay/token-bucket.js';
import { STORAGE_BUCKETS, RELEASE_BUCKET_SCHEDULE, maxActiveBucketCount, type BucketEpoch } from './sf-crypto.js';
import { BlobStore } from './blob-store.js';
import { STORAGE_REASONS, decodeStorage, encodeStorage, type Control, type StorageReason } from './storage-protocol.js';

export interface StorageQuotas {
  fetchBuckets: number;
  fetchMaxBlobs: number;
  depositRatePerMinute: number;
  depositBurst: number;
}

export interface StorageStats {
  blobs: number;
  bytes: number;
  buckets: number;
  evictions: number;
  expiries: number;
  deposits: number;
  fetches: number;
  rejections: Record<string, number>;
}

export class StorageServer {
  readonly store: BlobStore;
  readonly quotas: StorageQuotas;
  clock: () => number = () => Date.now();
  /** Release-pinned; replaceable in tests. */
  bucketSchedule: readonly BucketEpoch[] = RELEASE_BUCKET_SCHEDULE;
  private readonly tokens: SubnetTokenBucket;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private deposits = 0;
  private fetches = 0;
  private readonly rejections: Record<string, number> = {};

  constructor(store: BlobStore, quotas: StorageQuotas) {
    this.store = store;
    this.quotas = quotas;
    for (const r of STORAGE_REASONS) this.rejections[r] = 0;
    this.tokens = new SubnetTokenBucket(
      () => ({ ratePerMinute: this.quotas.depositRatePerMinute, burst: this.quotas.depositBurst }),
      () => this.clock(),
    );
    // Expiry is a hard delete even when no one touches the store.
    this.sweepTimer = setInterval(() => { this.store.sweep(); this.tokens.sweep(); }, 60000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  getStats(): StorageStats {
    return { ...this.store.stats(), deposits: this.deposits, fetches: this.fetches, rejections: { ...this.rejections } };
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  handleFrame(link: GMPLink, type: number, plaintext: Buffer): void {
    const msg = decodeStorage(plaintext);
    const requestId = msg ? msg.control.requestId : undefined;
    if (type === MESSAGETYPES.STORE_REQUEST) {
      if (!msg) return this._ack(link, { requestId }, 'malformed');
      this._store(link, msg.control, msg.tail);
    } else if (type === MESSAGETYPES.FETCH_REQUEST) {
      if (!msg) return this._fetchError(link, requestId, 'malformed');
      this._fetch(link, msg.control);
    }
    // STORE_ACK / FETCH_RESPONSE are host -> client only; 0x15 is retired. Ignored.
  }

  private _validBucket(b: unknown): b is number {
    return Number.isInteger(b) && (b as number) >= 0
      && (b as number) < maxActiveBucketCount(this.clock(), this.store.ttlMs, this.bucketSchedule);
  }

  private _store(link: GMPLink, c: Control, blob: Buffer): void {
    const reply = { requestId: c.requestId };
    if (!this._validBucket(c.bucket)) return this._ack(link, reply, 'bad-bucket');
    if (!(STORAGE_BUCKETS as readonly number[]).includes(blob.length)) return this._ack(link, reply, 'bad-size');
    const subnet = subnetKey(link.socket ? link.socket.remoteAddress : null);
    if (!this.tokens.take(subnet)) return this._ack(link, reply, 'rate-limited');
    let res;
    try {
      res = this.store.put(c.bucket, Buffer.from(blob));
    } catch {
      this.tokens.refund(subnet);
      return this._ack(link, reply, 'store-failed');
    }
    this.deposits++;
    link.sendRelay(MESSAGETYPES.STORE_ACK, encodeStorage({ ...reply, ok: true, expiresAt: res.expiresAt }));
  }

  private _fetch(link: GMPLink, c: Control): void {
    const entries = c.buckets;
    // Exactly fetchBuckets entries, or every bucket while there are fewer (1 at launch).
    const expected = Math.min(this.quotas.fetchBuckets, maxActiveBucketCount(this.clock(), this.store.ttlMs, this.bucketSchedule));
    const ok = Array.isArray(entries) && entries.length === expected
      && entries.every((e) => e && typeof e === 'object' && this._validBucket((e as Control).bucket)
        && Number.isSafeInteger((e as Control).since) && ((e as Control).since as number) >= 0)
      && new Set(entries.map((e) => (e as Control).bucket)).size === entries.length;
    if (!ok) return this._fetchError(link, c.requestId, 'bad-fetch-size');
    this.fetches++;
    const seq = this.store.currentSeq();
    const metas = (entries as Array<{ bucket: number; since: number }>)
      .flatMap((e) => this.store.list(e.bucket, e.since))
      .sort((x, y) => x.seq - y.seq);
    const sent = metas.slice(0, this.quotas.fetchMaxBlobs);
    for (const m of sent) {
      const body = this.store.read(m.blobId);
      if (!body) continue;
      link.sendRelay(MESSAGETYPES.FETCH_RESPONSE, encodeStorage({ requestId: c.requestId, blobId: m.blobId, bucket: m.bucket, seq: m.seq }, body));
    }
    const truncated = metas.length > sent.length;
    link.sendRelay(MESSAGETYPES.FETCH_RESPONSE, encodeStorage({ requestId: c.requestId, done: true, seq, truncated }));
  }

  private _ack(link: GMPLink, reply: Control, reason: StorageReason): void {
    this.rejections[reason] = (this.rejections[reason] || 0) + 1;
    link.sendRelay(MESSAGETYPES.STORE_ACK, encodeStorage({ ...reply, ok: false, reason }));
  }

  private _fetchError(link: GMPLink, requestId: unknown, reason: StorageReason): void {
    this.rejections[reason] = (this.rejections[reason] || 0) + 1;
    link.sendRelay(MESSAGETYPES.FETCH_RESPONSE, encodeStorage({ requestId, done: true, error: reason }));
  }
}
