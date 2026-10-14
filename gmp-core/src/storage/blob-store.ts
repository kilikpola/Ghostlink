/**
 * The storage host's disk: one sealed file per blob, written atomically and
 * hard-deleted (removeFileDurableSync), since expiry must not leave data on
 * disk the way an append-only log would.
 *
 * Blobs leave only by TTL expiry (default 7 days) or eviction of the
 * OLDEST-DEPOSITED blob (lowest seq) past maxBlobsPerBucket / maxBytesPerBucket.
 * Reads never change eviction order, so a flooder cannot keep its own blobs
 * alive by re-fetching them. No client can delete a blob or report reading one.
 *
 * Sequence numbers (fetch cursors) strictly increase across restarts:
 * max(last + 1, clock-ms x 1000).
 *
 * Files are AES-256-GCM sealed under a seed-derived key. The in-memory index
 * is rebuilt on start; unopenable files are counted, never deleted.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeFileAtomicSync, removeFileDurableSync, cleanStaleTempFiles } from '../atomic-file.js';

const AAD = Buffer.from('gmp-sf-store-v2');

export interface BlobMeta {
  blobId: string;
  bucket: number;
  seq: number;
  size: number;
  storedAt: number;
  expiresAt: number;
  lastAccess: number;
}

export interface BlobStoreOptions {
  dir: string;
  ttlMs: number;
  maxBlobsPerBucket: number;
  maxBytesPerBucket: number;
  encryptionKey?: Buffer | null;
  clock?: () => number;
}

export class BlobStore {
  readonly dir: string;
  readonly ttlMs: number;
  readonly maxBlobs: number;
  readonly maxBytes: number;
  private readonly key: Buffer | null;
  clock: () => number;
  private readonly blobs = new Map<string, BlobMeta>();
  private readonly byBucket = new Map<number, Set<string>>();
  private lastSeq = 0;
  /** Files present on disk that did not open under this key. Kept, not deleted. */
  unreadable = 0;
  evictions = 0;
  expiries = 0;

  constructor(o: BlobStoreOptions) {
    this.dir = o.dir;
    this.ttlMs = o.ttlMs;
    this.maxBlobs = o.maxBlobsPerBucket;
    this.maxBytes = o.maxBytesPerBucket;
    this.key = o.encryptionKey ?? null;
    this.clock = o.clock ?? (() => Date.now());
  }

  private get blobDir(): string { return path.join(this.dir, 'blobs'); }
  private blobPath(id: string): string { return path.join(this.blobDir, `${id}.blob`); }

  private seal(data: Buffer): Buffer {
    if (!this.key) return data;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  private unseal(data: Buffer): Buffer | null {
    if (!this.key) return data;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      d.setAAD(AAD);
      d.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([d.update(data.subarray(28)), d.final()]);
    } catch {
      return null;
    }
  }

  private static pack(meta: object, body: Buffer): Buffer {
    const json = Buffer.from(JSON.stringify(meta));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(json.length, 0);
    return Buffer.concat([head, json, body]);
  }

  private static unpack(data: Buffer): { meta: Record<string, unknown>; body: Buffer } | null {
    if (data.length < 4) return null;
    const len = data.readUInt32BE(0);
    if (4 + len > data.length) return null;
    try {
      return { meta: JSON.parse(data.subarray(4, 4 + len).toString('utf8')), body: data.subarray(4 + len) };
    } catch {
      return null;
    }
  }

  /** Rebuild the index from disk. */
  load(): this {
    fs.mkdirSync(this.blobDir, { recursive: true });
    for (const name of fs.readdirSync(this.blobDir)) {
      if (!name.endsWith('.blob')) continue;
      const raw = this.unseal(fs.readFileSync(path.join(this.blobDir, name)));
      const u = raw && BlobStore.unpack(raw);
      if (!u) { this.unreadable++; continue; }
      const m = u.meta as unknown as BlobMeta;
      this.index(m);
      this.lastSeq = Math.max(this.lastSeq, m.seq);
    }
    cleanStaleTempFiles(this.blobPath('x'));
    this.sweep();
    return this;
  }

  private index(m: BlobMeta): void {
    this.blobs.set(m.blobId, m);
    let set = this.byBucket.get(m.bucket);
    if (!set) this.byBucket.set(m.bucket, (set = new Set()));
    set.add(m.blobId);
  }

  private unindex(id: string): void {
    const m = this.blobs.get(id);
    if (!m) return;
    this.blobs.delete(id);
    const set = this.byBucket.get(m.bucket);
    if (set) { set.delete(id); if (set.size === 0) this.byBucket.delete(m.bucket); }
  }

  /** The next sequence number, and the cursor a fetch made now would end at. */
  currentSeq(): number {
    return Math.max(this.lastSeq, this.clock() * 1000);
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, this.clock() * 1000);
    return this.lastSeq;
  }

  /**
   * Store one blob. When the bucket is full, evicts the OLDEST-DEPOSITED blob
   * (lowest seq) to make room — not the least-recently-read. At bucketCount=1
   * every client fetches every blob, so reads say nothing about delivery; a
   * flooder could otherwise keep its own junk alive by re-fetching it. Deposit
   * order cannot be refreshed by reads, so a flooder's blobs age out like any
   * other and honest blobs are not evicted first.
   */
  put(bucket: number, blob: Buffer): { blobId: string; expiresAt: number; evicted: string[] } {
    this.sweep();
    const now = this.clock();
    const evicted: string[] = [];
    for (;;) {
      const list = [...(this.byBucket.get(bucket) ?? [])].map((id) => this.blobs.get(id)!);
      const bytes = list.reduce((n, m) => n + m.size, 0);
      if (list.length === 0 || (list.length < this.maxBlobs && bytes + blob.length <= this.maxBytes)) break;
      const oldest = list.reduce((a, b) => (b.seq < a.seq ? b : a));
      this.hardDelete(oldest.blobId);
      this.evictions++;
      evicted.push(oldest.blobId);
    }
    const meta: BlobMeta = {
      blobId: crypto.randomBytes(16).toString('hex'),
      bucket,
      seq: this.nextSeq(),
      size: blob.length,
      storedAt: now,
      expiresAt: now + this.ttlMs,
      lastAccess: now,
    };
    writeFileAtomicSync(this.blobPath(meta.blobId), this.seal(BlobStore.pack(meta, blob)));
    this.index(meta);
    return { blobId: meta.blobId, expiresAt: meta.expiresAt, evicted };
  }

  /** Blobs in a bucket deposited after `since` (sequence number), oldest first. */
  list(bucket: number, since = 0): BlobMeta[] {
    this.sweep();
    return [...(this.byBucket.get(bucket) ?? [])]
      .map((id) => ({ ...this.blobs.get(id)! }))
      .filter((m) => m.seq > since)
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * The stored blob bytes. Reading does NOT change the blob's eviction position:
   * eviction is by deposit order (seq), so re-fetching cannot keep a blob alive.
   */
  read(blobId: string): Buffer | null {
    const m = this.blobs.get(blobId);
    if (!m) return null;
    const raw = this.unseal(fs.readFileSync(this.blobPath(blobId)));
    const u = raw && BlobStore.unpack(raw);
    if (!u) return null;
    return u.body;
  }

  private hardDelete(blobId: string): void {
    this.unindex(blobId);
    removeFileDurableSync(this.blobPath(blobId));
  }

  /** Hard-delete every expired blob. */
  sweep(): void {
    const now = this.clock();
    for (const m of [...this.blobs.values()]) {
      if (m.expiresAt <= now) { this.hardDelete(m.blobId); this.expiries++; }
    }
  }

  stats(): { blobs: number; bytes: number; buckets: number; evictions: number; expiries: number } {
    let bytes = 0;
    for (const m of this.blobs.values()) bytes += m.size;
    return { blobs: this.blobs.size, bytes, buckets: this.byBucket.size, evictions: this.evictions, expiries: this.expiries };
  }

  /** Where a blob's file lives (tests: prove hard delete). */
  fileFor(blobId: string): string {
    return this.blobPath(blobId);
  }
}
