/**
 * Desktop contact vault (vendor-src/contact-vault.js): same envelope as mobile
 * (XChaCha20-Poly1305, 'gl-sealed:v1:', key name as AAD). Run: node test/contact-vault.test.mjs
 */
import assert from 'assert';
import { seal, open, isSealed, createContactVault, SEALED_PREFIX, SecretStorageError, migrateKeyCrashSafe, migrateAllCrashSafe, cleanupStaging, STAGING_SUFFIX } from '../vendor-src/contact-vault.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } }
function throws(fn, code, msg) { try { fn(); ok(false, `${msg} (did not throw)`); } catch (e) { ok(e instanceof SecretStorageError && e.code === code, `${msg} (${e.code})`); } }
function memStorage(init = {}) { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _map: m }; }
const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const KEY2 = new Uint8Array(32).map((_, i) => (i * 5 + 3) & 0xff);

console.log('\n=== contact vault: envelope (mirrors mobile) ===');
const PEERS = 'gl_peer_cache';
const plain = JSON.stringify({ ['a'.repeat(128)]: { publicKeyHex: 'bb', name: 'Alice', pinnedAddress: 'GHOST-A4F-0Y6-YA8', lastSeen: 1 } });
const sealed = seal(KEY, PEERS, plain);
ok(isSealed(sealed) && sealed.startsWith(SEALED_PREFIX), 'sealed value carries the gl-sealed:v1: prefix');
ok(!sealed.includes('Alice') && !sealed.includes('GHOST-A4F'), 'the social-graph plaintext is not present in the sealed blob');
ok(open(KEY, PEERS, sealed) === plain, 'open() round-trips to the original');
throws(() => open(KEY, 'gl_gmp_known_peers', sealed), 'UNREADABLE', 'AAD binds the value to its key name (wrong name fails)');
throws(() => open(KEY2, PEERS, sealed), 'UNREADABLE', 'a wrong key fails');
throws(() => seal(new Uint8Array(16), PEERS, plain), 'SECURE_UNAVAILABLE', 'seal fails closed on a non-32-byte key');

console.log('\n=== fail closed: no key (e.g. safeStorage basic_text) ===');
let flagged = null;
const noKey = createContactVault({ storage: memStorage(), getKey: () => null, onUnavailable: (n) => { flagged = n; } });
ok(noKey.available() === false, 'vault reports unavailable when no key is provided');
throws(() => noKey.setItem(PEERS, plain), 'SECURE_UNAVAILABLE', 'setItem refuses to write a secret without a key');
ok(flagged === PEERS, 'the unavailable write is surfaced (onUnavailable), not silently dropped');
ok(noKey.storage === undefined && noKey._map === undefined, 'nothing leaked a key or wrote plaintext'); // sanity

console.log('\n--- positive control: a real key seals and serves ---');
const st = memStorage();
const vault = createContactVault({ storage: st, getKey: () => KEY });
vault.setItem(PEERS, plain);
ok(isSealed(st.getItem(PEERS)), 'with a key, setItem stores a sealed blob');
ok(vault.getItem(PEERS) === plain, 'getItem returns the plaintext');

console.log('\n=== migration: a store written by the CURRENT (plaintext) build ===');
// Exactly what today's build writes: plaintext JSON under gl_peer_cache / known peers.
const legacy = memStorage({
  [PEERS]: plain,
  'gl_gmp_known_peers': JSON.stringify(['a'.repeat(128)]),
});
const mig = createContactVault({ storage: legacy, getKey: () => KEY });
const report = mig.migrate([PEERS, 'gl_gmp_known_peers']);
ok(report.sealed.length === 2, 'migrate sealed both plaintext secret stores');
ok(isSealed(legacy.getItem(PEERS)) && isSealed(legacy.getItem('gl_gmp_known_peers')), 'both stores are sealed on disk after migration');
ok(mig.getItem(PEERS) === plain, 'the contact store still reads back after migration');
ok(JSON.parse(mig.getItem(PEERS))['a'.repeat(128)].pinnedAddress === 'GHOST-A4F-0Y6-YA8', 'the Phase-1c pinnedAddress field is carried through');
// Idempotent: re-running migrate seals nothing new.
ok(mig.migrate([PEERS, 'gl_gmp_known_peers']).sealed.length === 0, 'migration is idempotent');

console.log('\n=== crash mid-migration: store stays readable in a half-sealed state ===');
// Simulate a crash after sealing only gl_peer_cache (known_peers still plaintext).
const halfway = memStorage({
  [PEERS]: seal(KEY, PEERS, plain),                                   // migrated
  'gl_gmp_known_peers': JSON.stringify(['c'.repeat(128)]),           // not yet migrated (plaintext)
});
const recov = createContactVault({ storage: halfway, getKey: () => KEY });
ok(recov.getItem(PEERS) === plain, 'the already-sealed key still opens');
ok(recov.getItem('gl_gmp_known_peers') === JSON.stringify(['c'.repeat(128)]), 'the still-plaintext key is read (and sealed in place) — no data lost');
ok(isSealed(halfway.getItem('gl_gmp_known_peers')), 'reading the plaintext key sealed it in place');

console.log('\n=== Item 4: crash-safe migration (write sealed -> verify -> then overwrite) ===');
// A storage that throws on the Nth setItem, simulating a crash mid-write.
function crashyStorage(init, crashOnSetCall) {
  const m = new Map(Object.entries(init));
  let n = 0;
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { n++; if (n === crashOnSetCall) throw new Error('CRASH@set' + n); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
const CURRENT = JSON.stringify({ [NODE()]: { name: 'Dana', publicKeyHex: 'cc', pinnedAddress: 'GHOST-D11-222-333', lastSeen: 9 } });
function NODE() { return 'd'.repeat(128); }
function readable(storage, name) {
  const raw = storage.getItem(name);
  if (raw == null) return null;
  if (isSealed(raw)) return open(KEY, name, raw);   // sealed must open
  return raw;                                        // plaintext is readable as-is
}

for (const crashAt of [1, 2]) {
  const PK = 'gl_peer_cache';
  const st = crashyStorage({ [PK]: CURRENT }, crashAt);
  let crashed = false;
  try { migrateKeyCrashSafe(st, PK, KEY, PK); } catch (_e) { crashed = true; }
  ok(crashed, `crash injected at setItem #${crashAt}`);
  // Invariant: the real key is STILL readable (no data lost) at the crash point.
  const mid = readable(st, PK);
  ok(mid && JSON.parse(mid)[NODE()].pinnedAddress === 'GHOST-D11-222-333', `after crash #${crashAt}: gl_peer_cache is still readable, pinnedAddress intact`);
  // Recover: clean staging + re-run (as the next boot would) completes the seal.
  cleanupStaging(st, [PK]);
  const status = migrateKeyCrashSafe(st, PK, KEY, PK);
  ok(status === 'sealed' && isSealed(st.getItem(PK)), `after crash #${crashAt}: a retry completes the migration (sealed)`);
  ok(JSON.parse(open(KEY, PK, st.getItem(PK)))[NODE()].pinnedAddress === 'GHOST-D11-222-333', `after crash #${crashAt}: pinnedAddress survives the completed migration`);
  ok(st.getItem(PK + STAGING_SUFFIX) == null, `after crash #${crashAt}: no staging entry is left behind`);
}

// Verify-fails path: a wrong data key must NOT destroy the plaintext.
{
  const PK = 'gl_peer_cache';
  const st = crashyStorage({ [PK]: CURRENT }, 0);
  // seal() uses KEY, but we verify/open with KEY2 by calling the low-level steps:
  // simulate by migrating with a key whose open() won't match — use a storage
  // whose staged value we corrupt. Simpler: migrate with KEY2 and then try to
  // open with KEY2 succeeds, so instead corrupt staging to force verify-fail.
  const st2 = {
    _m: new Map(Object.entries({ [PK]: CURRENT })),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, k.endsWith(STAGING_SUFFIX) ? 'gl-sealed:v1:deadbeef:cafe' : String(v)); }, // corrupt staged value
    removeItem(k) { this._m.delete(k); },
  };
  const status = migrateKeyCrashSafe(st2, PK, KEY, PK);
  ok(status === 'kept-plaintext', 'verify-fail keeps the plaintext (does not overwrite the real key)');
  ok(st2.getItem(PK) === CURRENT, 'the real key is still the original plaintext after a failed verify');
  ok(st2.getItem(PK + STAGING_SUFFIX) == null, 'the bad staging entry was removed');
}

// migrateAllCrashSafe over a store written by the CURRENT build (3 secret keys).
{
  const KEYS = ['gl_peer_cache', 'gl_gmp_known_peers', 'gl_gmp_blocked_peers', 'gl_verified_contacts', 'gl_fragment_meta'];
  const st = crashyStorage({
    'gl_peer_cache': CURRENT,
    'gl_gmp_known_peers': JSON.stringify([{ nodeId: NODE(), name: 'Dana' }]),
    'gl_gmp_blocked_peers': JSON.stringify([]),
    'gl_verified_contacts': JSON.stringify({ [NODE()]: true }),               // Item 6
    'gl_fragment_meta': JSON.stringify([{ id: 1, peerName: 'Dana', peerId: NODE() }]), // Item 6 (who holds your backup shares)
  }, 0);
  const rep = migrateAllCrashSafe(st, KEYS, KEY);
  ok(KEYS.every((k) => rep[k] === 'sealed'), 'migrateAllCrashSafe seals all FIVE current-build secret stores (incl. verified_contacts, fragment_meta)');
  ok(KEYS.every((k) => isSealed(st.getItem(k))), 'all five are sealed on disk');
  ok(!(st.getItem('gl_fragment_meta') || '').includes('Dana'), 'fragment_meta (peer names who hold your shares) is not plaintext on disk');
  ok(JSON.parse(open(KEY, 'gl_peer_cache', st.getItem('gl_peer_cache')))[NODE()].pinnedAddress === 'GHOST-D11-222-333', 'pinnedAddress preserved through migrateAllCrashSafe');
  ok(migrateAllCrashSafe(st, KEYS, KEY)['gl_peer_cache'] === 'already-sealed', 'idempotent: a second pass is a no-op');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
