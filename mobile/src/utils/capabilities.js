/**
 * GhostLink Mobile — what this build can actually do. Each flag is false
 * because the path behind it is known-broken; flip it here and the UI follows.
 */

/**
 * Voice and video calls: no rendezvous for the direct path, no media-capable
 * peer connection on the mesh path, and CallScreen renders placeholders.
 */
export const CALLS_AVAILABLE = false;

/** Shown on a disabled call control, and used as its accessibility label. */
export const CALLS_UNAVAILABLE_REASON =
  'Calls unavailable until direct connection is supported';

/**
 * The Ghost Mesh setup modal: its verification needs react-native-quick-crypto,
 * which is not in this build (CryptoService throws on use).
 */
export const MESH_SETUP_AVAILABLE = false;

export const MESH_SETUP_UNAVAILABLE_REASON =
  'Ghost Mesh setup is unavailable in this build';

/**
 * Guardian (Shamir) social recovery: no transport reaches a guardian yet.
 * Fragments are never stored on this device either way; they are generated on
 * demand in RecoveryScreen for the user to hand out.
 */
export const GUARDIAN_RECOVERY_AVAILABLE = false;

export const GUARDIAN_RECOVERY_UNAVAILABLE_REASON =
  'Guardian recovery needs a peer connection, which this build cannot make yet';
