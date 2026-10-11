/**
 * GhostLink Mobile — shaping values that came from someone else (scanned QR
 * codes, peer chat frames). Everything from outside comes out as plain strings
 * and numbers, or not at all, so a malformed field cannot crash rendering.
 */

export const MAX_NAME_LENGTH = 64;
export const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_ID_LENGTH = 128;
/** Longest public key accepted from an invite: uncompressed P-256 is 130 hex. */
const MAX_KEY_HEX_LENGTH = 260;

const shortString = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** A display name, or undefined if the value is not a usable one. */
export function cleanDisplayName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || undefined;
}

/** A hex public key, or null. */
export function cleanPublicKeyHex(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_KEY_HEX_LENGTH || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
  return value;
}

/**
 * The fields of an inbound `chat` frame the UI may use, or null if the frame is
 * not a well-formed chat message.
 *
 * @returns {{id: string|null, text: string, timestamp: number, replyTo: string|null}|null}
 */
export function parseInboundChat(data) {
  if (!data || typeof data !== 'object' || data.__gl !== 'chat') return null;
  const text = shortString(data.text, MAX_MESSAGE_LENGTH);
  if (!text) return null;
  return {
    id: shortString(data.id, MAX_ID_LENGTH),
    text,
    timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now(),
    replyTo: shortString(data.replyTo, MAX_ID_LENGTH),
  };
}

/** The message id an inbound `ack` frame refers to, or null. */
export function parseInboundAck(data) {
  if (!data || typeof data !== 'object' || data.__gl !== 'ack') return null;
  return shortString(data.id, MAX_ID_LENGTH);
}
