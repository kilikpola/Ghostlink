/**
 * What this build can actually do. Features that cannot be relied on are
 * disabled here and the control says why.
 *
 * Mirrors mobile/src/utils/capabilities.js. Keep the two in step.
 */
(function (exports) {
  'use strict';

  /**
   * The manual Yggdrasil / Ghost Mesh setup dialog. Its address derivation
   * (SHA-512 of an X25519 key; Yggdrasil uses Ed25519) is unverified against a
   * real node. Disabled until checked with `yggdrasilctl getSelf`; the
   * derivation is kept in CryptoEngine.deriveLegacyYggdrasilIP.
   */
  var MESH_SETUP_AVAILABLE = false;

  var MESH_SETUP_UNAVAILABLE_REASON =
    'Yggdrasil setup is unverified against a real node and is disabled.';

  /**
   * Guardian (Shamir) social recovery over the network. Disabled on both sides
   * until a transport delivers, stores and returns fragments; manual copy and
   * paste still works.
   *
   * Mirrors GUARDIAN_RECOVERY_AVAILABLE in mobile/src/utils/capabilities.js.
   */
  var GUARDIAN_RECOVERY_AVAILABLE = false;

  var GUARDIAN_RECOVERY_UNAVAILABLE_REASON =
    'Sending recovery fragments to peers is disabled: peers cannot store them yet';

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.Capabilities = {
    MESH_SETUP_AVAILABLE: MESH_SETUP_AVAILABLE,
    MESH_SETUP_UNAVAILABLE_REASON: MESH_SETUP_UNAVAILABLE_REASON,
    GUARDIAN_RECOVERY_AVAILABLE: GUARDIAN_RECOVERY_AVAILABLE,
    GUARDIAN_RECOVERY_UNAVAILABLE_REASON: GUARDIAN_RECOVERY_UNAVAILABLE_REASON
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
