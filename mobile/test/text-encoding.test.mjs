/**
 * The polyfill produces the bytes that get hashed and encrypted, so a wrong
 * encoding is a wrong key, not a visible glitch. Everything here is checked for
 * byte-equality against Node's own TextEncoder/TextDecoder.
 */
import {GhostTextEncoder, GhostTextDecoder} from '../src/utils/text-encoding-polyfill.js';
import {FIXTURE_B} from '../../test/helpers/fixture-phrases.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}`)); };

const mine = new GhostTextEncoder();
const ref = new TextEncoder();
const myDec = new GhostTextDecoder();
const refDec = new TextDecoder();
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('\n[1] Encoding matches Node across every BMP code point');
{
  let bad = 0, firstBad = null;
  for (let cp = 0; cp <= 0xffff; cp++) {
    const s = String.fromCharCode(cp);
    if (!eq(mine.encode(s), ref.encode(s))) { bad++; if (firstBad === null) firstBad = cp; }
  }
  ok(`all 65,536 BMP code points encode identically (${bad} mismatches)`, bad === 0);
  if (firstBad !== null) console.log(`       first mismatch at U+${firstBad.toString(16)}`);
}

console.log('\n[2] Astral planes and surrogate pairs');
{
  let bad = 0;
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 977) {   // stride keeps it quick but broad
    const s = String.fromCodePoint(cp);
    if (!eq(mine.encode(s), ref.encode(s))) bad++;
  }
  ok(`astral code points encode identically (${bad} mismatches)`, bad === 0);
  for (const s of ['🔒', '👨‍👩‍👧‍👦', '🇬🇧', 'a🔒b', '𝄞𝄞𝄞']) {
    ok(`${s} matches`, eq(mine.encode(s), ref.encode(s)));
  }
}

console.log('\n[3] Lone surrogates become U+FFFD, as the spec requires');
{
  for (const s of ['\uD800', '\uDC00', 'a\uD800b', '\uD800\uD800', 'x\uDFFFy']) {
    ok(`lone surrogate ${JSON.stringify(s)} matches Node`, eq(mine.encode(s), ref.encode(s)));
  }
}

console.log('\n[4] Realistic inputs');
{
  const samples = [
    '', 'a', 'hello world',
    FIXTURE_B.join(' '),
    'ghostlink-v2-salt', 'ghostlink-storage-v1',
    JSON.stringify({v: 1, wrappedKey: {iv: 'ab'.repeat(12), ciphertext: 'cd'.repeat(40)}}),
    'x'.repeat(10000),
    'Ünïcödé ñämé 日本語 한국어 العربية',
  ];
  for (const s of samples) {
    ok(`encode ${JSON.stringify(s.slice(0, 26))}…`, eq(mine.encode(s), ref.encode(s)));
  }
}

console.log('\n[5] Round-trip through decode');
{
  const samples = ['', 'hello', '🔒 unicode ✓', 'Ünïcödé 日本語', 'x'.repeat(5000), '𝄞 music'];
  for (const s of samples) {
    const bytes = mine.encode(s);
    ok(`round-trips ${JSON.stringify(s.slice(0, 18))}…`, myDec.decode(bytes) === s);
    ok(`decode matches Node for ${JSON.stringify(s.slice(0, 18))}…`, myDec.decode(bytes) === refDec.decode(bytes));
  }
}

console.log('\n[6] Malformed input decodes like Node');
{
  const cases = [
    [0xff], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0x80], [0xc2],
    [0xf0, 0x82, 0x82, 0xac],          // overlong euro
    [0xed, 0xa0, 0x80],                // surrogate encoded in UTF-8
    [0xf4, 0x90, 0x80, 0x80],          // beyond U+10FFFF
    [0x61, 0xff, 0x62],
  ];
  for (const c of cases) {
    const b = new Uint8Array(c);
    ok(`[${c.map(x => x.toString(16)).join(' ')}] matches Node`, myDec.decode(b) === refDec.decode(b));
  }
}

console.log('\n[7] Interface shape');
{
  ok('encoding property is utf-8', mine.encoding === 'utf-8' && myDec.encoding === 'utf-8');
  ok('encode() with no argument returns empty', mine.encode().length === 0);
  ok('returns a Uint8Array', mine.encode('a') instanceof Uint8Array);
  let threw = false;
  try { new GhostTextDecoder('utf-16'); } catch { threw = true; }
  ok('a non-utf-8 decoder is refused rather than silently wrong', threw);
  ok('utf8 alias accepted', new GhostTextDecoder('utf8').encoding === 'utf-8');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
