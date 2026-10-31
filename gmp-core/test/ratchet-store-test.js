/**
 * src/ratchet/ratchet-store.ts — sealed ratchet store with write-ahead and
 * rollback detection (identity-v2.md §4.5, D12, Q8; task R5). Every negative
 * has a positive control.
 *
 *  1. crash injection (real SIGKILL in a child process) at every step of send
 *     and receive; no (key, nonce) is ever derived twice for sending and no
 *     plaintext is ever released twice; control: restoring an old state file
 *     IS caught as rollback.
 *  2. persist failure (anchor or state file) releases no ciphertext / plaintext.
 *  3. rollback: old file copied back, file missing with an anchor entry,
 *     foreign installId, anchor missing with files; fresh install starts clean.
 *  4. locked / insecure anchor and the browser build: memory-only, nothing written.
 *  5. two processes, one store: exactly one owns it, many rounds.
 *  6. sealing: no state or key material on disk (planted control).
 *  7. undecryptable file: refused, byte-identical, never overwritten.
 *  8. factory: a ratchet node without a store or explicit memory-only mode
 *     refuses with RatchetStoreRequiredError.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { absenceAsserter } from './helpers/assert-absent.mjs';
import { fileAnchor, readLines } from './helpers/ratchet-store-helpers.mjs';
import { x25519 } from '@noble/curves/ed25519';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

let S = null;
try { S = await import('../dist/ratchet/ratchet-store.js'); } catch (e) { console.log(`  (import failed: ${e.code || e.message})`); }
console.log('\n=== the module exists ===');
ok(!!S && typeof S.openRatchetStore === 'function' && typeof S.memoryOnlyRatchetStore === 'function' && typeof S.ratchetSealKey === 'function',
  'dist/ratchet/ratchet-store.js exports openRatchetStore / memoryOnlyRatchetStore / ratchetSealKey');
if (!S) done();
const R = await import('../dist/ratchet/ratchet.js');
const { Purpose, derivePurposeKey } = await import('../dist/keys.js');
const { createGMPNode } = await import('../dist/node-factory.js');
const { default: logger } = await import('../dist/logger.js');

// ── helpers ───────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-store-'));
let n = 0;
const fresh = (label) => { const d = path.join(root, `${String(++n).padStart(3, '0')}-${label}`); fs.mkdirSync(d); return { dir: path.join(d, 'ratchets'), anchorFile: path.join(d, 'keyring', 'anchor.json'), base: d }; };
const MESH_SEED = new Uint8Array(crypto.createHash('sha256').update('r5 test mesh seed').digest());
const SEAL = S.ratchetSealKey(MESH_SEED);
const A_ID = 'a1'.repeat(64), B_ID = 'b2'.repeat(64), C_ID = 'c3'.repeat(64);
const deps = () => ({ rng: (k) => new Uint8Array(crypto.randomBytes(k)), now: () => Date.now() });
const te = (s) => new TextEncoder().encode(s);
const td = (b) => new TextDecoder().decode(b);
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ratchet')) : []);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Alice (store side) and Bob (pure) with sending chains both ways. */
function sessionPair(peer = B_ID) {
  const rootKey = new Uint8Array(crypto.randomBytes(32));
  const bPriv = new Uint8Array(crypto.randomBytes(32));
  const bPub = x25519.getPublicKey(bPriv);
  let alice = R.initSender({ rootKey, remoteDhPub: bPub, selfNodeId: A_ID, peerNodeId: peer }, deps());
  let bob = R.initReceiver({ rootKey, selfDh: { priv: bPriv, pub: bPub }, selfNodeId: peer, peerNodeId: A_ID }, deps());
  const e = R.encrypt(alice, te('hello'), deps()); alice = e.state;
  bob = R.decrypt(bob, e.message, deps()).state;
  const r = R.encrypt(bob, te('hi back'), deps()); bob = r.state;
  alice = R.decrypt(alice, r.message, deps()).state;
  return { alice, bob };
}
function open(env, extra = {}) {
  const a = extra.anchor || fileAnchor(env.anchorFile);
  return S.openRatchetStore({ dir: env.dir, sealKey: SEAL, anchor: a.provider, ...extra, anchor: a.provider });
}
/** Capture every logger line while fn runs. */
function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { const s = a.join(' '); if (s.startsWith('{"ts"')) lines.push(JSON.parse(s)); else orig[k](...a); };
  try { return { value: fn(), lines }; } catch (e) { return { error: e, lines }; } finally { Object.assign(console, orig); }
}
function child(job) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, 'helpers', 'ratchet-store-child.mjs'), JSON.stringify({ sealKey: Buffer.from(SEAL).toString('hex'), ...job })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code, signal) => resolve({ code, signal, lines: stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }), stderr }));
  });
}
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ── 3. fresh install, normal restart ──────────────────────────────────────
console.log('\n=== fresh install and a clean restart ===');
{
  const env = fresh('fresh');
  const a = fileAnchor(env.anchorFile);
  const st = open(env, { anchor: a });
  ok(st.startup.mode === 'sealed' && !st.startup.rollback && a.box.saves === 1 && fs.existsSync(env.anchorFile),
    `no anchor and no files: a normal sealed start; the anchor (installId) is created (${JSON.stringify(st.startup)})`);
  const { alice, bob } = sessionPair();
  st.put(B_ID, alice);
  const m = st.send(B_ID, te('one'), deps());
  ok(R.decrypt(bob, m, deps()).ok, 'a message sent through the store decrypts at the peer');
  const before = R.serializeState(st.get(B_ID));
  st.close();
  const st2 = open(env);
  ok(!st2.startup.rollback && st2.has(B_ID) && R.serializeState(st2.get(B_ID)) === before, 'control: a clean restart resumes the exact state');
  st2.close();
}

// ── 1. crash injection ────────────────────────────────────────────────────
console.log('\n=== 1. crash injection (SIGKILL) at every step: no key twice, no plaintext twice ===');
{
  const sendPoints = ['send:anchored', 'send:computed', 'send:persisted'];
  const recvPoints = ['receive:computed', 'receive:anchored', 'receive:persisted'];
  const allSendKeys = [];
  const expectDiscard = { 'send:anchored': true, 'send:computed': true, 'send:persisted': false, 'receive:computed': false, 'receive:anchored': true, 'receive:persisted': false };
  for (const point of sendPoints) {
    const env = fresh(point.replace(':', '-'));
    const { alice, bob } = sessionPair();
    const st = open(env); st.put(B_ID, alice); st.close();
    const keys = path.join(env.base, 'keys'), released = path.join(env.base, 'released');
    const c1 = await child({ action: 'send', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, count: 4, tag: 'pre', crashAt: { point, index: 2 }, keysOut: keys, releasedOut: released });
    const c2 = await child({ action: 'send', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, count: 4, tag: 'post', keysOut: keys, releasedOut: released });
    const startup = c2.lines.find((l) => l.opened)?.startup || {};
    const encKeys = readLines(keys).filter((l) => l.startsWith('encrypt ')).map((l) => l.slice(8));
    allSendKeys.push(...encKeys);
    let b = bob, decrypted = 0, bad = 0;
    for (const hex of readLines(released)) { const d = R.decrypt(b, Buffer.from(hex, 'hex'), deps()); if (d.ok) { b = d.state; decrypted++; } else bad++; }
    const discarded = !!startup.rollback;
    ok(c1.signal === 'SIGKILL' && discarded === expectDiscard[point] && new Set(encKeys).size === encKeys.length && bad === 0,
      `${point}: killed (${c1.signal}); restart ${discarded ? `discards (${startup.rollback.reason})` : 'resumes'}; ${encKeys.length} send keys derived, all distinct; ${decrypted} released messages decrypt, ${bad} fail`);
  }
  ok(new Set(allSendKeys).size === allSendKeys.length && allSendKeys.length >= 12, `across all send crashes: ${allSendKeys.length} (key, nonce) derived, 0 repeated`);
  for (const point of recvPoints) {
    const env = fresh(point.replace(':', '-'));
    let { alice, bob } = sessionPair();
    const st = open(env); st.put(B_ID, alice); st.close();
    const msgsIn = path.join(env.base, 'msgs'), released = path.join(env.base, 'released'), keys = path.join(env.base, 'keys');
    const texts = ['b-0', 'b-1', 'b-2'];
    fs.writeFileSync(msgsIn, texts.map((t) => { const e = R.encrypt(bob, te(t), deps()); bob = e.state; return Buffer.from(e.message).toString('hex'); }).join('\n') + '\n');
    const c1 = await child({ action: 'receive', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, messagesIn: msgsIn, crashAt: { point, index: 1 }, releasedOut: released, keysOut: keys });
    const c2 = await child({ action: 'receive', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, messagesIn: msgsIn, releasedOut: released, keysOut: keys });
    const startup = c2.lines.find((l) => l.opened)?.startup || {};
    const rel = readLines(released);
    const discarded = !!startup.rollback;
    const twice = rel.filter((t, i) => rel.indexOf(t) !== i);
    const expected = { 'receive:computed': ['b-0', 'b-1', 'b-2'], 'receive:anchored': ['b-0'], 'receive:persisted': ['b-0', 'b-2'] }[point];
    ok(c1.signal === 'SIGKILL' && discarded === expectDiscard[point] && twice.length === 0 && JSON.stringify(rel) === JSON.stringify(expected),
      `${point}: killed; restart ${discarded ? `discards (${startup.rollback.reason})` : 'resumes'}; released ${JSON.stringify(rel)}, none twice`);
  }
  // Control: a deliberate restore of an old state file IS caught.
  const env = fresh('restore-control');
  const { alice } = sessionPair();
  const st = open(env); st.put(B_ID, alice);
  const [file] = files(env.dir);
  const snapshot = fs.readFileSync(path.join(env.dir, file));
  st.send(B_ID, te('x'), deps()); st.send(B_ID, te('y'), deps()); st.close();
  fs.writeFileSync(path.join(env.dir, file), snapshot);
  const back = open(env);
  ok(back.startup.rollback?.reason === 'generation-behind' && !back.has(B_ID), `control: copying an old state file back is caught as rollback (${back.startup.rollback?.reason}); the ratchet is not resumed`);
  back.close();
}

// ── 2. persist failure ────────────────────────────────────────────────────
console.log('\n=== 2. persist failure releases nothing ===');
{
  const env = fresh('persist-fail');
  const a = fileAnchor(env.anchorFile);
  let { alice, bob } = sessionPair();
  // D2: the write failure is injected at the store's writer (permission bits do not stop root, i.e. CI).
  const { writeFileAtomicSync } = await import('../dist/atomic-file.js');
  let failWrites = false;
  const writeFile = (f, b) => { if (failWrites) throw Object.assign(new Error('EIO: injected state-file write failure'), { code: 'EIO' }); return writeFileAtomicSync(f, b); };
  const st = open(env, { anchor: a, writeFile }); st.put(B_ID, alice);
  const stateBefore = R.serializeState(st.get(B_ID));
  a.box.failSaves = true;
  let got = null;
  const e1 = caught(() => { got = st.send(B_ID, te('never'), deps()); });
  ok(e1?.name === 'RatchetPersistError' && got === null && R.serializeState(st.get(B_ID)) === stateBefore,
    `anchor write fails: ${e1?.name}, no ciphertext, state unchanged`);
  a.box.failSaves = false;
  const okSend = st.send(B_ID, te('after anchor recovers'), deps());
  ok(okSend instanceof Uint8Array && R.decrypt(bob, okSend, deps()).ok, 'control: once the anchor accepts writes, sending works (nothing was poisoned: no key had been derived)');
  // State-file write fails after the key was derived: no ciphertext, and the session is poisoned.
  failWrites = true;
  got = null;
  const e2 = caught(() => { got = st.send(B_ID, te('never either'), deps()); });
  failWrites = false;
  ok(e2?.name === 'RatchetPersistError' && got === null, `state file write fails: ${e2?.name}, no ciphertext released`);
  const e3 = caught(() => st.send(B_ID, te('retry'), deps()));
  ok(e3?.name === 'RatchetSessionPoisonedError', `the derived-but-unpersisted key is never used again in this run (${e3?.name})`);
  st.close();
  const re = open(env);
  ok(re.startup.rollback?.reason === 'generation-behind' && !re.has(B_ID), `and the restart discards that ratchet (${re.startup.rollback?.reason}) instead of re-deriving the key`);
  re.close();
  // Receive: persist failure releases no plaintext.
  const env2 = fresh('persist-fail-recv');
  const a2 = fileAnchor(env2.anchorFile);
  ({ alice, bob } = sessionPair());
  const st2 = open(env2, { anchor: a2 }); st2.put(B_ID, alice);
  const msg = R.encrypt(bob, te('secret'), deps()).message;
  a2.box.failSaves = true;
  let r = null;
  const e4 = caught(() => { r = st2.receive(B_ID, msg, deps()); });
  ok(e4?.name === 'RatchetPersistError' && r === null, `receive with the anchor failing: ${e4?.name}, no plaintext`);
  a2.box.failSaves = false;
  const r2 = st2.receive(B_ID, msg, deps());
  ok(r2.ok && td(r2.plaintext) === 'secret', 'control: the same message decrypts once persisting works');
  st2.close();
}

// ── 3. rollback variants, log channel ─────────────────────────────────────
console.log('\n=== 3. rollback: detected, every ratchet discarded, logged at CRITICAL ===');
{
  const env = fresh('rollback');
  const st = open(env);
  st.put(B_ID, sessionPair(B_ID).alice); st.put(C_ID, sessionPair(C_ID).alice);
  const fileB = path.join(env.dir, files(env.dir).find((f) => f === S.ratchetFileName(SEAL, B_ID)));
  const old = fs.readFileSync(fileB);
  st.send(B_ID, te('advance'), deps());
  st.close();
  fs.writeFileSync(fileB, old);
  const events = [];
  const cap = captureLogs(() => open(env, { on: { 'ratchet-rollback': (i) => events.push(i) } }));
  const rb = cap.value;
  const crit = cap.lines.filter((l) => l.event === 'ratchet-rollback' && l.level === 'CRITICAL');
  ok(rb.startup.rollback?.reason === 'generation-behind' && !rb.has(B_ID) && !rb.has(C_ID) && files(env.dir).length === 0,
    `one contact rolled back: BOTH ratchets discarded, files removed (${files(env.dir).length} left)`);
  ok(JSON.stringify([...rb.needsRehandshake()].sort()) === JSON.stringify([B_ID, C_ID].sort()) && events.length === 1 && events[0].peers.length === 2,
    'both contacts are marked for re-handshake, and one ratchet-rollback event says so');
  rb.close();
  const clean = captureLogs(() => open(env));
  clean.value.close();
  assertAbsent({
    channel: 'CRITICAL ratchet-rollback log lines on a clean start',
    controlMessage: 'the rollback start wrote one',
    control: () => crit.length,
    absent: () => clean.lines.filter((l) => l.event === 'ratchet-rollback').length === 0,
    message: 'a clean restart logs no rollback',
  });
  const saved = logger.settings.level;
  logger.settings.level = 'CRITICAL';
  const st3 = open(env); st3.put(B_ID, sessionPair().alice); st3.close();
  fs.rmSync(path.join(env.dir, S.ratchetFileName(SEAL, B_ID)));
  const quiet = captureLogs(() => open(env));
  logger.settings.level = saved;
  ok(quiet.value.startup.rollback?.reason === 'file-missing' && quiet.lines.some((l) => l.event === 'ratchet-rollback'),
    `file missing while the anchor has its generation → rollback (${quiet.value.startup.rollback?.reason}), logged even at GMP_LOG_LEVEL=CRITICAL`);
  quiet.value.close();
  // Foreign installId (a phrase restore / another install's files).
  const envF = fresh('foreign');
  const sf = open(envF); sf.put(B_ID, sessionPair().alice); sf.close();
  const a = JSON.parse(fs.readFileSync(envF.anchorFile, 'utf8'));
  fs.writeFileSync(envF.anchorFile, JSON.stringify({ ...a, installId: 'ff'.repeat(16) }));
  const foreign = open(envF);
  ok(foreign.startup.rollback?.reason === 'install-mismatch' && !foreign.has(B_ID), `a file from another installId is discarded (${foreign.startup.rollback?.reason})`);
  foreign.close();
  // Files but no anchor at all (keyring wiped / restored elsewhere).
  const envN = fresh('no-anchor');
  const sn = open(envN); sn.put(B_ID, sessionPair().alice); sn.close();
  fs.rmSync(envN.anchorFile);
  const noAnchor = open(envN);
  ok(noAnchor.startup.rollback?.reason === 'anchor-missing' && !noAnchor.has(B_ID) && fs.existsSync(envN.anchorFile), `files without an anchor are discarded (${noAnchor.startup.rollback?.reason}) and a new anchor is made`);
  noAnchor.close();
}

// ── 4. memory-only ────────────────────────────────────────────────────────
console.log('\n=== 4. locked / insecure keyring and the browser build: memory-only, nothing written ===');
for (const status of ['locked', 'insecure', 'unavailable']) {
  const env = fresh(`mem-${status}`);
  const a = fileAnchor(env.anchorFile, { status });
  const events = [];
  const cap = captureLogs(() => open(env, { anchor: a, on: { 'ratchet-memory-only': (i) => events.push(i) } }));
  const st = cap.value;
  const { alice, bob } = sessionPair();
  st.put(B_ID, alice);
  const m = st.send(B_ID, te('in memory'), deps());
  ok(st.startup.mode === 'memory-only' && R.decrypt(bob, m, deps()).ok && events.length === 1 && cap.lines.some((l) => l.event === 'ratchet-memory-only'),
    `${status}: memory-only (${st.startup.memoryOnlyReason}); sending works; one event and one log line`);
  st.close();
  ok(!fs.existsSync(env.dir) && a.box.saves === 0 && !fs.existsSync(env.anchorFile), `${status}: nothing written — no store directory, no anchor write`);
}
{
  const st = S.memoryOnlyRatchetStore('browser build: no OS secure storage (identity-v2.md Q8)');
  ok(st.startup.mode === 'memory-only' && /Q8/.test(st.startup.memoryOnlyReason), 'browser build: an explicit memory-only store, with its reason');
  const e = caught(() => S.memoryOnlyRatchetStore(''));
  ok(e?.name === 'RatchetStoreRequiredError', `control: memory-only without a stated reason is refused (${e?.name})`);
}

// ── 5. two processes ──────────────────────────────────────────────────────
console.log('\n=== 5. two processes, one store: exactly one owner ===');
{
  const ROUNDS = 20, PROCS = 4;
  let exactlyOne = 0, lostOrMerged = 0, loserNames = new Set();
  for (let round = 0; round < ROUNDS; round++) {
    const env = fresh(`race-${round}`);
    const st = open(env); st.put(B_ID, sessionPair().alice); st.close();
    const goFile = path.join(env.base, 'go');
    const statuses = Array.from({ length: PROCS }, (_, i) => path.join(env.base, `status-${i}`));
    const runs = statuses.map((statusOut) => child({ action: 'hold', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, statusOut, goFile }));
    const deadline = Date.now() + 20000;
    while (statuses.filter((f) => readLines(f).length).length < PROCS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(goFile, '');
    await Promise.all(runs);
    const results = statuses.map((f) => readLines(f));
    const winners = results.filter((r) => r[0] === 'WON');
    results.filter((r) => r[0] !== 'WON').forEach((r) => loserNames.add(r[0]));
    if (winners.length === 1) exactlyOne++;
    const final = winners[0]?.find((l) => l.startsWith('FINAL '))?.slice(6);
    const check = open(env);
    if (!(check.has(B_ID) && !check.startup.rollback && sha(R.serializeState(check.get(B_ID))) === final)) lostOrMerged++;
    check.close();
  }
  ok(exactlyOne === ROUNDS, `${ROUNDS} rounds × ${PROCS} processes started together: exactly one owner every round (${exactlyOne}/${ROUNDS}); the rest: ${[...loserNames].join(', ')}`);
  ok(lostOrMerged === 0, `the state on disk is exactly the winner's final state every round (${lostOrMerged} lost or merged)`);
  const env = fresh('dead-owner');
  const st = open(env); st.put(B_ID, sessionPair().alice); st.close();
  const statusOut = path.join(env.base, 'status');
  const dead = await child({ action: 'die-holding', dir: env.dir, anchorFile: env.anchorFile, peer: B_ID, statusOut });
  const after = open(env);
  ok(dead.signal === 'SIGKILL' && readLines(statusOut)[0] === 'WON' && after.has(B_ID), 'control: an owner that died is taken over by the next start (refusal is about live owners)');
  after.close();
  const live = open(env);
  const second = caught(() => open(env));
  ok(second?.name === 'RatchetStoreInUseError', `control: a second open in the same process while the first is live is refused too (${second?.name})`);
  live.close();
}

// ── 6. sealing ────────────────────────────────────────────────────────────
console.log('\n=== 6. sealed at rest: no state or key material on disk ===');
{
  const env = fresh('seal');
  const st = open(env);
  const { alice } = sessionPair();
  st.put(B_ID, alice);
  for (let i = 0; i < 3; i++) st.send(B_ID, te(`s${i}`), deps());
  const state = st.get(B_ID);
  st.close();
  const needles = [state.rootKey, state.CKs, state.CKr, state.dhSelf.priv, state.dhRemote, Buffer.from(SEAL).toString('hex'), Buffer.from(MESH_SEED).toString('hex'), B_ID, A_ID]
    .filter(Boolean).flatMap((h) => [h, Buffer.from(h, 'hex').toString('base64'), Buffer.from(h, 'hex').toString('latin1')]);
  const names = ['rootKey', 'CKs', 'dhSelf', 'skipped', 'peerNodeId'];
  const leak = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
    .filter((f) => { const t = fs.readFileSync(f, 'latin1'); return needles.some((x) => t.includes(x)) || names.some((x) => t.includes(x)) || needles.some((x) => f.includes(x)); });
  const plantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-plant-'));
  fs.writeFileSync(path.join(plantDir, 'x.ratchet'), R.serializeState(state));
  assertAbsent({
    channel: 'state or key bytes (hex, base64, raw), field names or NodeIDs in the store directory, file names included',
    controlMessage: 'a planted plaintext state file is caught',
    control: () => leak(plantDir),
    absent: () => leak(env.dir).length === 0,
    message: `none in ${fs.readdirSync(env.dir).length} files`,
  });
  fs.rmSync(plantDir, { recursive: true });
  const file = fs.readFileSync(path.join(env.dir, S.ratchetFileName(SEAL, B_ID)));
  const anchor = JSON.parse(fs.readFileSync(env.anchorFile, 'utf8'));
  const gen = file.readBigUInt64BE(21);
  const aad = Buffer.concat([Buffer.from('gl-ratchet-state-v1'), Buffer.from(B_ID, 'hex'), Buffer.from(anchor.installId, 'hex'), file.subarray(21, 29)]);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(derivePurposeKey(MESH_SEED, Purpose.RATCHET_SEAL)), file.subarray(29, 41));
  d.setAAD(aad); d.setAuthTag(file.subarray(file.length - 16));
  let opened = null; try { opened = Buffer.concat([d.update(file.subarray(41, file.length - 16)), d.final()]).toString('utf8'); } catch { opened = null; }
  const rec = opened ? JSON.parse(opened) : null;               // R6: the plaintext is the contact record (format 0x02)
  ok(!!rec && R.serializeState(R.deserializeState(JSON.stringify(rec.sessions.find((x) => x.sending).state))) === R.serializeState(state) && Number(gen) === anchor.gens[B_ID] && file.subarray(0, 5).toString('latin1') === 'GLRS\x02' && file.subarray(5, 21).toString('hex') === anchor.installId,
    `an independent node:crypto AES-256-GCM open with #34 and AAD "gl-ratchet-state-v1"‖peerNodeId‖installId‖generation gives the state (generation ${gen})`);
  const aad2 = Buffer.from(aad); aad2[aad2.length - 1] ^= 1;
  const d2 = crypto.createDecipheriv('aes-256-gcm', Buffer.from(SEAL), file.subarray(29, 41)); d2.setAAD(aad2); d2.setAuthTag(file.subarray(file.length - 16));
  ok(caught(() => Buffer.concat([d2.update(file.subarray(41, file.length - 16)), d2.final()])) !== null, 'control: a different generation in the AAD does not open it');
  ok((fs.statSync(path.join(env.dir, S.ratchetFileName(SEAL, B_ID))).mode & 0o077) === 0, 'state files are owner-only (0600)');
}

// ── 7. undecryptable file ─────────────────────────────────────────────────
console.log('\n=== 7. a file that fails to open is refused, byte-identical, never overwritten ===');
{
  const env = fresh('unreadable');
  const st = open(env); const { alice } = sessionPair(); st.put(B_ID, alice); st.put(C_ID, sessionPair(C_ID).alice); st.close();
  const f = path.join(env.dir, S.ratchetFileName(SEAL, B_ID));
  const bytes = fs.readFileSync(f); bytes[60] ^= 1; fs.writeFileSync(f, bytes);
  const before = sha(fs.readFileSync(f));
  const events = [];
  const u = open(env, { on: { 'ratchet-unreadable': (i) => events.push(i) } });
  ok(JSON.stringify(u.startup.unreadable) === JSON.stringify([B_ID]) && !u.startup.rollback && u.has(C_ID) && events.length === 1,
    'a corrupted file: reported unreadable, NOT treated as rollback; the other contact still loads');
  const e1 = caught(() => u.put(B_ID, sessionPair().alice));
  const e2 = caught(() => u.send(B_ID, te('x'), deps()));
  ok(e1?.name === 'RatchetStateUnreadableError' && e2?.name === 'RatchetStateUnreadableError' && sha(fs.readFileSync(f)) === before,
    `put and send for it refuse (${e1?.name}); the file is byte-identical`);
  u.close();
  const wrongKey = S.openRatchetStore({ dir: env.dir, sealKey: S.ratchetSealKey(new Uint8Array(32).fill(7)), anchor: fileAnchor(env.anchorFile).provider });
  ok(wrongKey.startup.keyMismatch === true && !wrongKey.startup.rollback && wrongKey.startup.unreadable.length === 2 && sha(fs.readFileSync(f)) === before && files(env.dir).length === 2,
    'a wrong seal key: the store key check fails, NOT a rollback; both contacts unreadable, both files left in place');
  const eWrong = caught(() => wrongKey.put(C_ID, sessionPair(C_ID).alice));
  ok(eWrong?.name === 'RatchetStateUnreadableError' && files(env.dir).length === 2, `and nothing can be written under the wrong key (${eWrong?.name})`);
  wrongKey.close();
  const m = open(env);
  const aside = m.moveAsideUnreadable(B_ID);
  ok(!fs.existsSync(f) && sha(fs.readFileSync(aside)) === before && /\.unreadable-\d{8}T\d{6}Z$/.test(aside), `only the explicit step moves it aside, unchanged (${path.basename(aside)})`);
  m.put(B_ID, sessionPair().alice);
  ok(m.has(B_ID), 'control: after moving it aside, a new session for that contact can be stored');
  m.close();
}

// ── 8. factory ────────────────────────────────────────────────────────────
console.log('\n=== 8. factory: no store and no explicit memory-only mode → refuse ===');
{
  const seed = new Uint8Array(crypto.randomBytes(32));
  const base = { derivedSeed: seed, disableBootstrap: true, GMP_LAN_DISCOVERY: false };
  const env = fresh('factory');
  const bad = { 'ratchets: {}': {}, 'ratchets: null': null, 'dir without anchor': { dir: env.dir }, 'anchor without dir': { anchor: fileAnchor(env.anchorFile).provider }, 'memoryOnly without reason': { memoryOnly: '' }, 'a bare store object': { send() {} } };
  const refusals = Object.entries(bad).map(([k, v]) => [k, caught(() => createGMPNode({ ...base, dataDir: path.join(env.base, 'n-' + k.length), ratchets: v }))?.name]);
  ok(refusals.every(([, name]) => name === 'RatchetStoreRequiredError'), `refused with RatchetStoreRequiredError: ${refusals.map(([k, nm]) => `${k} → ${nm}`).join('; ')}`);
  const plain = createGMPNode({ ...base, dataDir: path.join(env.base, 'plain') });
  const ePlain = caught(() => plain.ratchets);
  ok(ePlain?.name === 'RatchetStoreRequiredError', `a node built without a ratchet spec refuses any ratchet use (${ePlain?.name})`);
  const mem = createGMPNode({ ...base, dataDir: path.join(env.base, 'mem'), ratchets: { memoryOnly: 'test: explicit' } });
  ok(mem.ratchets.open().startup.mode === 'memory-only', 'control: an explicit memory-only spec builds and opens');
  const sealed = createGMPNode({ ...base, dataDir: path.join(env.base, 'sealed'), ratchets: { dir: env.dir, anchor: fileAnchor(env.anchorFile).provider } });
  const early = caught(() => sealed.ratchets.open());
  sealed.loadIdentityFromDerivedSeed();
  const ss = sealed.ratchets.open();
  ss.put(B_ID, sessionPair().alice);
  const sealKeyUsed = Buffer.from(derivePurposeKey(sealed.identity.seed, Purpose.RATCHET_SEAL));
  const raw = fs.readFileSync(path.join(env.dir, S.ratchetFileName(sealKeyUsed, B_ID)));
  ok(early?.name === 'RatchetStoreRequiredError' && ss.startup.mode === 'sealed' && raw.length > 41,
    `control: a {dir, anchor} spec opens once the identity is loaded (before: ${early?.name}), sealed under derivePurposeKey(seed, RATCHET_SEAL)`);
  ss.close();
  const srcFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js)$/.test(e.name)) srcFiles.push(p); } };
  walk(path.join(pkg, 'src'));
  const re = /new RatchetStore\(|openRatchetStore\(|memoryOnlyRatchetStore\(/;
  const allowed = new Set(['ratchet/ratchet-store.ts', 'node-factory.ts']);
  assertAbsent({
    channel: 'a ratchet store built anywhere in src/ but the store module and the node factory',
    controlMessage: 'the matcher finds a planted openRatchetStore( call',
    control: () => re.test('const s = openRatchetStore({ dir });'),
    absent: () => srcFiles.filter((f) => !allowed.has(path.relative(path.join(pkg, 'src'), f)) && re.test(fs.readFileSync(f, 'utf8'))).length === 0,
    message: 'none: construction goes through createGMPNode only',
  });
}

fs.rmSync(root, { recursive: true, force: true });
done();
