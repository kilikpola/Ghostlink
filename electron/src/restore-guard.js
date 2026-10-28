'use strict';
/**
 * Restoring an identity from its recovery phrase (identity-v2.md D11).
 *
 * The phrase is checked before anything happens: its NodeID is derived (no
 * node started, nothing written) and
 *   - if this device already holds a seed, the two FULL NodeIDs must match
 *     (never the 45-bit Ghost Addresses, D9) or the restore is refused;
 *   - on a fresh device, the user must first confirm the derived Ghost
 *     Address as theirs, and the confirmation names the NodeID it covers.
 * A stored seed this device cannot read (wrong keyring, corruption) is not a
 * fresh device: restore is refused unless the user takes the explicit replace
 * step (typing REPLACE_WORD), and then the old blob is moved aside, never
 * deleted; if that move fails nothing is stored and no node starts.
 * A LOCKED keyring or basic_text is neither: restore is refused outright with
 * the fix to apply, and REPLACE is never offered or accepted (contact-key.js).
 * Only then is the phrase persisted, and the node starts only if persisting
 * succeeded. A typo therefore can neither overwrite the stored seed nor start
 * a different identity.
 *
 * Kept free of Electron so test/restore-guard.test.mjs runs this exact code.
 */
const { REPLACE_WORD, LOCKED_REASON, INSECURE_REASON } = require('./contact-key');

/**
 * @param {object} deps
 * @param {(phrase: string) => Promise<{nodeIdHex: string, ghostAddress: string}>} deps.deriveIdentity
 * @param {() => string|null} deps.getStoredSeed
 * @param {(phrase: string) => boolean} deps.setStoredSeed  true once sealed and read back; throws otherwise
 * @param {(phrase: string) => Promise<void>} deps.startNode
 * @param {() => 'none'|'readable'|'locked'|'insecure'|'unreadable'} deps.getStoredSeedState
 * @param {() => string} deps.moveSeedAside  moves the unreadable blob aside, returns its new key; throws on failure
 * @param {(asideKey: string) => void} deps.restoreSeedAside  undoes moveSeedAside
 */
function createRestoreGuard({ deriveIdentity, getStoredSeed, setStoredSeed, startNode,
  getStoredSeedState, moveSeedAside, restoreSeedAside }) {
  /**
   * @param {string} phrase
   * @param {{confirmedNodeId?: string|null, replaceConfirmation?: string|null}} [opts]
   *   the NodeID the user confirmed on a fresh device, and the typed word for replacing an unreadable identity
   * @returns {Promise<{status: 'started'|'confirm'|'mismatch'|'unreadable'|'locked'|'insecure'|'persist-failed'|'start-failed'|'invalid',
   *   nodeIdHex?: string, ghostAddress?: string, storedGhostAddress?: string, error?: string}>}
   */
  async function restore(phrase, { confirmedNodeId = null, replaceConfirmation = null } = {}) {
    if (typeof phrase !== 'string' || phrase.trim().split(/\s+/).length !== 12) {
      return { status: 'invalid', error: 'A recovery phrase is exactly 12 words.' };
    }
    const entered = await deriveIdentity(phrase);
    const state = getStoredSeedState();
    if (state === 'locked' || state === 'insecure') {
      return { status: state, ghostAddress: entered.ghostAddress, error: state === 'locked' ? LOCKED_REASON : INSECURE_REASON };
    }
    const replacing = state === 'unreadable';
    if (replacing && replaceConfirmation !== REPLACE_WORD) {
      return { status: 'unreadable', ghostAddress: entered.ghostAddress,
        error: 'The identity saved on this device cannot be read here. Nothing was changed.' };
    }
    const stored = state === 'readable' ? getStoredSeed() : null;

    if (stored) {
      const current = await deriveIdentity(stored);
      if (current.nodeIdHex !== entered.nodeIdHex) {
        return { status: 'mismatch', ghostAddress: entered.ghostAddress, storedGhostAddress: current.ghostAddress };
      }
      // Same identity as the stored seed: nothing new to persist.
    } else {
      if (confirmedNodeId !== entered.nodeIdHex) {
        return { status: 'confirm', nodeIdHex: entered.nodeIdHex, ghostAddress: entered.ghostAddress };
      }
      let asideKey = null;
      if (replacing) {
        try {
          asideKey = moveSeedAside();
        } catch (err) {
          return { status: 'persist-failed', ghostAddress: entered.ghostAddress,
            error: `The unreadable identity could not be moved aside (${err.message}); nothing was changed` };
        }
      }
      try {
        if (setStoredSeed(phrase) !== true) throw new Error('The recovery phrase was not saved.');
      } catch (err) {
        let error = err.message;
        if (asideKey) {
          try { restoreSeedAside(asideKey); } catch (e) { error += `; the old identity stays under ${asideKey} (${e.message})`; }
        }
        return { status: 'persist-failed', ghostAddress: entered.ghostAddress, error };
      }
    }

    try {
      await startNode(phrase);
    } catch (err) {
      return { status: 'start-failed', ghostAddress: entered.ghostAddress, error: err.message };
    }
    return { status: 'started', nodeIdHex: entered.nodeIdHex, ghostAddress: entered.ghostAddress };
  }

  return { restore };
}

module.exports = { createRestoreGuard, REPLACE_WORD };
