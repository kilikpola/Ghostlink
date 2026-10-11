/**
 * At-rest encryption: the v2 HKDF-SHA256 KDF, and every v1 blob still opening.
 *
 * Run with: node test/at-rest-crypto.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Lift CryptoEngine out of index.html so the shipped implementation is tested.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('const CryptoEngine = {');
assert.ok(start !== -1, 'index.html no longer declares CryptoEngine');
const end = html.indexOf('\n};', start);
assert.ok(end !== -1, 'could not find the end of CryptoEngine');
const CryptoEngine = new Function(
  `${html.slice(start, end + 3)}\nreturn CryptoEngine;`
)();

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HIGH_ENTROPY_KEY =
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

/** Seal something exactly the way v1 did, to prove it still opens. */
async function sealV1(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(key).padEnd(32, '0').slice(0, 32)),
    'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv}, ck, new TextEncoder().encode(text));
  const hex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return {iv: hex(iv), ciphertext: hex(new Uint8Array(ct))}; // note: no `v`
}

test('a round trip returns the plaintext', async () => {
  const enc = await CryptoEngine.encrypt('hello ghost', HIGH_ENTROPY_KEY);
  assert.strictEqual(await CryptoEngine.decrypt(enc, HIGH_ENTROPY_KEY), 'hello ghost');
});

test('new ciphertext is tagged v2 and carries a salt', async () => {
  const enc = await CryptoEngine.encrypt('x', HIGH_ENTROPY_KEY);
  assert.strictEqual(enc.v, 2, 'writes must be v2');
  assert.match(enc.salt, /^[0-9a-f]{32}$/, 'a 16-byte salt must be stored');
  assert.match(enc.iv, /^[0-9a-f]{24}$/, 'a 12-byte IV must be stored');
  assert.strictEqual(CryptoEngine.isLegacyCiphertext(enc), false);
});

test('the salt is per-message, so the same plaintext seals differently', async () => {
  const a = await CryptoEngine.encrypt('same', HIGH_ENTROPY_KEY);
  const b = await CryptoEngine.encrypt('same', HIGH_ENTROPY_KEY);
  assert.notStrictEqual(a.salt, b.salt, 'salts must differ');
  assert.notStrictEqual(a.ciphertext, b.ciphertext, 'ciphertext must differ');
});

test('v1 ciphertext still decrypts — no history is orphaned', async () => {
  const legacy = await sealV1('written by an old build', HIGH_ENTROPY_KEY);
  assert.strictEqual(CryptoEngine.isLegacyCiphertext(legacy), true,
    'an untagged blob must be recognised as legacy');
  assert.strictEqual(
    await CryptoEngine.decrypt(legacy, HIGH_ENTROPY_KEY), 'written by an old build');
});

test('v1 and v2 derive different keys, so the version tag is load-bearing', async () => {
  const legacy = await sealV1('secret', HIGH_ENTROPY_KEY);
  // Claiming v2 over v1 bytes must fail rather than silently return garbage.
  const mislabelled = {...legacy, v: 2, salt: '00'.repeat(16)};
  await assert.rejects(CryptoEngine.decrypt(mislabelled, HIGH_ENTROPY_KEY),
    'a v1 blob read as v2 must fail the GCM tag check');
});

test('the wrong key fails the authentication tag', async () => {
  const enc = await CryptoEngine.encrypt('secret', HIGH_ENTROPY_KEY);
  await assert.rejects(CryptoEngine.decrypt(enc, 'some-other-key'));
});

test('a short key no longer becomes zero-padded AES material', async () => {
  // The whole point of the change: with v1, "abc" became "abc" + 29 zero bytes.
  // Under HKDF it is still a weak *input*, but it is no longer trivially
  // reconstructible AES material, and two different short keys stay distinct.
  const a = await CryptoEngine.encrypt('m', 'abc');
  await assert.rejects(CryptoEngine.decrypt(a, 'abd'), 'distinct keys must not collide');
  assert.strictEqual(await CryptoEngine.decrypt(a, 'abc'), 'm');
});

test('a malformed blob is rejected cleanly', async () => {
  for (const bad of [null, undefined, {}, {iv: 'aa'}, 'not an object']) {
    await assert.rejects(CryptoEngine.decrypt(bad, HIGH_ENTROPY_KEY),
      `should reject: ${JSON.stringify(bad)}`);
  }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} at-rest-crypto test(s) failed`); process.exit(1); }
console.log('\nAll at-rest-crypto tests passed');
