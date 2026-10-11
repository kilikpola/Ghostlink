/**
 * TextEncoder / TextDecoder for Hermes, installed at the app entry point.
 * UTF-8 only; anything else throws rather than mis-encoding key material.
 * test/crypto checks byte-equality against Node across the BMP and surrogates.
 */

function encodeUtf8(input) {
  const str = String(input);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);

    // Combine a surrogate pair into a single code point.
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    // A surrogate that is not part of a valid pair is replaced with U+FFFD,
    // exactly as the WHATWG encoding standard requires.
    if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function decodeUtf8(input) {
  if (input == null) return '';
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer ? input.buffer : input);

  let out = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i];

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    }

    // The lead byte fixes the length and the legal range of the second byte,
    // so invalid sequences fail here and emit one U+FFFD per maximal subpart,
    // as WHATWG (and Node) do.
    let needed, lo, hi, cp;
    if (b0 >= 0xc2 && b0 <= 0xdf) { needed = 1; lo = 0x80; hi = 0xbf; cp = b0 & 0x1f; }
    else if (b0 === 0xe0) { needed = 2; lo = 0xa0; hi = 0xbf; cp = b0 & 0x0f; }
    else if (b0 >= 0xe1 && b0 <= 0xec) { needed = 2; lo = 0x80; hi = 0xbf; cp = b0 & 0x0f; }
    else if (b0 === 0xed) { needed = 2; lo = 0x80; hi = 0x9f; cp = b0 & 0x0f; } // no surrogates
    else if (b0 >= 0xee && b0 <= 0xef) { needed = 2; lo = 0x80; hi = 0xbf; cp = b0 & 0x0f; }
    else if (b0 === 0xf0) { needed = 3; lo = 0x90; hi = 0xbf; cp = b0 & 0x07; } // no overlong
    else if (b0 >= 0xf1 && b0 <= 0xf3) { needed = 3; lo = 0x80; hi = 0xbf; cp = b0 & 0x07; }
    else if (b0 === 0xf4) { needed = 3; lo = 0x80; hi = 0x8f; cp = b0 & 0x07; } // caps at U+10FFFF
    else { out += '\uFFFD'; i++; continue; }                                   // 0xc0/0xc1/0xf5+

    let seen = 0;
    let valid = true;
    while (seen < needed) {
      const b = bytes[i + 1 + seen];
      const min = seen === 0 ? lo : 0x80;
      const max = seen === 0 ? hi : 0xbf;
      if (b === undefined || b < min || b > max) { valid = false; break; }
      cp = (cp << 6) | (b & 0x3f);
      seen++;
    }

    if (!valid) {
      // Consume only the bytes that formed a valid prefix. The byte that broke
      // the sequence gets reconsidered as a fresh lead byte.
      out += '\uFFFD';
      i += 1 + seen;
      continue;
    }

    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
    i += 1 + needed;
  }

  return out;
}

function assertUtf8(label) {
  const enc = String(label || 'utf-8').toLowerCase();
  if (enc !== 'utf-8' && enc !== 'utf8' && enc !== 'unicode-1-1-utf-8') {
    throw new RangeError(`[GhostLink] only utf-8 is supported, got "${label}"`);
  }
}

export class GhostTextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input = '') { return encodeUtf8(input); }
}

export class GhostTextDecoder {
  constructor(label = 'utf-8') { assertUtf8(label); }
  get encoding() { return 'utf-8'; }
  decode(input) { return decodeUtf8(input); }
}

/** Installs both onto the global scope if the engine lacks them. */
export function installTextEncoding(scope = globalThis) {
  if (typeof scope.TextEncoder === 'undefined') scope.TextEncoder = GhostTextEncoder;
  if (typeof scope.TextDecoder === 'undefined') scope.TextDecoder = GhostTextDecoder;
  return scope;
}

installTextEncoding();
