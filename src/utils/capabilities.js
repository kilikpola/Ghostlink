/**
 * What this build can actually do. Features that cannot be relied on are
 * disabled here and the control says why.
 *
 * Mirrors mobile/src/utils/capabilities.js. Keep the two in step. The
 * desktop has no Yggdrasil setup dialog any more (removed with the unused
 * Ghost Mesh TCP listener, G0), so MESH_SETUP_* exists on mobile only.
 */
(function (exports) {
  'use strict';

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
    GUARDIAN_RECOVERY_AVAILABLE: GUARDIAN_RECOVERY_AVAILABLE,
    GUARDIAN_RECOVERY_UNAVAILABLE_REASON: GUARDIAN_RECOVERY_UNAVAILABLE_REASON
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
