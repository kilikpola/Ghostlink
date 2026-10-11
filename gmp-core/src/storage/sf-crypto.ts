/**
 * Sealed store-and-forward: addressing and sealing.
 *
 * ── Buckets ─────────────────────────────────────────────────────────────
 *
 *   sharedSecret = HKDF-SHA256(X25519(s_A, s_B), salt = sort(N_A, N_B), "gmp-sf-shared-v1")
 *   offset       = HKDF(sharedSecret, "gmp-sf-epoch-offset-v1" || N_recipient) mod 86400
 *   epoch        = floor((unixSeconds + offset) / 86400)
 *   tag          = HKDF(sharedSecret, "gmp-sf-tag-v1" || N_recipient || u64 epoch)   32 bytes
 *   bucket       = top log2(bucketCount) bits of HKDF(sharedSecret, "gmp-sf-bucket-v1" || N_recipient)
 *                  (no epoch term: fixed per direction for the pair's lifetime)
 *
 * The recipient's NodeID makes A->B and B->A separate channels. The host sees
 * only the bucket; the tag travels inside the sealed blob.
 *
 * bucketCount is pinned per release (RELEASE_BUCKET_SCHEDULE) so every client
 * derives the same buckets.
 *
 * ── Sealing ─────────────────────────────────────────────────────────────
 *
 *   e      = fresh X25519 keypair per blob
 *   key    = HKDF-SHA256(X25519(e, R_static), salt = e.pub || R_static.pub, "gmp-sf-seal-v1")
 *   blob   = e.pub (32) || AES-256-GCM tag (16) || ciphertext
 *   inner  = u32 innerLen || tag (32) || receiptSecret (32) || senderNodeId (64) || payload || zero padding
 *
 * Every blob is exactly one at-rest size: 4 KiB, 64 KiB or 1 MiB. The sender
 * is only inside the ciphertext. receiptSecret comes back in a sealed receipt
 * blob to prove delivery.
 *
 * No forward secrecy against later compromise of the recipient's static key.
 */

import crypto from 'crypto';
import { x25519 } from '@noble/curves/ed25519';

export const STORAGE_BUCKETS = [4096, 65536, 1048576] as const;
/**
 * Bucket counts by release, each effective from a UTC epoch-ms instant. The
 * previous entry stays active for one TTL. Entries are append-only.
 */
export interface BucketEpoch {
  bucketCount: number;
  from: number;
}
/** One bucket at launch: every client fetches every blob. See docs/store-and-forward.md. */
export const RELEASE_BUCKET_SCHEDULE: readonly BucketEpoch[] = Object.freeze([{ bucketCount: 1, from: 0 }]);
export const RELEASE_BUCKET_COUNT = RELEASE_BUCKET_SCHEDULE[RELEASE_BUCKET_SCHEDULE.length - 1].bucketCount;
export const DEFAULT_BUCKET_COUNT = RELEASE_BUCKET_COUNT;

/** Bucket counts to fetch under at `nowMs`: current, plus the previous for one TTL. */
export function activeBucketCounts(nowMs: number, ttlMs: number, schedule: readonly BucketEpoch[] = RELEASE_BUCKET_SCHEDULE): number[] {
  let i = -1;
  for (let k = 0; k < schedule.length; k++) if (schedule[k].from <= nowMs) i = k;
  if (i < 0) return [schedule[0].bucketCount];
  const out = [schedule[i].bucketCount];
  if (i > 0 && nowMs < schedule[i].from + ttlMs && schedule[i - 1].bucketCount !== schedule[i].bucketCount) out.push(schedule[i - 1].bucketCount);
  return out;
}

/** The current bucket count at `nowMs` — the one senders deposit under. */
export function currentBucketCount(nowMs: number, schedule: readonly BucketEpoch[] = RELEASE_BUCKET_SCHEDULE): number {
  return activeBucketCounts(nowMs, 0, schedule)[0];
}

/** Largest bucket id range any active derivation can produce. */
export function maxActiveBucketCount(nowMs: number, ttlMs: number, schedule: readonly BucketEpoch[] = RELEASE_BUCKET_SCHEDULE): number {
  return Math.max(...activeBucketCounts(nowMs, ttlMs, schedule));
}
const SEAL_OVERHEAD = 32 + 16;
const INNER_HEADER = 4 + 32 + 32 + 64;
export const MAX_SF_PAYLOAD = STORAGE_BUCKETS[STORAGE_BUCKETS.length - 1] - SEAL_OVERHEAD - INNER_HEADER;
const DAY = 86400;

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, len = 32): Buffer =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, typeof info === 'string' ? Buffer.from(info) : info, len));

/** A bucketCount must be a power of two between 2 and 2^24. */
export function bucketBits(bucketCount: number): number {
  const bits = Math.log2(bucketCount);
  if (!Number.isInteger(bits) || bits < 0 || bits > 24) {
    throw new Error(`bucketCount must be a power of two between 1 and 2^24, got ${bucketCount}`);
  }
  return bits;
}

/** The secret one pair of identities shares for store-and-forward. Symmetric. */
export function pairSecret(localStaticPriv: Uint8Array, localNodeId: Uint8Array, remoteStaticPub: Uint8Array, remoteNodeId: Uint8Array): Buffer {
  const dh = x25519.getSharedSecret(localStaticPriv, remoteStaticPub);
  const [a, b] = [Buffer.from(localNodeId), Buffer.from(remoteNodeId)].sort(Buffer.compare);
  return hkdf(dh, Buffer.concat([a, b]), 'gmp-sf-shared-v1');
}

/** Seconds added to the clock before the day boundary, per channel. */
export function epochOffset(sharedSecret: Uint8Array, recipientNodeId: Uint8Array): number {
  const out = hkdf(sharedSecret, Buffer.alloc(0), Buffer.concat([Buffer.from('gmp-sf-epoch-offset-v1'), Buffer.from(recipientNodeId)]), 8);
  return Number(out.readBigUInt64BE(0) % BigInt(DAY));
}

export function epochAt(unixSeconds: number, offset: number): number {
  return Math.floor((unixSeconds + offset) / DAY);
}

export function channelTag(sharedSecret: Uint8Array, recipientNodeId: Uint8Array, epoch: number): Buffer {
  const e = Buffer.alloc(8);
  e.writeBigUInt64BE(BigInt(epoch), 0);
  return hkdf(sharedSecret, Buffer.alloc(0), Buffer.concat([Buffer.from('gmp-sf-tag-v1'), Buffer.from(recipientNodeId), e]));
}

/** Fixed per-direction bucket key; no epoch term, so daily samples cannot be intersected. */
export function channelBucketKey(sharedSecret: Uint8Array, recipientNodeId: Uint8Array): Buffer {
  return hkdf(sharedSecret, Buffer.alloc(0), Buffer.concat([Buffer.from('gmp-sf-bucket-v1'), Buffer.from(recipientNodeId)]));
}

/** The top log2(bucketCount) bits of a 32-byte key. The only thing the storage host ever sees. */
export function bucketOf(tag: Uint8Array, bucketCount: number = DEFAULT_BUCKET_COUNT): number {
  if (bucketCount === 1) return 0;
  const bits = bucketBits(bucketCount);
  return Number(BigInt('0x' + Buffer.from(tag).subarray(0, 4).toString('hex')) >> BigInt(32 - bits));
}

/** Everything about one direction of one pair that a poller or sender needs. */
export class Channel {
  readonly offset: number;
  private readonly secret: Buffer;
  private readonly recipient: Buffer;

  constructor(sharedSecret: Uint8Array, recipientNodeId: Uint8Array) {
    this.secret = Buffer.from(sharedSecret);
    this.recipient = Buffer.from(recipientNodeId);
    this.offset = epochOffset(this.secret, this.recipient);
  }

  epoch(unixSeconds: number): number {
    return epochAt(unixSeconds, this.offset);
  }

  tag(epoch: number): Buffer {
    return channelTag(this.secret, this.recipient, epoch);
  }

  /** This direction's bucket: fixed for the pair's lifetime. */
  bucket(bucketCount: number): number {
    return bucketOf(channelBucketKey(this.secret, this.recipient), bucketCount);
  }
}

export function storageBucketFor(payloadLength: number): number | null {
  const need = payloadLength + SEAL_OVERHEAD + INNER_HEADER;
  return STORAGE_BUCKETS.find((b) => need <= b) ?? null;
}

export interface SealedInner {
  tag: Buffer;
  receiptSecret: Buffer;
  senderNodeId: Buffer;
  payload: Buffer;
}

const sealKey = (shared: Uint8Array, ePub: Uint8Array, rPub: Uint8Array): Buffer =>
  hkdf(shared, Buffer.concat([Buffer.from(ePub), Buffer.from(rPub)]), 'gmp-sf-seal-v1');
const ZERO_IV = Buffer.alloc(12);

/** Seal to the recipient's static X25519 key; the result is exactly one storage bucket long. */
export function sealBlob(recipientStaticPub: Uint8Array, inner: SealedInner): Buffer {
  const size = storageBucketFor(inner.payload.length);
  if (size === null) throw new Error(`Payload of ${inner.payload.length} bytes exceeds the largest storage bucket`);
  const plain = Buffer.alloc(size - SEAL_OVERHEAD);
  plain.writeUInt32BE(inner.payload.length, 0);
  inner.tag.copy(plain, 4);
  inner.receiptSecret.copy(plain, 36);
  inner.senderNodeId.copy(plain, 68);
  inner.payload.copy(plain, INNER_HEADER);
  const ePriv = x25519.utils.randomPrivateKey();
  const ePub = x25519.getPublicKey(ePriv);
  // The key is unique per blob (fresh e), so a fixed IV never repeats under it.
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(x25519.getSharedSecret(ePriv, recipientStaticPub), ePub, recipientStaticPub), ZERO_IV);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(ePub), cipher.getAuthTag(), ct]);
}

/** Null when the blob is not sealed to this key (or was altered). */
export function openBlob(recipientStaticPriv: Uint8Array, recipientStaticPub: Uint8Array, blob: Buffer): SealedInner | null {
  if (!(STORAGE_BUCKETS as readonly number[]).includes(blob.length)) return null;
  const ePub = blob.subarray(0, 32);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(recipientStaticPriv, ePub);
  } catch {
    return null;
  }
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(shared, ePub, recipientStaticPub), ZERO_IV);
    d.setAuthTag(blob.subarray(32, 48));
    const plain = Buffer.concat([d.update(blob.subarray(48)), d.final()]);
    const len = plain.readUInt32BE(0);
    if (INNER_HEADER + len > plain.length) return null;
    return {
      tag: plain.subarray(4, 36),
      receiptSecret: plain.subarray(36, 68),
      senderNodeId: plain.subarray(68, 132),
      payload: plain.subarray(INNER_HEADER, INNER_HEADER + len),
    };
  } catch {
    return null;
  }
}
