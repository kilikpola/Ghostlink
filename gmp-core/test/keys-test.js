/**
 * src/keys.ts: HKDF purpose subkeys of the mesh seed (identity-v2.md §2 #32-34,
 * §5; task R2).
 *
 *   derivePurposeKey(meshSeed, purpose) = HKDF-SHA256(ikm = mesh seed,
 *     salt = none (RFC 5869: 32 zero bytes), info = the purpose's label), 32 B.
 *
 * Every check has a positive control. Vectors are pinned as SHA-256 digest
 * prefixes only (never a key), computed with an INDEPENDENT HKDF
 * (node:crypto hkdfSync, used in this test only) and re-checked under
 * ELECTRON_RUN_AS_NODE=1. The phrase is built from word indices (FIXTURE_A in
 * test/helpers/fixture-phrases.mjs) and is never printed.
 *
 * Run: node test/keys-test.js
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { BIP39_WORDS } from '../dist/bip39-english.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

let keys = null;
try { keys = await import('../dist/keys.js'); } catch (e) { /* A: module absent */ }
console.log('\n=== the module exists ===');
ok(!!keys && typeof keys.derivePurposeKey === 'function' && !!keys.Purpose, 'dist/keys.js exports derivePurposeKey and Purpose');
if (!keys) done();
const { derivePurposeKey, Purpose } = keys;

// identity-v2.md §5: the labels whose IKM is the mesh seed.
const DOC_LABELS = { HISTORY: 'gl-history-v2', STATE: 'gl-state-v2', RATCHET_SEAL: 'gl-ratchet-seal-v1' };
// Pinned with node:crypto hkdfSync over FIXTURE_A's mesh seed: SHA-256(key) prefix.
const PINNED = { HISTORY: 'f4ade127777415ff', STATE: '33d1b83b81bb9430', RATCHET_SEAL: 'fc0b9a97314bbd78' };

const phraseOf = (idx) => idx.map((i) => BIP39_WORDS[i]).join(' ');
const FIXTURE_A = [9, 1151, 1914, 273, 1937, 1234, 729, 1904, 709, 1223, 1947, 576];
const FIXTURE_B = [2002, 179, 526, 1457, 1, 1852, 1723, 1057, 1510, 1797, 548, 730];
const seedA = (await deriveIdentityFromSeedPhrase(phraseOf(FIXTURE_A))).seed;
const seedB = (await deriveIdentityFromSeedPhrase(phraseOf(FIXTURE_B))).seed;
const digest = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
const independent = (seed, label) => Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.alloc(32), label, 32));

console.log('\n=== Purpose is the closed set of identity-v2.md §5 mesh-seed labels ===');
{
  ok(Object.isFrozen(Purpose), 'Purpose is frozen');
  ok(JSON.stringify(Object.entries(Purpose).sort()) === JSON.stringify(Object.entries(DOC_LABELS).sort()),
    `Purpose is exactly ${JSON.stringify(DOC_LABELS)} (got ${JSON.stringify(Purpose)})`);
  let freeForm = null;
  try { derivePurposeKey(seedA, 'gl-history-v3'); } catch (e) { freeForm = e.message; }
  ok(!!freeForm, `a free-form label is refused (${freeForm})`);
  let shortSeed = null;
  try { derivePurposeKey(seedA.slice(0, 31), Purpose.HISTORY); } catch (e) { shortSeed = e.message; }
  ok(!!shortSeed, `a mesh seed that is not 32 bytes is refused (${shortSeed})`);
  ok(derivePurposeKey(seedA, Purpose.HISTORY).length === 32, 'positive control: a Purpose member gives a 32-byte key');
}

console.log('\n=== label uniqueness ===');
{
  // Every label-shaped string literal in src/, except keys.ts itself.
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(ts|js)$/.test(e.name) && e.name !== 'keys.ts') files.push(p); } };
  walk(path.join(pkg, 'src'));
  const labelRe = /['"`]((?:gmp|ghost|ghostlink|gl|ed25519)-[a-z0-9-]+)['"`]/g;
  const existing = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(labelRe)) existing.add(m[1]);
  // The HKDF info strings in src/ (found with `command grep -rn hkdf src`) must all be seen by the scan.
  const HKDF_INFOS = ['gmp-ephemeral-identity-seed-v1', 'gmp-ephemeral-scalar-v1', 'ghost-mesh-hkdf-phase1-initiator',
    'ghost-mesh-hkdf-phase1-responder', 'gmp-relay-circuit-v1', 'gmp-sf-shared-v1', 'gmp-sf-epoch-offset-v1',
    'gmp-sf-tag-v1', 'gmp-sf-bucket-v1', 'gmp-sf-seal-v1'];
  const missed = HKDF_INFOS.filter((l) => !existing.has(l));
  ok(missed.length === 0, `scan control: all ${HKDF_INFOS.length} HKDF info strings in src/ are found by the scan (missed: ${JSON.stringify(missed)})`);
  // §5 "unchanged labels this design relies on": salts, HMAC/HKDF infos, AADs.
  const DOC_UNCHANGED = ['ghostlink-yggdrasil-v1', 'ghostlink-nonce-store-v1', 'ghostlink-peer-cache-v1', 'ghostlink-sf-client-v1',
    'ed25519-signing', 'gmp-topology-sample-v1', 'gmp-sf-client-v2', 'gmp-sf-store-v2', 'gmp-nonce-claim-v1', 'gmp-nonce-ckpt-v1', ...HKDF_INFOS];
  for (const l of DOC_UNCHANGED) existing.add(l);
  console.log(`    ${existing.size} existing labels checked against`);

  const labels = Object.values(Purpose);
  const clash = (list, against) => list.filter((n) => [...against].some((e) => e === n || e.startsWith(n) || n.startsWith(e)));
  ok(new Set(labels).size === labels.length, 'the new labels are pairwise distinct');
  ok(labels.every((a) => labels.every((b) => a === b || !a.startsWith(b))), 'no new label prefixes another');
  assertAbsent({
    channel: 'a new label equal to, or a prefix of, an existing label',
    controlMessage: 'a planted duplicate (gl-history-v2) and a planted prefix (gl-state) are both caught',
    control: () => clash(labels, new Set([...existing, 'gl-history-v2', 'gl-state'])).length,
    absent: () => clash(labels, existing).length === 0,
    message: `no new label equals or prefixes any of the ${existing.size} existing labels`,
  });
  const elsewhere = files.filter((f) => labels.some((l) => fs.readFileSync(f, 'utf8').includes(l)));
  ok(elsewhere.length === 0, `the new labels appear in src/ only in keys.ts (${JSON.stringify(elsewhere.map((f) => path.relative(pkg, f)))})`);

  // R4: the ratchet's KDF and AD labels (§5) join the set; checked against everything
  // in src/ outside src/ratchet/ratchet.ts, and against each other and the Purpose labels.
  const RATCHET_LABELS = ['gl-ratchet-rk-v1', 'gl-ratchet-mk-v1', 'gl-ratchet-ad-v1'];
  let ratchet = null;
  try { ratchet = await import('../dist/ratchet/ratchet.js'); } catch { /* A: module absent */ }
  ok(!!ratchet && JSON.stringify(Object.values(ratchet.LABELS).sort()) === JSON.stringify([...RATCHET_LABELS].sort()),
    `dist/ratchet/ratchet.js LABELS are exactly ${JSON.stringify(RATCHET_LABELS)} (got ${ratchet ? JSON.stringify(ratchet.LABELS) : 'no module'})`);
  const ratchetSrc = path.join(pkg, 'src', 'ratchet', 'ratchet.ts');
  const outsideRatchet = new Set(DOC_UNCHANGED);
  for (const f of files.filter((x) => x !== ratchetSrc)) for (const m of fs.readFileSync(f, 'utf8').matchAll(labelRe)) outsideRatchet.add(m[1]);
  for (const l of labels) outsideRatchet.add(l);
  const all = [...labels, ...RATCHET_LABELS];
  ok(new Set(all).size === all.length && all.every((a) => all.every((b) => a === b || !a.startsWith(b))),
    `the ${all.length} new labels (Purpose + ratchet) are pairwise distinct and none prefixes another`);
  const ratchetClash = (against) => RATCHET_LABELS.filter((n) => [...against].some((e) => e === n || e.startsWith(n) || n.startsWith(e)));
  assertAbsent({
    channel: 'a ratchet label equal to, or a prefix of, an existing label',
    controlMessage: 'a planted duplicate (gl-ratchet-mk-v1) and a planted prefix (gl-ratchet-rk) are both caught',
    control: () => ratchetClash(new Set([...outsideRatchet, 'gl-ratchet-mk-v1', 'gl-ratchet-rk'])).length === 2,
    absent: () => ratchetClash(outsideRatchet).length === 0,
    message: `no ratchet label equals or prefixes any of the ${outsideRatchet.size} labels outside the ratchet`,
  });
  const ratchetElsewhere = files.filter((f) => f !== ratchetSrc && RATCHET_LABELS.some((l) => fs.readFileSync(f, 'utf8').includes(l)));
  ok(fs.existsSync(ratchetSrc) && ratchetElsewhere.length === 0,
    `the ratchet labels appear in src/ only in ratchet/ratchet.ts (${JSON.stringify(ratchetElsewhere.map((f) => path.relative(pkg, f)))})`);

  // R5: the ratchet store's AAD prefix (§5) and its file-name key label.
  const STORE_LABELS = ['gl-ratchet-state-v1', 'gl-ratchet-file-v1'];
  let store = null;
  try { store = await import('../dist/ratchet/ratchet-store.js'); } catch { /* A: module absent */ }
  ok(!!store && JSON.stringify(Object.values(store.STORE_LABELS).sort()) === JSON.stringify([...STORE_LABELS].sort()),
    `dist/ratchet/ratchet-store.js STORE_LABELS are exactly ${JSON.stringify(STORE_LABELS)} (got ${store ? JSON.stringify(store.STORE_LABELS) : 'no module'})`);
  const storeSrc = path.join(pkg, 'src', 'ratchet', 'ratchet-store.ts');
  const outsideStore = new Set(DOC_UNCHANGED);
  for (const f of files.filter((x) => x !== storeSrc)) for (const m of fs.readFileSync(f, 'utf8').matchAll(labelRe)) outsideStore.add(m[1]);
  for (const l of [...labels, ...RATCHET_LABELS]) outsideStore.add(l);
  const every = [...labels, ...RATCHET_LABELS, ...STORE_LABELS];
  ok(new Set(every).size === every.length && every.every((a) => every.every((b) => a === b || !a.startsWith(b))),
    `the ${every.length} new labels (Purpose + ratchet + store) are pairwise distinct and none prefixes another`);
  const storeClash = (against) => STORE_LABELS.filter((x) => [...against].some((e) => e === x || e.startsWith(x) || x.startsWith(e)));
  assertAbsent({
    channel: 'a store label equal to, or a prefix of, an existing label',
    controlMessage: 'a planted duplicate (gl-ratchet-file-v1) and a planted prefix (gl-ratchet-state) are both caught',
    control: () => storeClash(new Set([...outsideStore, 'gl-ratchet-file-v1', 'gl-ratchet-state'])).length === 2,
    absent: () => storeClash(outsideStore).length === 0,
    message: `no store label equals or prefixes any of the ${outsideStore.size} labels outside the store`,
  });
  // R6: X3DH-lite's info label (§5), only in ratchet/x3dh.ts.
  const X3DH_LABELS = ['gl-x3dh-v1'];
  let x3 = null;
  try { x3 = await import('../dist/ratchet/x3dh.js'); } catch { /* A: module absent */ }
  ok(!!x3 && x3.X3DH_LABEL === X3DH_LABELS[0], `dist/ratchet/x3dh.js X3DH_LABEL is ${X3DH_LABELS[0]} (got ${x3 ? x3.X3DH_LABEL : 'no module'})`);
  const x3Src = path.join(pkg, 'src', 'ratchet', 'x3dh.ts');
  const outsideX3 = new Set(DOC_UNCHANGED);
  for (const f of files.filter((x) => x !== x3Src)) for (const m of fs.readFileSync(f, 'utf8').matchAll(labelRe)) outsideX3.add(m[1]);
  for (const l of [...labels, ...RATCHET_LABELS, ...STORE_LABELS]) outsideX3.add(l);
  const all7 = [...labels, ...RATCHET_LABELS, ...STORE_LABELS, ...X3DH_LABELS];
  ok(new Set(all7).size === all7.length && all7.every((a) => all7.every((b) => a === b || !a.startsWith(b))),
    `the ${all7.length} new labels (Purpose + ratchet + store + x3dh) are pairwise distinct and none prefixes another`);
  const x3Clash = (against) => X3DH_LABELS.filter((x) => [...against].some((e) => e === x || e.startsWith(x) || x.startsWith(e)));
  assertAbsent({
    channel: 'the x3dh label equal to, or a prefix of, an existing label',
    controlMessage: 'a planted duplicate (gl-x3dh-v1) and a planted prefix (gl-x3dh) are both caught',
    control: () => x3Clash(new Set(['gl-x3dh-v1'])).length === 1 && x3Clash(new Set(['gl-x3dh'])).length === 1,
    absent: () => x3Clash(outsideX3).length === 0,
    message: `gl-x3dh-v1 equals or prefixes none of the ${outsideX3.size} labels outside x3dh.ts`,
  });
  const x3Elsewhere = files.filter((f) => f !== x3Src && f !== path.join(pkg, 'src', 'keys.ts') && X3DH_LABELS.some((l) => fs.readFileSync(f, 'utf8').includes(l)));
  ok(fs.existsSync(x3Src) && x3Elsewhere.length === 0, `gl-x3dh-v1 appears in src/ only in ratchet/x3dh.ts (${JSON.stringify(x3Elsewhere.map((f) => path.relative(pkg, f)))})`);
  const storeElsewhere = files.filter((f) => f !== storeSrc && STORE_LABELS.some((l) => fs.readFileSync(f, 'utf8').includes(l)));
  ok(fs.existsSync(storeSrc) && storeElsewhere.length === 0,
    `the store labels appear in src/ only in ratchet/ratchet-store.ts (${JSON.stringify(storeElsewhere.map((f) => path.relative(pkg, f)))})`);
}

console.log('\n=== fixed vectors (FIXTURE_A), cross-checked against node:crypto hkdfSync ===');
const keysA = {};
{
  const pbkdf2 = crypto.pbkdf2Sync(phraseOf(FIXTURE_A), 'ghostlink-yggdrasil-v1', 100000, 32, 'sha512');
  ok(Buffer.from(seedA).equals(pbkdf2), 'the mesh seed used is the real one (identity.ts == independent PBKDF2)');
  for (const name of Object.keys(DOC_LABELS)) {
    const k = derivePurposeKey(seedA, Purpose[name]);
    keysA[name] = k;
    ok(Buffer.from(k).equals(independent(seedA, DOC_LABELS[name])), `${name}: equals the independent HKDF`);
    ok(digest(k) === PINNED[name], `${name}: SHA-256 prefix ${digest(k)} matches the pin ${PINNED[name]}`);
  }
}

console.log('\n=== domain separation ===');
{
  const hex = Object.values(keysA).map((k) => Buffer.from(k).toString('hex'));
  ok(new Set(hex).size === hex.length && hex.length === 3, 'the three purpose keys of one seed are pairwise different');
  ok(!hex.includes(Buffer.from(seedA).toString('hex')), 'no purpose key equals the seed');
  const b = Object.keys(DOC_LABELS).map((n) => Buffer.from(derivePurposeKey(seedB, Purpose[n])).toString('hex'));
  ok(b.every((k) => !hex.includes(k)), 'a different seed (FIXTURE_B) gives different keys for every purpose');
  ok(Buffer.from(derivePurposeKey(seedA, Purpose.STATE)).equals(Buffer.from(keysA.STATE)), 'positive control: the same seed and purpose give the same key');
}

console.log('\n=== Electron main runtime (ELECTRON_RUN_AS_NODE=1) ===');
let electronOut = '';
{
  let bin = null;
  try { bin = createRequire(path.join(pkg, '..', 'package.json'))('electron'); } catch { bin = null; }
  if (!bin || !fs.existsSync(bin)) {
    console.log('  ~ Electron binary not found next to gmp-core — skipped');
  } else {
    const child = `
      const { BIP39_WORDS } = await import(${JSON.stringify(path.join(pkg, 'dist', 'bip39-english.js'))});
      const { deriveIdentityFromSeedPhrase } = await import(${JSON.stringify(path.join(pkg, 'dist', 'identity.js'))});
      const { derivePurposeKey, Purpose } = await import(${JSON.stringify(path.join(pkg, 'dist', 'keys.js'))});
      const { createHash } = await import('crypto');
      const seed = (await deriveIdentityFromSeedPhrase(${JSON.stringify(FIXTURE_A)}.map((i) => BIP39_WORDS[i]).join(' '))).seed;
      const out = { electron: process.versions.electron, node: process.versions.node };
      for (const n of Object.keys(Purpose)) out[n] = createHash('sha256').update(derivePurposeKey(seed, Purpose[n])).digest('hex').slice(0, 16);
      console.log(JSON.stringify(out));`;
    const r = spawnSync(bin, ['--input-type=module', '-e', child], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
    electronOut = (r.stdout || '') + (r.stderr || '');
    let got = null;
    try { got = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { got = null; }
    ok(!!got && !!got.electron, `ran under Electron ${got && got.electron} (Node ${got && got.node})`);
    for (const name of Object.keys(DOC_LABELS)) ok(!!got && got[name] === PINNED[name], `Electron ${name}: ${got && got[name]} matches the pin`);
  }
}

console.log('\n=== nothing secret leaks ===');
{
  // Capture every console / stdout / stderr write while the module is used.
  const captured = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
    out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => captured.push(a.map(String).join(' '));
  process.stdout.write = (c, ...r) => { captured.push(String(c)); return true; };
  process.stderr.write = (c, ...r) => { captured.push(String(c)); return true; };
  let fresh;
  try {
    console.log('capture-probe-console'); process.stdout.write('capture-probe-stdout\n');
    fresh = await import(`../dist/keys.js?leakcheck=${Date.now()}`);
    for (const n of Object.keys(DOC_LABELS)) fresh.derivePurposeKey(seedA, fresh.Purpose[n]);
    try { fresh.derivePurposeKey(seedA, 'gl-not-a-purpose'); } catch { /* refused; its message is captured too */ }
    try { fresh.derivePurposeKey(seedA.slice(1), fresh.Purpose.STATE); } catch { /* likewise */ }
  } finally {
    Object.assign(console, { log: orig.log, info: orig.info, warn: orig.warn, error: orig.error, debug: orig.debug });
    process.stdout.write = orig.out; process.stderr.write = orig.err;
  }
  const secrets = [seedA, ...Object.values(keysA)].flatMap((k) => {
    const b = Buffer.from(k); return [b.toString('hex'), b.toString('base64'), b.toString('hex').slice(0, 24), Array.from(b).join(',')];
  });
  const leaks = (text) => secrets.filter((s) => text.includes(s)).length;
  const logText = captured.join('\n') + '\n' + electronOut;
  ok(logText.includes('capture-probe-console') && logText.includes('capture-probe-stdout'),
    `capture control: a console line and a raw stdout write made in the window were both captured (${captured.length} writes)`);
  assertAbsent({
    channel: 'seed or purpose-key bytes in captured log output',
    controlMessage: 'a planted log line with a purpose key in hex is caught by the same matcher',
    control: () => leaks(`[keys] derived ${Buffer.from(keysA.HISTORY).toString('hex')}`),
    absent: () => leaks(logText) === 0,
    message: `no seed or key bytes in the ${captured.length} captured writes (2 are the probes) or the Electron child's output`,
  });
  const src = fs.readFileSync(path.join(pkg, 'src', 'keys.ts'), 'utf8');
  const forbidden = /from ['"](node:)?crypto['"]|require\(['"](node:)?crypto['"]\)|console\.|logger|from ['"]\.\/logger/;
  assertAbsent({
    channel: 'node:crypto, console or logger in src/keys.ts',
    controlMessage: 'the matcher finds a planted "import crypto from \'crypto\'" and a planted console.log',
    control: () => (forbidden.test("import crypto from 'crypto';") && forbidden.test('console.log(seed)') ? 1 : 0),
    absent: () => !forbidden.test(src),
    message: 'keys.ts uses only @noble/hashes and never logs',
  });
  ok(Object.keys(keys).every((k) => !/seed/i.test(k)) && Object.keys(keys).sort().join(',') === 'Purpose,derivePurposeKey',
    `the module exports only Purpose and derivePurposeKey (${Object.keys(keys).sort().join(', ')})`);
  const k = derivePurposeKey(seedA, Purpose.HISTORY);
  ok(k.buffer !== seedA.buffer, 'the returned key does not share memory with the seed');
}

done();
