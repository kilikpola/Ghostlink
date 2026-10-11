/**
 * Storage host, client side. Each StorageSession is one hop link under a
 * throwaway identity for a single deposit or poll. No timers: requests end on
 * the host's answer or when the link closes.
 */

import type { GMPLink } from '../link/link.js';
import { MESSAGETYPES } from '../link/frame.js';
import type { NodeIdentity } from '../types.js';
import type { GMPTransport } from '../transport/transport.js';
import { openHopLink, type RelayAddress } from '../relay/relay-client.js';
import type { EphemeralKeySource } from '../link/ephemeral-source.js';
import { StorageError, decodeStorage, encodeStorage, type Control } from './storage-protocol.js';

export type StorageAddress = RelayAddress;

export interface FetchedBlob {
  blobId: string;
  bucket: number;
  seq: number;
  blob: Buffer;
}

export interface FetchEntry {
  bucket: number;
  since: number;
}

export interface FetchResult {
  blobs: FetchedBlob[];
  /** The host's sequence number when it answered: the next cursor for every bucket fetched, unless truncated. */
  seq: number;
  truncated: boolean;
}

interface Pending {
  resolve: (c: Control) => void;
  reject: (e: Error) => void;
  blobs?: FetchedBlob[];
}

export class StorageSession {
  readonly link: GMPLink;
  readonly hopIdentity: NodeIdentity;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(link: GMPLink, hopIdentity: NodeIdentity) {
    this.link = link;
    this.hopIdentity = hopIdentity;
  }

  /** `opts.ephemeralSource` is required; see openHopLink. */
  static async open(
    transport: GMPTransport,
    addr: StorageAddress,
    opts: { pingIntervalMs?: number; pongTimeoutMs?: number; identity?: NodeIdentity; ephemeralSource: EphemeralKeySource },
  ): Promise<StorageSession> {
    let session: StorageSession | null = null;
    const { link, identity } = await openHopLink(transport, addr, (type, pt) => session?._onFrame(type, pt), opts);
    session = new StorageSession(link, identity);
    link.on('close', () => session!._onClosed());
    return session;
  }

  get hostNodeId(): string {
    return Buffer.from(this.link.remoteNodeId).toString('hex');
  }

  /** Deposit one sealed blob. Resolves on the host's STORE_ACK. */
  store(bucket: number, blob: Buffer): Promise<{ expiresAt: number }> {
    return this._request(MESSAGETYPES.STORE_REQUEST, { bucket }, blob).then((c) => {
      if (c.ok !== true) throw new StorageError((c.reason as never) || 'malformed');
      return { expiresAt: Number(c.expiresAt) };
    });
  }

  /** Blobs deposited after each entry's cursor. Entries are sent exactly as given. */
  fetch(entries: FetchEntry[]): Promise<FetchResult> {
    return this._request(MESSAGETYPES.FETCH_REQUEST, { buckets: entries.map((e) => ({ bucket: e.bucket, since: e.since })) }, null, true).then((c) => {
      if (c.error) throw new StorageError(c.error as never);
      return { blobs: (c.__blobs as FetchedBlob[]) || [], seq: Number(c.seq) || 0, truncated: c.truncated === true };
    });
  }

  close(): void {
    this.link.destroy();
  }

  private _request(type: number, control: Control, tail: Buffer | null = null, collect = false): Promise<Control> {
    if (this.closed) return Promise.reject(new StorageError('closed', 'Storage session is closed'));
    const requestId = this.nextId++;
    return new Promise<Control>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, ...(collect ? { blobs: [] } : {}) });
      try {
        this.link.sendRelay(type, encodeStorage({ ...control, requestId }, tail));
      } catch (e) {
        this.pending.delete(requestId);
        reject(e as Error);
      }
    });
  }

  /** @internal */
  _onFrame(type: number, plaintext: Buffer): void {
    const msg = decodeStorage(plaintext);
    if (!msg) return;
    const id = Number(msg.control.requestId);
    const p = this.pending.get(id);
    if (!p) return;
    if (type === MESSAGETYPES.STORE_ACK) {
      this.pending.delete(id);
      p.resolve(msg.control);
    } else if (type === MESSAGETYPES.FETCH_RESPONSE && p.blobs) {
      if (msg.control.done === true) {
        this.pending.delete(id);
        p.resolve({ ...msg.control, __blobs: p.blobs });
      } else if (typeof msg.control.blobId === 'string') {
        p.blobs.push({ blobId: msg.control.blobId, bucket: Number(msg.control.bucket), seq: Number(msg.control.seq), blob: Buffer.from(msg.tail) });
      }
    }
  }

  private _onClosed(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new StorageError('closed', 'Storage link closed'));
    this.pending.clear();
  }
}
