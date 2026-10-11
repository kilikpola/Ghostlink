/**
 * Ephemeral non-repetition: a repeated RNG output cannot produce a repeated
 * scalar.
 *
 *     ephemeral = HKDF( rngBytes(32) || bootCounter || processSequence , ctx )
 *
 * - `bootCounter` is monotonic and read from durable storage, never the RNG,
 *   so ephemerals differ across restarts.
 * - `processSequence` increments per keypair, so they differ within a run.
 *
 * Unilateral: it changes only how we choose our own scalar, not the wire.
 * Not covered: counter rollback from restored or cleared storage.
 */

import { generateEphemeralKeyPair, generateEphemeralIdentity } from '../identity.js';
import type { EphemeralKeypair, NodeIdentity } from '../types.js';

export class EphemeralKeySource {
  private readonly bootCounter: bigint;
  private sequence = 0n;

  /**
   * `bootCounter` must come from durable storage (advanceBootCounter). Durable
   * values start at 1, so 0 means "no counter" and is refused.
   */
  constructor(bootCounter: bigint) {
    if (typeof bootCounter !== 'bigint' || bootCounter < 1n) {
      throw new Error(`EphemeralKeySource needs a durable boot counter >= 1, got ${String(bootCounter)}: refusing to run without one (GM-M3-2')`);
    }
    this.bootCounter = bootCounter;
  }

  /** (bootCounter, next processSequence) as 16 bytes; shared by every draw. */
  private nextContext(): Buffer {
    const ctx = Buffer.alloc(16);
    ctx.writeBigUInt64BE(BigInt.asUintN(64, this.bootCounter), 0);
    ctx.writeBigUInt64BE(BigInt.asUintN(64, this.sequence), 8);
    this.sequence += 1n;
    return ctx;
  }

  /** A fresh keypair bound to (bootCounter, next processSequence). */
  next(): EphemeralKeypair {
    return generateEphemeralKeyPair(this.nextContext());
  }

  /** A throwaway hop identity bound to the same counter, so hops stay unlinkable. */
  nextIdentity(): NodeIdentity {
    return generateEphemeralIdentity(this.nextContext());
  }

  /** Diagnostics/tests: how many keypairs this source has produced. */
  get produced(): bigint {
    return this.sequence;
  }

  get boot(): bigint {
    return this.bootCounter;
  }
}
