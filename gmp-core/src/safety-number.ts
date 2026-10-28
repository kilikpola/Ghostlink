/**
 * Safety number over the two FULL NodeIDs (identity-v2.md §5, D9; task R3).
 *
 *   h = SHA-512("gl-safety-v1" ‖ min(NodeID_a, NodeID_b) ‖ max(NodeID_a, NodeID_b))
 *
 * over the raw 64-byte NodeIDs (ordered bytewise), shown as 12 groups of 5
 * decimal digits: group i is the big-endian 5-byte chunk h[5i..5i+5] mod 100000.
 * That uses 60 of h's 64 bytes. Both sides compute the same 60 digits.
 *
 * The QR payload carries the version and both full NodeIDs, so a scan compares
 * the identities exactly instead of a rendering of them.
 *
 * Never the 45-bit Ghost Address (D9): it is a lookup key, not a verification
 * value. @noble/hashes only, so the renderer (vendor bundle) and mobile can
 * run this same file.
 */
import { sha512 } from '@noble/hashes/sha512';

export const SAFETY_NUMBER_LABEL = 'gl-safety-v1';
const NODE_ID_BYTES = 64;
const GROUPS = 12;
const GROUP_BYTES = 5;
const NODE_ID_HEX = /^[0-9a-f]{128}$/;

function nodeIdBytes(nodeId: Uint8Array | string): Uint8Array {
  if (typeof nodeId === 'string') {
    const hex = nodeId.trim().toLowerCase();
    if (!NODE_ID_HEX.test(hex)) throw new Error('safety number: a NodeID is 128 hex characters (the full NodeID, never a Ghost Address)');
    const out = new Uint8Array(NODE_ID_BYTES);
    for (let i = 0; i < NODE_ID_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (!(nodeId instanceof Uint8Array) || nodeId.length !== NODE_ID_BYTES) {
    throw new Error('safety number: a NodeID is 64 bytes');
  }
  return nodeId;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The two NodeIDs in canonical (bytewise ascending) order. */
function ordered(a: Uint8Array | string, b: Uint8Array | string): [Uint8Array, Uint8Array] {
  const x = nodeIdBytes(a);
  const y = nodeIdBytes(b);
  if (compareBytes(x, y) === 0) throw new Error('safety number: the two NodeIDs are the same');
  return compareBytes(x, y) < 0 ? [x, y] : [y, x];
}

/** 60 decimal digits, identical whichever side computes it. */
export function safetyNumber(nodeIdA: Uint8Array | string, nodeIdB: Uint8Array | string): string {
  const [lo, hi] = ordered(nodeIdA, nodeIdB);
  const label = new TextEncoder().encode(SAFETY_NUMBER_LABEL);
  const input = new Uint8Array(label.length + 2 * NODE_ID_BYTES);
  input.set(label, 0);
  input.set(lo, label.length);
  input.set(hi, label.length + NODE_ID_BYTES);
  const h = sha512(input);
  let digits = '';
  for (let g = 0; g < GROUPS; g++) {
    let v = 0;
    for (let i = 0; i < GROUP_BYTES; i++) v = v * 256 + h[g * GROUP_BYTES + i];
    digits += String(v % 100000).padStart(5, '0');
  }
  return digits;
}

/** "12345 67890 …" — 12 groups of 5. */
export function formatSafetyNumber(digits: string): string {
  if (!/^\d{60}$/.test(digits)) throw new Error('safety number: expected 60 digits');
  return (digits.match(/\d{5}/g) as string[]).join(' ');
}

/** What the QR encodes: version + both full NodeIDs, canonical order. */
export function safetyQrPayload(nodeIdA: Uint8Array | string, nodeIdB: Uint8Array | string): string {
  const [lo, hi] = ordered(nodeIdA, nodeIdB);
  return `${SAFETY_NUMBER_LABEL}:${toHex(lo)}:${toHex(hi)}`;
}

/** True only when a scanned payload names exactly these two NodeIDs. */
export function safetyQrMatches(scanned: string, myNodeId: Uint8Array | string, theirNodeId: Uint8Array | string): boolean {
  if (typeof scanned !== 'string') return false;
  return scanned.trim().toLowerCase() === safetyQrPayload(myNodeId, theirNodeId);
}
