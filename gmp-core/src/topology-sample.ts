/**
 * Which slice of its peer set a node shows one requester. Topology announces
 * and peer-exchange answers carry a sample, never the full set.
 *
 * The sample is the `size` candidates whose cached SHA-256 position is
 * nearest (XOR) to HMAC(secret, epoch | requesterKey):
 * - Stable within an epoch for a given address key, whatever identity is used.
 * - Learning all N members needs ~ (N/size)·ln N distinct address keys.
 * - `secret` derives from the node's identity, so restarts do not reshuffle.
 */
import crypto from 'crypto';
import { addressKey } from './rate-limiter.js';

/** A requester's sample key: IPv4 exact, IPv6 /48 (see addressKey in rate-limiter.ts). */
export function requesterKey(link: { socket?: { remoteAddress?: string | null; isRelayed?: boolean } | null }): string {
  // A relayed session has no address; every relayed requester shares one
  // sample, which is stricter than per-address, never looser.
  if (!link.socket || link.socket.isRelayed) return 'relayed';
  return addressKey(link.socket.remoteAddress ?? null, 48);
}

export class PeerSampler {
  /** 64-bit position of each candidate, as two 32-bit halves; computed once per NodeID. */
  private readonly positions = new Map<string, [number, number]>();
  /** 64-bit point of each requester key, for the current epoch only. */
  private readonly points = new Map<string, [number, number]>();
  private pointsEpoch = -1;

  constructor(
    private readonly secret: Buffer,
    private readonly epochMs: () => number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Derive the sampler secret from the node's signing key (stable across restarts). */
  static secretFrom(signingPrivKey: Uint8Array): Buffer {
    return crypto.createHmac('sha256', Buffer.from(signingPrivKey)).update('gmp-topology-sample-v1').digest();
  }

  epoch(): number {
    return Math.floor(this.clock() / Math.max(1, this.epochMs()));
  }

  private _position(id: string): [number, number] {
    let p = this.positions.get(id);
    if (!p) {
      const h = crypto.createHash('sha256').update(id).digest();
      p = [h.readUInt32BE(0), h.readUInt32BE(4)];
      if (this.positions.size > 100_000) this.positions.clear();
      this.positions.set(id, p);
    }
    return p;
  }

  private _point(key: string): [number, number] {
    const epoch = this.epoch();
    if (epoch !== this.pointsEpoch) { this.points.clear(); this.pointsEpoch = epoch; }
    let pt = this.points.get(key);
    if (!pt) {
      const h = crypto.createHmac('sha256', this.secret).update(`${epoch}|${key}`).digest();
      pt = [h.readUInt32BE(0), h.readUInt32BE(4)];
      if (this.points.size > 100_000) this.points.clear();
      this.points.set(key, pt);
    }
    return pt;
  }

  /**
   * The `size` candidates nearest (XOR) to the key's per-epoch point: one HMAC
   * per key per epoch, cached hashes per candidate.
   */
  pick<T>(key: string, candidates: readonly T[], idOf: (t: T) => string, size: number): T[] {
    if (size <= 0 || candidates.length === 0) return [];
    const [p0, p1] = this._point(key);
    // Keep the `size` smallest distances in a small sorted array.
    const best: { d0: number; d1: number; c: T }[] = [];
    for (const c of candidates) {
      const [q0, q1] = this._position(idOf(c));
      const d0 = (p0 ^ q0) >>> 0;
      const d1 = (p1 ^ q1) >>> 0;
      if (best.length === size) {
        const w = best[size - 1];
        if (d0 > w.d0 || (d0 === w.d0 && d1 >= w.d1)) continue;
      }
      let i = best.length;
      while (i > 0 && (best[i - 1].d0 > d0 || (best[i - 1].d0 === d0 && best[i - 1].d1 > d1))) i--;
      best.splice(i, 0, { d0, d1, c });
      if (best.length > size) best.pop();
    }
    return best.map((b) => b.c);
  }
}
