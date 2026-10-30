'use strict';
/**
 * The ratchet store's rollback anchor in Electron safeStorage (identity-v2.md
 * §4.5, D12; tasks R5, R7). gmp-core never touches Electron: main.js builds
 * this provider and hands it to the node as the `ratchets` spec.
 *
 * The anchor ({ installId, gens: { contact NodeID → generation } }) is JSON,
 * sealed with safeStorage, stored base64 in electron-store under one key —
 * outside the ratchet files, so restoring those files does not restore it.
 *
 * Keyring states are R1c's (contact-key.js backendState), never collapsed:
 *   ok        → a sealed store anchored here
 *   locked / insecure → memory-only ratchets for this run (main.js decides
 *                       before construction; load() also refuses, so the
 *                       store can never write state without an anchor)
 *   a stored anchor that will not decrypt → 'unavailable': memory-only, and
 *                       the stored value is left untouched (never overwritten).
 */
const { backendState } = require('./contact-key');

const ANCHOR_STORE = 'gl_ratchet_anchor_enc';

/** Neutral wording for the renderer (no security claim either way). */
const MEMORY_ONLY_REASONS = {
  locked: 'The system keyring is locked, so secure-session state is kept in memory for this run and starts over after a restart.',
  insecure: 'No system keyring is in use, so secure-session state is kept in memory for this run and starts over after a restart.',
  unavailable: 'The saved secure-session record could not be read with this keyring, so session state is kept in memory for this run; the saved record was left unchanged.',
};

function createRatchetAnchor(safeStorage, store) {
  return {
    load() {
      const state = backendState(safeStorage);
      if (state !== 'ok') return { status: state, detail: `keyring ${state}` };
      const sealed = store.get(ANCHOR_STORE);
      if (sealed === undefined) return { status: 'absent' };
      let anchor;
      try {
        anchor = JSON.parse(safeStorage.decryptString(Buffer.from(String(sealed), 'base64')));
      } catch (_e) {
        return { status: 'unavailable', detail: 'the stored anchor does not decrypt with this keyring' };
      }
      if (!anchor || anchor.v !== 1 || !/^[0-9a-f]{32}$/.test(anchor.installId) || typeof anchor.gens !== 'object') {
        return { status: 'unavailable', detail: 'the stored anchor is not valid' };
      }
      return { status: 'ok', anchor };
    },
    save(anchor) {
      const state = backendState(safeStorage);
      if (state !== 'ok') throw new Error(`keyring ${state}: the anchor cannot be written`);
      const blob = safeStorage.encryptString(JSON.stringify(anchor)).toString('base64');
      store.set(ANCHOR_STORE, blob);
      if (store.get(ANCHOR_STORE) !== blob) throw new Error('the anchor did not read back after writing');
    },
  };
}

/**
 * The `ratchets` spec for the chat node: sealed in `dir` when the keyring is
 * usable and the stored anchor (if any) opens; otherwise explicitly memory-only
 * with the neutral reason.
 */
function ratchetSpecFor(safeStorage, store, dir) {
  const anchor = createRatchetAnchor(safeStorage, store);
  const state = backendState(safeStorage);
  if (state !== 'ok') return { memoryOnly: MEMORY_ONLY_REASONS[state] || MEMORY_ONLY_REASONS.locked, state };
  if (anchor.load().status === 'unavailable') return { memoryOnly: MEMORY_ONLY_REASONS.unavailable, state: 'unavailable' };
  return { dir, anchor, state };
}

module.exports = { createRatchetAnchor, ratchetSpecFor, ANCHOR_STORE, MEMORY_ONLY_REASONS };
