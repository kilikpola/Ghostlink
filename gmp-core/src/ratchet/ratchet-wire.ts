/**
 * Ratchet messages inside GMP DATA, and their padding (identity-v2.md §3.1,
 * §3.2, D13; task R7). Pure.
 *
 * DATA plaintext of a ratchet message:
 *
 *   0x02 (content type) ‖ ratchet message (§3.1: version 0x01 ‖ kind ‖ … ‖ tag)
 *
 * The content-type byte is not in the doc. It is needed because a direct DATA
 * plaintext whose first byte is 0x01 is a ROUTED packet (forwarder.ts); a
 * ratchet message starts with its version byte 0x01, so it cannot travel bare.
 * Every existing application payload is UTF-8 text (JSON, sealed strings), so
 * 0x02 collides with nothing. The node's forwarder hands 0x02 plaintexts to
 * the ratchet as bytes, before the link turns DATA into a string.
 *
 * Padding (D13): the ratchet plaintext is [u16 contentLength][content][zeros],
 * sized so the whole DATA plaintext is EXACTLY one of 232 / 1000 / 4072 bytes —
 * the payload of one 256 / 1024 / 4096 relay record (272 / 1040 / 4112 on the
 * wire) minus the inner frame's 21 bytes (§3.2). On a relay circuit each
 * message therefore fills one record exactly; on a direct link the frame is
 * 253 / 1021 / 4093 bytes, the same length class (D13: "the same length class
 * is used on direct links"). The doc's padded-plaintext sizes 158 / 926 / 3998
 * become 157 / 925 / 3997 for kind 0x01 (one byte for the content type) and
 * 117 / 885 / 3957 for kind 0x02 (40 more header bytes). Content over
 * 3995 bytes (kind 0x01) is an attachment, not a message: refused here.
 */
import { OVERHEAD, KIND_RATCHET, KIND_INITIAL } from './ratchet.js';

/** Re-exported so callers outside the ratchet take kinds from here, not from the core. */
export { KIND_RATCHET, KIND_INITIAL };

export const RATCHET_CONTENT_TYPE = 0x02;
/** DATA plaintext sizes that fill one relay record exactly (§3.2). */
export const DATA_CLASSES = Object.freeze([232, 1000, 4072]);
const LEN_PREFIX = 2;

export class RatchetPayloadTooLargeError extends Error {
  constructor(m: string) { super(m); this.name = 'RatchetPayloadTooLargeError'; }
}

/** Padded ratchet plaintext for `content`, given the message kind it will travel as. */
export function padContent(content: Uint8Array, kind: number, { padding = true }: { padding?: boolean } = {}): Uint8Array {
  if (kind !== KIND_RATCHET && kind !== KIND_INITIAL) throw new Error('ratchet-wire: unknown kind');
  if (!(content instanceof Uint8Array)) throw new Error('ratchet-wire: content is bytes');
  if (content.length > 0xffff) throw new RatchetPayloadTooLargeError('ratchet-wire: content over 65535 bytes');
  const fixed = 1 + OVERHEAD[kind as 1 | 2] + LEN_PREFIX;
  let size = LEN_PREFIX + content.length;
  if (padding) {
    const cls = DATA_CLASSES.find((c) => c >= fixed + content.length);
    if (cls === undefined) {
      throw new RatchetPayloadTooLargeError(`ratchet-wire: ${content.length} bytes do not fit the largest class (${DATA_CLASSES[DATA_CLASSES.length - 1] - fixed} for this kind); send it as an attachment`);
    }
    size = cls - 1 - OVERHEAD[kind as 1 | 2];
  }
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint16(0, content.length);
  out.set(content, LEN_PREFIX);
  return out;
}

/** Inverse of padContent. Throws on a length that does not fit. */
export function unpadContent(padded: Uint8Array): Uint8Array {
  if (padded.length < LEN_PREFIX) throw new Error('ratchet-wire: short plaintext');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0);
  if (LEN_PREFIX + len > padded.length) throw new Error('ratchet-wire: length exceeds plaintext');
  return padded.slice(LEN_PREFIX, LEN_PREFIX + len);
}

/** DATA plaintext for one ratchet message. */
export function toData(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + message.length);
  out[0] = RATCHET_CONTENT_TYPE;
  out.set(message, 1);
  return out;
}

/** The ratchet message in a DATA plaintext, or null if it is not one. */
export function fromData(plaintext: Uint8Array): Uint8Array | null {
  return plaintext.length > 1 && plaintext[0] === RATCHET_CONTENT_TYPE ? plaintext.slice(1) : null;
}
