/**
 * Sealed store-and-forward wire messages, on a hop link to a storage host.
 * Plaintext layout:
 *
 *   [u32 BE control length][control: UTF-8 JSON][tail: raw bytes, may be empty]
 *
 *   STORE_REQUEST  0x11  { requestId, bucket }                            tail = sealed blob
 *   STORE_ACK      0x12  { requestId, ok: true, expiresAt } | { requestId, ok: false, reason }
 *   FETCH_REQUEST  0x13  { requestId, buckets: [{ bucket, since }, ... exactly fetchBuckets] }
 *   FETCH_RESPONSE 0x14  { requestId, blobId, bucket, seq }                tail = sealed blob
 *                        ... one frame per blob with seq > since, then
 *                        { requestId, done: true, seq, truncated } | { requestId, done: true, error }
 *   0x15                 retired; ignored on receipt, never reused.
 *
 * The host reads bucket ids, cursors and fixed-size opaque blobs only. blobId
 * flows host -> client only.
 */

export type StorageReason =
  | 'storage-disabled'
  | 'malformed'
  | 'bad-size'
  | 'bad-bucket'
  | 'bad-fetch-size'
  | 'rate-limited'
  | 'store-failed';

export const STORAGE_REASONS: readonly StorageReason[] = [
  'storage-disabled', 'malformed', 'bad-size', 'bad-bucket', 'bad-fetch-size',
  'rate-limited', 'store-failed',
];

export class StorageError extends Error {
  readonly reason: StorageReason | 'closed' | 'wrong-host';

  constructor(reason: StorageReason | 'closed' | 'wrong-host', message?: string) {
    super(message || `Storage refused: ${reason}`);
    this.name = 'StorageError';
    this.reason = reason;
  }
}

export type Control = Record<string, unknown>;

/** Largest control part accepted; controls are a few hundred bytes. */
const MAX_CONTROL_BYTES = 64 * 1024;

export function encodeStorage(control: Control, tail: Uint8Array | null = null): Buffer {
  const json = Buffer.from(JSON.stringify(control), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return tail && tail.length ? Buffer.concat([head, json, Buffer.from(tail)]) : Buffer.concat([head, json]);
}

/** Null for anything that is not a well-formed control object. */
export function decodeStorage(plaintext: Buffer): { control: Control; tail: Buffer } | null {
  if (plaintext.length < 4) return null;
  const len = plaintext.readUInt32BE(0);
  if (len > MAX_CONTROL_BYTES || 4 + len > plaintext.length) return null;
  let control: unknown;
  try {
    control = JSON.parse(plaintext.subarray(4, 4 + len).toString('utf8'));
  } catch {
    return null;
  }
  if (!control || typeof control !== 'object' || Array.isArray(control)) return null;
  return { control: control as Control, tail: plaintext.subarray(4 + len) };
}

export const isHex = (v: unknown, bytes: number): v is string =>
  typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
