/**
 * An EphemeralKeySource for tests that open a hop or storage session directly.
 * Production callers pass the node's own source.
 */

import { EphemeralKeySource } from '../../dist/link/ephemeral-source.js';

let n = 0n;

/** A distinct source per call, so two test hops never share a sequence. */
export function testEphemeralSource() {
  return new EphemeralKeySource(0x7e57_0000n + n++);
}

/** Spread into an opts object: `{ ...withSource() }`. */
export function withSource(extra = {}) {
  return { ephemeralSource: testEphemeralSource(), ...extra };
}
