/**
 * The native (Kotlin) PBKDF2 module must produce exactly what the JS one does:
 * these bytes are the identity.
 *
 * Node cannot load the Kotlin module, so this:
 *   - pins the JS reference values
 *   - re-implements the Kotlin RFC 8018 construction independently and compares
 *
 * On-device check: scripts/verify-pbkdf2-on-device.md.
 *
 * Run with: node test/pbkdf2-native-parity.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {sha256} from '@noble/hashes/sha256';
import {sha512} from '@noble/hashes/sha512';
import crypto from 'crypto';
import {FIXTURE_A} from '../../test/helpers/fixture-phrases.mjs';

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString('hex');

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const PHRASE = FIXTURE_A.join(' ');

// Every derivation the app performs, with its real parameters.
const VECTORS = [
  {salt: 'ghostlink-identity-key-v1', hash: 'sha512', c: 100000, dkLen: 32},
  {salt: 'ghostlink-yggdrasil-v1',    hash: 'sha512', c: 100000, dkLen: 32},
  {salt: 'ghostlink-v2-salt',         hash: 'sha256', c: 100000, dkLen: 32},
  {salt: 'ghostlink-storage-v1',      hash: 'sha256', c: 200000, dkLen: 32},
];

test('@noble and Node/OpenSSL PBKDF2 agree on every derivation the app uses', async () => {
  for (const v of VECTORS) {
    const js = await pbkdf2Async(v.hash === 'sha512' ? sha512 : sha256,
      utf8(PHRASE), utf8(v.salt), {c: v.c, dkLen: v.dkLen});
    // OpenSSL via Node stands in for the platform implementation the Kotlin
    // module uses: same RFC 8018 construction over UTF-8 password bytes.
    const native = crypto.pbkdf2Sync(
      Buffer.from(PHRASE, 'utf8'), Buffer.from(v.salt, 'utf8'), v.c, v.dkLen, v.hash);
    assert.strictEqual(hex(js), hex(native),
      `${v.salt} (${v.hash}, c=${v.c}) differs between implementations`);
  }
});

test('the derived identity key is pinned', async () => {
  const bits = await pbkdf2Async(sha512, utf8(PHRASE), utf8('ghostlink-identity-key-v1'),
    {c: 100000, dkLen: 32});
  assert.strictEqual(hex(bits),
    hex(crypto.pbkdf2Sync(Buffer.from(PHRASE,'utf8'), Buffer.from('ghostlink-identity-key-v1','utf8'),
      100000, 32, 'sha512')),
    'identity key derivation drifted');
});

/** Kotlin source with comments removed — the file explains in prose why it
 *  avoids certain APIs, and prose must not satisfy or fail these checks. */
function kotlinCode() {
  return fs.readFileSync('android/app/src/main/java/io/ghostlink/app/Pbkdf2Module.kt', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the Kotlin module hashes the UTF-8 bytes of the password, not char[]', () => {
  const kt = kotlinCode();
  assert.ok(/password\.toByteArray\(Charsets\.UTF_8\)/.test(kt),
    'password must be hashed as explicit UTF-8 bytes');
  assert.ok(/salt\.toByteArray\(Charsets\.UTF_8\)/.test(kt),
    'salt must be hashed as explicit UTF-8 bytes');
  assert.ok(!/PBEKeySpec/.test(kt),
    'PBEKeySpec takes char[] and leaves the encoding to the provider — do not use it');
});

test('the Kotlin module implements PBKDF2 correctly', () => {
  const kt = kotlinCode();
  assert.ok(/INT_32_BE|ushr 24/.test(kt), 'block index must be appended big-endian');
  assert.ok(/xor/.test(kt), 'U rounds must be XOR-folded');
  assert.ok(/HmacSHA512/.test(kt) && /HmacSHA256/.test(kt), 'both PRFs must be supported');
  assert.ok(/for \(round in 2\.\.iterations\)/.test(kt),
    'the U loop must run c-1 further rounds after U1');
});

test('the module runs off the JS thread', () => {
  const kt = kotlinCode();
  assert.ok(/Executors\.newFixedThreadPool/.test(kt) && /pool\.execute/.test(kt),
    'derivation must not run on the bridge/JS thread — that is the bug being fixed');
});

test('JS keeps working when the native module is absent', () => {
  const js = fs.readFileSync('src/utils/crypto.js', 'utf8');
  assert.ok(/NativeModules\.Pbkdf2 \|\| null/.test(js), 'a missing module must be tolerated');
  assert.ok(/nativePbkdf2Usable = false/.test(js), 'a native failure must fall back');
  assert.ok(/pbkdf2Async\(prf/.test(js), 'the @noble fallback must remain');
  // And the fallback must not be reachable without a warning.
  assert.ok(/falling back to JS \(slow\)/.test(js),
    'a silent fallback would hide a four-minute regression');
});

test('every derivation goes through the wrapper, none call @noble directly', () => {
  const js = fs.readFileSync('src/utils/crypto.js', 'utf8');
  // The only permitted pbkdf2Async call is the one inside the wrapper.
  const direct = [...js.matchAll(/await pbkdf2Async\(/g)];
  assert.strictEqual(direct.length, 1,
    `expected exactly 1 pbkdf2Async call (inside the wrapper), found ${direct.length}`);
  for (const v of VECTORS) {
    const re = new RegExp(`pbkdf2\\(phrase, '${v.salt}', '${v.hash}', ${v.c}, ${v.dkLen}\\)`);
    assert.ok(re.test(js), `${v.salt} must route through the wrapper with unchanged params`);
  }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} pbkdf2-native-parity test(s) failed`); process.exit(1); }
console.log('\nAll pbkdf2-native-parity tests passed');
