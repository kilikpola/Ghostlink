/**
 * A Ghost Address is PBKDF2-HMAC-SHA512, everywhere.
 *
 *   Ghost Address / identity   PBKDF2-HMAC-SHA512, salt "ghostlink-yggdrasil-v1"
 *   Legacy Yggdrasil routing   PBKDF2-HMAC-SHA256, same salt
 *
 * Asserts the two really differ, the legacy function is reachable from exactly
 * one place, and no identity path uses SHA-256.
 *
 * Run with: node test/ghost-address-kdf.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {FIXTURE_A} from './helpers/fixture-phrases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── The two derivations must actually disagree ─────────────────────────────

test('SHA-256 and SHA-512 derivation of the same phrase give different keys', async () => {
  const {pbkdf2Async} = await import('@noble/hashes/pbkdf2');
  const {sha512} = await import('@noble/hashes/sha512');
  const {sha256} = await import('@noble/hashes/sha256');
  const utf8 = (s) => new TextEncoder().encode(s);
  const hex = (b) => Buffer.from(b).toString('hex');

  const phrase = FIXTURE_A.join(' ');
  const salt = utf8('ghostlink-yggdrasil-v1');
  const opts = {c: 100000, dkLen: 32};

  const identity = await pbkdf2Async(sha512, utf8(phrase), salt, opts);
  const legacy = await pbkdf2Async(sha256, utf8(phrase), salt, opts);

  assert.notStrictEqual(hex(identity), hex(legacy),
    'if these ever matched, the whole warning would be moot — they must not');
});

test('the shipped Ghost Address derivation is SHA-512 and matches gmp-core', async () => {
  const {deriveIdentityFromSeedPhrase} = await import(path.join(root, 'gmp-core/dist/identity.js'));
  const {ghostAddressFromNodeId} = await import(path.join(root, 'gmp-core/dist/ghost-address.js'));
  const id = await deriveIdentityFromSeedPhrase(
    FIXTURE_A.join(' '));
  const nodeIdHex = id.nodeIdHex || Buffer.from(id.nodeId).toString('hex');
  assert.strictEqual(ghostAddressFromNodeId(nodeIdHex), 'GHOST-Z3H-NMX-81T',
    'the canonical Ghost Address for this phrase changed — identities would be orphaned');
});

// ── No identity path may reach for SHA-256 ─────────────────────────────────

test('gmp-core derives identity with SHA-512 only', () => {
  const src = read('gmp-core/src/identity.ts');
  assert.ok(/pbkdf2\(\s*sha512/.test(src), 'identity.ts must use sha512 for PBKDF2');
  assert.ok(!/pbkdf2\(\s*sha256/.test(src), 'identity.ts must not derive identity with sha256');
});

test("mobile's Ghost identity derivation uses SHA-512 only", () => {
  const src = read('mobile/src/utils/crypto.js');
  const fn = src.slice(src.indexOf('async function deriveGhostIdentity'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // PBKDF2 moved behind a wrapper so it can run natively; the PRF is now an
  // argument rather than an imported function, but the guarantee is unchanged.
  assert.ok(/pbkdf2\(phrase, 'ghostlink-yggdrasil-v1', 'sha512', 100000, 32\)/.test(body),
    'deriveGhostIdentity must derive with sha512, c=100000, dkLen=32');
  assert.ok(!/sha256/.test(body),
    'deriveGhostIdentity must not touch sha256');
});

test('the PBKDF2 wrapper cannot silently change a PRF', () => {
  const src = read('mobile/src/utils/crypto.js');
  // Exactly one place picks a PRF, and it maps the name through verbatim.
  assert.ok(/const prf = hash === 'sha512' \? sha512 : nobleSha256;/.test(src),
    'the wrapper must map the requested hash directly to its PRF');
  // The native side must be handed the same name, not a default.
  assert.ok(/NativePbkdf2\.derive\(phrase, salt, iterations, dkLen, hash\)/.test(src),
    'the native call must pass the caller-requested hash through');
});

test('the SHA-256 derivation is confined to the legacy Yggdrasil function', () => {
  const html = read('index.html');
  // Every PBKDF2 that uses SHA-256 with the mesh salt must be inside the
  // legacy function. There is exactly one such site.
  const meshSaltSha256 = [...html.matchAll(
    /salt: enc\.encode\("ghostlink-yggdrasil-v1"\)[\s\S]{0,120}?hash: "(SHA-\d+)"/g)];
  assert.strictEqual(meshSaltSha256.length, 1,
    `expected exactly one mesh-salt PBKDF2 in index.html, found ${meshSaltSha256.length}`);
  const idx = html.indexOf('async deriveLegacyYggdrasilIP(words) {');
  assert.ok(idx !== -1, 'the legacy function must keep its explicit name');
  const end = html.indexOf('\n  },', idx);
  assert.ok(meshSaltSha256[0].index > idx && meshSaltSha256[0].index < end,
    'the SHA-256 mesh derivation must live inside deriveLegacyYggdrasilIP');
});

// ── The legacy function must stay confined to one call site ────────────────

test('deriveLegacyYggdrasilIP is called from exactly one place in the web app', () => {
  const html = read('index.html');
  const calls = [...html.matchAll(/CryptoEngine\.deriveLegacyYggdrasilIP\s*\(/g)];
  assert.strictEqual(calls.length, 1,
    `expected 1 call site, found ${calls.length} — this must not spread`);
  // And that one call site is the manual mesh setup panel, not identity setup.
  const around = html.slice(Math.max(0, calls[0].index - 1500), calls[0].index);
  assert.ok(/meshAddressInput|meshSeedInput/.test(around),
    'its only caller must be the Ghost Mesh setup panel');
});

test('deriveLegacyYggdrasilIP is called from exactly one place in the mobile app', () => {
  const files = ['mobile/src/components/GhostMeshSetupModal.js',
                 'mobile/src/screens/SettingsScreen.js',
                 'mobile/src/services/CryptoService.js',
                 'mobile/src/utils/capabilities.js'];
  // Strip comments first: this name is referred to in prose in several
  // places on purpose, and prose is not a call site.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  let calls = 0;
  const found = [];
  for (const f of files) {
    const hits = [...stripComments(read(f))
      .matchAll(/CryptoService\.deriveLegacyYggdrasilIP\s*\(/g)];
    calls += hits.length;
    if (hits.length) found.push(`${f} x${hits.length}`);
  }
  assert.strictEqual(calls, 1,
    `expected 1 call site, found ${calls}: ${found.join(', ')}`);
  assert.ok(found[0].startsWith('mobile/src/components/GhostMeshSetupModal.js'),
    `the only caller must be the mesh setup modal, got ${found[0]}`);
});

test('the legacy function carries its warning', () => {
  for (const [file, name] of [['index.html', 'deriveLegacyYggdrasilIP'],
                              ['mobile/src/services/CryptoService.js', 'deriveLegacyYggdrasilIP']]) {
    const src = read(file);
    const idx = src.indexOf(`async ${name}(words)`);
    assert.ok(idx !== -1, `${file}: ${name} not found`);
    const header = src.slice(Math.max(0, idx - 2000), idx);
    assert.ok(/MUST NOT BE USED TO DERIVE A GHOST ADDRESS/.test(header),
      `${file}: the warning header is missing`);
    assert.ok(/SHA-?256/.test(header) && /SHA-?512/.test(header),
      `${file}: the header must say which KDF is which`);
  }
});

test('the old ambiguous names are gone', () => {
  for (const f of ['index.html', 'mobile/src/services/CryptoService.js',
                   'mobile/src/components/GhostMeshSetupModal.js']) {
    assert.ok(!/deriveYggdrasilIdentity/.test(read(f)),
      `${f} still uses the old name, which reads like identity derivation`);
  }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} ghost-address-kdf test(s) failed`); process.exit(1); }
console.log('\nAll ghost-address-kdf tests passed');
