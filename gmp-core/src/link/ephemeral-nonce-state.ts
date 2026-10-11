/**
 * In-memory nonce state for one connection: used for our one-off relay hop
 * identities, and for every responder session until GMPLink promotes it to
 * the persisted NonceStore (see link.ts). Persisting claims for an identity
 * that never returns would only grow the store.
 *
 * Keeps I1 (per connection) and I2 from nonce-store.ts; nothing is persisted.
 * A closed store refuses further claims.
 */

import type { LinkNonceStore } from './link.js';

interface Entry {
  sendHighWater: number;
  recvHighWater: number;
}

export class EphemeralNonceState implements LinkNonceStore {
  readonly ephemeral = true;
  private claims = new Set<string>();
  private entries = new Map<string, Entry>();
  private closed = false;

  private static key(peerNodeId: Uint8Array, sessionKey: Uint8Array): string {
    return `${Buffer.from(peerNodeId).toString('hex')}:${Buffer.from(sessionKey).toString('hex')}`;
  }

  claimSessionKey(_peerNodeId: Uint8Array, sessionKeyFingerprint: string): { valid: boolean; reason?: string } {
    if (this.closed) return { valid: false, reason: 'ephemeral nonce state closed' };
    if (this.claims.has(sessionKeyFingerprint)) {
      return { valid: false, reason: 'session key already claimed on this connection' };
    }
    this.claims.add(sessionKeyFingerprint);
    return { valid: true };
  }

  updateCounters(peerNodeId: Uint8Array, sessionKey: Uint8Array, sendCounter: number, recvCounter: number): void {
    if (this.closed) return;
    const k = EphemeralNonceState.key(peerNodeId, sessionKey);
    const e = this.entries.get(k) ?? { sendHighWater: 0, recvHighWater: 0 };
    e.sendHighWater = Math.max(e.sendHighWater, sendCounter);
    e.recvHighWater = Math.max(e.recvHighWater, recvCounter);
    this.entries.set(k, e);
  }

  getEntry(peerNodeId: Uint8Array, sessionKey: Uint8Array): Entry | null {
    const e = this.entries.get(EphemeralNonceState.key(peerNodeId, sessionKey));
    return e ? { ...e } : null;
  }

  /** Claims plus counter entries currently held. */
  get size(): number {
    return this.claims.size + this.entries.size;
  }

  close(): void {
    this.closed = true;
    this.claims.clear();
    this.entries.clear();
  }
}
