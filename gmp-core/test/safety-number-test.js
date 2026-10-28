/**
 * src/safety-number.ts: the safety number over two FULL NodeIDs
 * (identity-v2.md §5, D9; task R3).
 *
 * Pinned for FIXTURE_A / FIXTURE_B (word indices, test/helpers/fixture-phrases.mjs;
 * the phrases are never printed). Cross-checked against an INDEPENDENT
 * implementation (node:crypto SHA-512, this test only) on the fixtures and on
 * 2000 random NodeID pairs. NodeIDs are public; the 60 digits are pinned in
 * full.
 *
 * Run: node test/safety-number-test.js
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BIP39_WORDS } from '../dist/bip39-english.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import { ghostAddressFromNodeId } from '../dist/ghost-address.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

let sn = null;
try { sn = await import('../dist/safety-number.js'); } catch { /* A: module absent */ }
console.log('\n=== the module exists ===');
ok(!!sn && typeof sn.safetyNumber === 'function' && typeof sn.safetyQrPayload === 'function', 'dist/safety-number.js exports safetyNumber and safetyQrPayload');
if (!sn) done();
const { safetyNumber, formatSafetyNumber, safetyQrPayload, safetyQrMatches } = sn;

const phraseOf = (idx) => idx.map((i) => BIP39_WORDS[i]).join(' ');
const A = (await deriveIdentityFromSeedPhrase(phraseOf([9, 1151, 1914, 273, 1937, 1234, 729, 1904, 709, 1223, 1947, 576]))).nodeIdHex;
const B = (await deriveIdentityFromSeedPhrase(phraseOf([2002, 179, 526, 1457, 1, 1852, 1723, 1057, 1510, 1797, 548, 730]))).nodeIdHex;
const PINNED_AB = '632334512811262621821109808809672846577166907067971366457881';

/** Independent: node:crypto, Buffer ordering, readUIntBE. */
function independent(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  const [lo, hi] = Buffer.compare(x, y) <= 0 ? [x, y] : [y, x];
  const h = crypto.createHash('sha512').update(Buffer.concat([Buffer.from('gl-safety-v1'), lo, hi])).digest();
  let d = '';
  for (let i = 0; i < 12; i++) d += String(h.readUIntBE(5 * i, 5) % 100000).padStart(5, '0');
  return d;
}

console.log('\n=== pinned vector (FIXTURE_A, FIXTURE_B) ===');
{
  const ab = safetyNumber(A, B);
  ok(ab === PINNED_AB, `SN(A,B) = ${formatSafetyNumber(ab).slice(0, 23)}… matches the pin`);
  ok(ab === independent(A, B), 'equals the independent implementation');
  ok(safetyNumber(B, A) === ab, 'both parties compute the same number (argument order does not matter)');
  ok(safetyNumber(Buffer.from(A, 'hex'), new Uint8Array(Buffer.from(B, 'hex'))) === ab, 'bytes and hex inputs agree');
  ok(/^(\d{5} ){11}\d{5}$/.test(formatSafetyNumber(ab)), 'shown as 12 groups of 5 digits');
}

console.log('\n=== 2000 random pairs agree with the independent implementation ===');
{
  let agree = 0;
  for (let i = 0; i < 2000; i++) {
    const x = crypto.randomBytes(64).toString('hex'), y = crypto.randomBytes(64).toString('hex');
    if (safetyNumber(x, y) === independent(x, y) && safetyNumber(y, x) === safetyNumber(x, y)) agree++;
  }
  ok(agree === 2000, `${agree}/2000 agree, symmetric`);
}

console.log('\n=== any change to either NodeID changes the number ===');
{
  const ab = safetyNumber(A, B);
  const flip = (hex, byte) => { const b = Buffer.from(hex, 'hex'); b[byte] ^= 0x01; return b.toString('hex'); };
  ok(safetyNumber(flip(A, 63), B) !== ab, 'one bit of A\'s last byte changes it');
  ok(safetyNumber(A, flip(B, 0)) !== ab, 'one bit of B\'s first byte changes it');
  // Two NodeIDs sharing the 45-bit Ghost Address (D9): the number still differs.
  const twin = Buffer.from(B, 'hex'); twin[40] ^= 0xff;
  const twinHex = twin.toString('hex');
  ok(ghostAddressFromNodeId(twinHex) === ghostAddressFromNodeId(B), 'control: a NodeID with the same Ghost Address as B (differs after bit 45)');
  ok(safetyNumber(A, twinHex) !== ab, 'a same-Ghost-Address NodeID gives a different safety number');
  ok(safetyNumber(A, B) === ab, 'positive control: the same pair gives the same number');
}

console.log('\n=== only full NodeIDs are accepted ===');
{
  const refused = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(refused(() => safetyNumber(A, ghostAddressFromNodeId(B))), 'a Ghost Address is refused');
  ok(refused(() => safetyNumber(A, B.slice(0, 16))), 'a 16-hex fingerprint prefix is refused');
  ok(refused(() => safetyNumber(A, A)), 'the same NodeID twice is refused');
  ok(!refused(() => safetyNumber(A.toUpperCase(), B)), 'positive control: upper-case full NodeID hex is accepted');
}

console.log('\n=== QR payload: version + both full NodeIDs, compared exactly ===');
{
  const qr = safetyQrPayload(A, B);
  const [lo, hi] = [A, B].sort();
  ok(qr === `gl-safety-v1:${lo}:${hi}`, 'payload is "gl-safety-v1:<lower NodeID>:<higher NodeID>"');
  ok(safetyQrPayload(B, A) === qr, 'same payload from both sides');
  ok(safetyQrMatches(qr, A, B) && safetyQrMatches(qr, B, A), 'a scan of the right pair matches, from either side');
  const twin = Buffer.from(B, 'hex'); twin[40] ^= 0xff;
  ok(!safetyQrMatches(safetyQrPayload(A, twin.toString('hex')), A, B), 'a same-Ghost-Address NodeID does not match');
  ok(!safetyQrMatches(`gl-safety-v0:${lo}:${hi}`, A, B), 'another version does not match');
  ok(!safetyQrMatches(qr.slice(0, -1), A, B), 'a truncated payload does not match');
}

console.log('\n=== portable: no node built-ins in the source ===');
{
  const src = fs.readFileSync(path.join(pkg, 'src', 'safety-number.ts'), 'utf8');
  const forbidden = /from ['"](node:)?crypto['"]|require\(['"](node:)?crypto['"]\)|\bBuffer\b|from ['"](node:)?(fs|path|os)['"]/;
  assertAbsent({
    channel: 'node:crypto / Buffer / node built-ins in src/safety-number.ts',
    controlMessage: 'the matcher finds a planted "import crypto from \'crypto\'" and a planted Buffer.from',
    control: () => (forbidden.test("import crypto from 'crypto';") && forbidden.test('Buffer.from(x)') ? 1 : 0),
    absent: () => !forbidden.test(src),
    message: 'safety-number.ts uses only @noble/hashes and standard JS',
  });
}

done();
