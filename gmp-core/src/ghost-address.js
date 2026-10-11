/**
 * Ghost Address — the human-typeable form of a GMP NodeID.
 *
 *   GHOST-XXX-XXX-XXX
 *
 * The first 45 bits of the NodeID (SHA-512 of the static public key) as 9
 * Crockford-base32 characters. Derived, not allocated: the same seed phrase
 * always yields the same address. It carries no IP or port; it is a lookup key
 * resolved through the mesh. Collisions are detected and never guessed.
 *
 * Dependency-free ESM so the browser, Electron and the bridge share this one
 * implementation.
 */

// Crockford base32: no I, L, O or U. Removes the 1/l/I and 0/O confusions when
// an address is read aloud or copied off a screen, and drops U so the alphabet
// cannot spell unfortunate words.
export const GHOST_ADDRESS_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Number of base32 characters in an address (excluding prefix and dashes). */
export const GHOST_ADDRESS_LENGTH = 9;

/** Bits of NodeID entropy an address carries (9 chars × 5 bits). */
export const GHOST_ADDRESS_BITS = 45;

/** Canonical rendered form. */
export const GHOST_ADDRESS_PATTERN = /^GHOST-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/;

/** A full NodeID as hex (SHA-512 → 128 chars), or the 64-char routing prefix. */
export const NODE_ID_PATTERN = /^[0-9a-f]{64}(?:[0-9a-f]{64})?$/i;

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId.trim().toLowerCase();
  if (nodeId && (typeof Buffer !== 'undefined' && Buffer.isBuffer(nodeId))) {
    return nodeId.toString('hex');
  }
  if (nodeId instanceof Uint8Array) {
    return Array.from(nodeId).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

/**
 * Derive the Ghost Address for a NodeID.
 *
 * @param {string|Buffer|Uint8Array} nodeId Full NodeID (hex string or bytes).
 * @returns {string} e.g. "GHOST-7K2-M4Q-8ZB"
 * @throws {Error} if the NodeID is too short to derive from.
 */
export function ghostAddressFromNodeId(nodeId) {
  const hex = toHex(nodeId);
  if (!/^[0-9a-f]{12,}$/.test(hex)) {
    throw new Error('ghostAddressFromNodeId: expected a hex NodeID of at least 48 bits');
  }

  // First 48 bits of the NodeID, shifted down to the 45 we actually encode.
  // The NodeID is a SHA-512 digest, so every bit is uniformly distributed and
  // taking a prefix is as good as hashing again.
  let value = BigInt('0x' + hex.slice(0, 12)) >> 3n;

  let chars = '';
  for (let i = 0; i < GHOST_ADDRESS_LENGTH; i++) {
    chars = GHOST_ADDRESS_ALPHABET[Number(value & 31n)] + chars;
    value >>= 5n;
  }

  return `GHOST-${chars.slice(0, 3)}-${chars.slice(3, 6)}-${chars.slice(6, 9)}`;
}

/**
 * Canonicalise user input, or return null. Tolerates case, a missing GHOST-
 * prefix, dashes, spaces, and Crockford's ambiguous characters (O→0, I/L→1, U→V).
 */
export function normalizeGhostAddress(input) {
  if (typeof input !== 'string') return null;

  let body = input.trim().toUpperCase().replace(/^GHOST[\s\-_:]*/, '');
  body = body.replace(/[^0-9A-Z]/g, '');
  // Fold the excluded characters onto what the writer almost certainly meant.
  body = body.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');

  if (body.length !== GHOST_ADDRESS_LENGTH) return null;
  for (const ch of body) {
    if (!GHOST_ADDRESS_ALPHABET.includes(ch)) return null;
  }

  return `GHOST-${body.slice(0, 3)}-${body.slice(3, 6)}-${body.slice(6, 9)}`;
}

/** True when the input parses as a Ghost Address. */
export function isGhostAddress(input) {
  return normalizeGhostAddress(input) !== null;
}

/**
 * Every NodeID in `nodeIds` that maps to `address`; more than one is a
 * collision and callers must not pick one.
 *
 * @param {Iterable<string>} nodeIds
 * @param {string} address
 * @returns {string[]} matching NodeIDs, lower-case hex
 */
export function findNodeIdsForAddress(nodeIds, address) {
  const wanted = normalizeGhostAddress(address);
  if (!wanted) return [];

  const matches = new Set();
  for (const nodeId of nodeIds) {
    const hex = toHex(nodeId);
    if (!hex) continue;
    try {
      if (ghostAddressFromNodeId(hex) === wanted) matches.add(hex);
    } catch (e) {
      // Not a usable NodeID — skip it rather than failing the whole scan.
    }
  }
  return Array.from(matches);
}

/** True when the input looks like a raw NodeID (full or 64-char prefix). */
export function isNodeIdHex(input) {
  return typeof input === 'string' && NODE_ID_PATTERN.test(input.trim());
}
