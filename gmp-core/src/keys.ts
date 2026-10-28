/**
 * Purpose subkeys of the mesh seed (identity-v2.md §2 keys #32-34, §5).
 *
 *   derivePurposeKey(meshSeed, purpose)
 *     = HKDF-SHA256(ikm = mesh seed, salt = none, info = purpose label, 32 bytes)
 *
 * "salt = none" is §5's choice; RFC 5869 then uses 32 zero bytes. The mesh
 * seed is identity.ts's PBKDF2 output (key #13), which this module does not
 * derive or change. Purpose is a closed set: only §5's mesh-seed labels, so no
 * caller can invent a label. Only purpose keys leave this module; the seed is
 * never returned, stored or written anywhere.
 *
 * @noble/hashes only (no node built-ins), so the same file runs in Node,
 * Electron main and, later, React Native.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

/** The §5 labels whose input key material is the mesh seed. */
export const Purpose = Object.freeze({
  /** #32: message history at rest. */
  HISTORY: 'gl-history-v2',
  /** #33: workspace keys; browser-build contacts, pins, verified NodeIDs. */
  STATE: 'gl-state-v2',
  /** #34: sealing ratchet state at rest. */
  RATCHET_SEAL: 'gl-ratchet-seal-v1',
} as const);

export type Purpose = (typeof Purpose)[keyof typeof Purpose];

const PURPOSE_LABELS: ReadonlySet<string> = new Set(Object.values(Purpose));
const MESH_SEED_LENGTH = 32;
const PURPOSE_KEY_LENGTH = 32;

export function derivePurposeKey(meshSeed: Uint8Array, purpose: Purpose): Uint8Array {
  if (!(meshSeed instanceof Uint8Array) || meshSeed.length !== MESH_SEED_LENGTH) {
    throw new Error(`derivePurposeKey: the mesh seed must be ${MESH_SEED_LENGTH} bytes`);
  }
  // The type already restricts callers; this stops a cast or a JS caller.
  if (!PURPOSE_LABELS.has(purpose)) {
    throw new Error('derivePurposeKey: not a Purpose label');
  }
  return hkdf(sha256, meshSeed, undefined, purpose, PURPOSE_KEY_LENGTH);
}
