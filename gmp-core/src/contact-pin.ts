/**
 * Contact identity pinning.
 *
 * A Ghost Address carries only 45 bits (ghost-address.ts), so it is a lookup
 * hint, never an authenticator. A contact is therefore identified by the FULL
 * 128-hex NodeID that resolution returned. Once pinned, a later connection,
 * message or resolution that presents a DIFFERENT NodeID for that contact must
 * not be merged in and must not silently replace the pin.
 *
 * The one exception is a legitimate key rotation: a rotation certificate the
 * existing KeyRotationManager verified as signed by the pinned identity
 * (key-rotation.ts) links old -> new. The caller passes that outcome as
 * `rotationVerified`; this module writes no rotation-verification crypto of its
 * own.
 *
 * The decision is a pure function so the UI calls it but tests exercise it
 * without the client. TOFU note: an existing contact with no pinned NodeID is
 * pinned on its next authenticated presentation — trust-on-first-use, which
 * cannot detect a pre-existing impersonation, only lock identity from first
 * contact forward.
 */

import logger from './logger.js';

export type PinDecision =
  | 'accept'      // matches the pin, or TOFU first-pin (no prior pin)
  | 'update-pin'  // differs, but a verified rotation links pinned -> presented
  | 'mismatch';   // differs with no verified rotation: do not merge, warn

function normId(id: string | null | undefined): string {
  return (id ?? '').trim().toLowerCase();
}

export interface PinInputs {
  /** The full NodeID already pinned for this contact, or null if none yet (TOFU). */
  pinnedNodeId: string | null;
  /** The full NodeID presented now (from a connection, message or resolution). */
  presentedNodeId: string;
  /** True iff KeyRotationManager verified a rotation from pinned -> presented. */
  rotationVerified: boolean;
}

/**
 * Pure pin decision. No side effects, fully deterministic in its inputs.
 */
export function decidePin({ pinnedNodeId, presentedNodeId, rotationVerified }: PinInputs): PinDecision {
  const presented = normId(presentedNodeId);
  if (!presented) throw new Error('decidePin: presentedNodeId is required');
  const pinned = pinnedNodeId ? normId(pinnedNodeId) : null;
  if (!pinned) return 'accept';            // TOFU: nothing pinned yet
  if (pinned === presented) return 'accept';
  return rotationVerified ? 'update-pin' : 'mismatch';
}

/**
 * The entry point the UI calls. Returns the same decision as decidePin, and on
 * a mismatch logs `contact-key-mismatch` unconditionally (NodeID prefixes only,
 * never key material) so the firing always leaves a record. The UI uses the
 * returned decision to accept, re-pin, or surface the mismatch warning.
 */
export function pinOnPresented(inputs: PinInputs): PinDecision {
  const decision = decidePin(inputs);
  if (decision === 'mismatch') {
    logger.warn('contact', 'contact-key-mismatch',
      'A contact presented a different identity key than the one pinned; not merging',
      { pinned: normId(inputs.pinnedNodeId).slice(0, 16), presented: normId(inputs.presentedNodeId).slice(0, 16) });
  }
  return decision;
}
