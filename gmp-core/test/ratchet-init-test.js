/**
 * X3DH-lite session start, dedup, sentAt bound, glare and re-handshake
 * (identity-v2.md §4.2, §4.4, D1, D2, D8, Q2, Q3; task R6). Crypto + store
 * only; no transport (R7). Every negative has a positive control.
 *
 *  1. vectors: fixed RNG and clock; SK and the first kind 0x02 message pinned;
 *     SK rebuilt with node:crypto from the doc's IKM / salt / info.
 *  2. online and offline (late, reordered) starts reach the same session.
 *  3. forged initial (attacker has only public keys), wrong recipient, wrong
 *     static key for the NodeID: rejected, nothing stored.
 *  4. replay: dedup inside the window, sentAt after it; future sentAt.
 *  5. tampered header / sentAt / body: rejected, state byte-identical.
 *  6. glare: 100 seeded simultaneous starts converge on one session; every
 *     message decrypts exactly once.
 *  7. crash (SIGKILL) at every step of initiating and accepting.
 *  8. reset → re-handshake: the old session is replaced only by a valid
 *     initial; the unacknowledged list is exact.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { x25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { absenceAsserter } from './helpers/assert-absent.mjs';
import { fileAnchor, readLines } from './helpers/ratchet-store-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(here, 'vectors', 'ratchet-init-v1.json');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

let X = null, S = null;
try { X = await import('../dist/ratchet/x3dh.js'); S = await import('../dist/ratchet/ratchet-store.js'); } catch (e) { console.log(`  (import failed: ${e.code || e.message})`); }
console.log('\n=== the module exists ===');
ok(!!X && typeof X.x3dhInitiate === 'function' && typeof X.x3dhRespond === 'function' && !!S && typeof S.RatchetStore.prototype.initiate === 'function',
  'dist/ratchet/x3dh.js exports x3dhInitiate / x3dhRespond, and the store has initiate()');
if (!X || !S?.RatchetStore.prototype.initiate) done();
const R = await import('../dist/ratchet/ratchet.js');

// ── helpers ───────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-init-'));
let nDir = 0;
const fresh = (label) => { const d = path.join(root, `${String(++nDir).padStart(3, '0')}-${label}`); fs.mkdirSync(d); return { dir: path.join(d, 'ratchets'), anchorFile: path.join(d, 'keyring', 'anchor.json'), base: d }; };
const SEAL = S.ratchetSealKey(new Uint8Array(crypto.createHash('sha256').update('r6 mesh seed').digest()));
const hex = (b) => Buffer.from(b).toString('hex');
const te = (s) => new TextEncoder().encode(s);
const td = (b) => new TextDecoder().decode(b);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
function ident(label) {
  const priv = new Uint8Array(crypto.createHash('sha256').update(`r6 identity ${label}`).digest());
  const pub = x25519.getPublicKey(priv);
  return { staticPrivKey: priv, staticPubKey: pub, nodeIdHex: hex(sha512(pub)), label };
}
function seededRng(seed) {
  let ctr = 0;
  return (k) => { const o = Buffer.alloc(k); for (let i = 0; i < k; i += 32) crypto.createHmac('sha256', seed).update(String(ctr++)).digest().copy(o, i, 0, Math.min(32, k - i)); return new Uint8Array(o); };
}
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clockAt = (t) => { const c = { t }; return c; };
const depsOf = (seed, clock) => ({ rng: seed ? seededRng(seed) : (k) => new Uint8Array(crypto.randomBytes(k)), now: () => clock.t });
const mem = (id, on) => S.memoryOnlyRatchetStore(`test ${id.label}`, { identity: id, on });
const sealed = (env, id, extra = {}) => S.openRatchetStore({ dir: env.dir, sealKey: SEAL, anchor: (extra.anchor || fileAnchor(env.anchorFile)).provider, identity: id, ...extra, anchor: (extra.anchor || fileAnchor(env.anchorFile)).provider });
const idOf = (msg) => hex(msg.subarray(2, 18));
const kindOf = (msg) => msg[1];
const caught = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const ALICE = ident('alice'), BOB = ident('bob'), CAROL = ident('carol'), MALLORY = ident('mallory');
const [LOW, HIGH] = [ALICE, BOB].sort((a, b) => (a.nodeIdHex < b.nodeIdHex ? -1 : 1));
const toB = { peerStaticPub: ALICE.staticPubKey }, toA = { peerStaticPub: BOB.staticPubKey };
function captureLogs(fn) {
  const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { const s = a.join(' '); if (s.startsWith('{"ts"')) lines.push(JSON.parse(s)); else orig[k](...a); };
  try { return { value: fn(), lines }; } finally { Object.assign(console, orig); }
}

// ── 1. vectors ────────────────────────────────────────────────────────────
console.log('\n=== 1. pinned vectors (fixed RNG and clock); SK rebuilt independently ===');
{
  const clock = clockAt(T0);
  const roots = [];
  const a = mem(ALICE), b = mem(BOB);
  a.initiate(BOB.nodeIdHex, toA, depsOf('r6-vectors/A', clock), { observe: { onRootKey: (role, k) => roots.push([role, k]) } });
  const m1 = a.send(BOB.nodeIdHex, te('first contact'), depsOf('r6-vectors/A2', clock));
  const r1 = b.receive(ALICE.nodeIdHex, m1, depsOf('r6-vectors/B', clock), { ...toB, observe: { onRootKey: (role, k) => roots.push([role, k]) } });
  const got = { sk: sha(Buffer.from(roots[0][1], 'hex')).slice(0, 16), initial: sha(m1).slice(0, 16) };
  if (process.argv.includes('--write-vectors')) {
    fs.writeFileSync(VECTORS, JSON.stringify({ format: 'gl X3DH-lite v1 (identity-v2.md §4.2)', identities: 'sha256("r6 identity alice"/"bob")', rng: 'r6-vectors/A', clock: T0, skSha256Prefix: got.sk, initialMessageSha256Prefix: got.initial }, null, 2) + '\n');
    console.log(`  wrote ${path.relative(path.join(here, '..'), VECTORS)}`);
  }
  const vec = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, 'utf8')) : {};
  ok(got.sk === vec.skSha256Prefix && got.initial === vec.initialMessageSha256Prefix, `SK ${got.sk} and the first initial message ${got.initial} match the committed vectors`);
  ok(roots.length === 2 && roots[0][1] === roots[1][1] && roots[0][0] === 'initiator' && roots[1][0] === 'responder', 'both sides derive the same SK');
  const ekPub = m1.subarray(18, 50);
  const ekPriv = depsOf('r6-vectors/A', clock).rng(32);
  const dh1 = x25519.getSharedSecret(ALICE.staticPrivKey, BOB.staticPubKey);
  const dh2 = x25519.getSharedSecret(ekPriv, BOB.staticPubKey);
  const ikm = Buffer.concat([Buffer.alloc(32, 0xff), dh1, dh2]);
  const info = Buffer.concat([Buffer.from('gl-x3dh-v1'), Buffer.from(ALICE.nodeIdHex, 'hex'), Buffer.from(BOB.nodeIdHex, 'hex'), ekPub]);
  const sk = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(32), info, 32));
  ok(hex(sk) === roots[0][1] && hex(x25519.getPublicKey(ekPriv)) === hex(ekPub), 'SK = HKDF-SHA256(0xFF×32 ‖ DH(S_a,S_b) ‖ DH(EK_a,S_b), salt 0×32, "gl-x3dh-v1" ‖ NodeID_a ‖ NodeID_b ‖ EK_a) by node:crypto');
  const swapped = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([Buffer.alloc(32, 0xff), dh2, dh1]), Buffer.alloc(32), info, 32));
  ok(hex(swapped) !== roots[0][1], 'control: the other IKM order (ephemeral term first) gives a different SK');
  const dv = new DataView(m1.buffer, m1.byteOffset);
  ok(kindOf(m1) === 0x02 && Number(dv.getBigUint64(50)) === T0 && m1.length === 114 + te('first contact').length && r1.ok && td(r1.plaintext) === 'first contact',
    'kind 0x02, EK_s at 18, sentAt at 50 = the clock, 114 bytes of overhead; it decrypts');
}

// ── 2. online and offline ─────────────────────────────────────────────────
console.log('\n=== 2. online and offline starts reach the same working session ===');
for (const mode of ['online', 'offline']) {
  const clock = clockAt(T0);
  const a = mem(ALICE), b = mem(BOB);
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const sent = [0, 1, 2].map((i) => a.send(BOB.nodeIdHex, te(`a${i}`), depsOf(null, clock)));
  const order = mode === 'online' ? [0, 1, 2] : [2, 0, 1];
  if (mode === 'offline') clock.t += 3 * DAY;                     // a mailbox delivers days later, out of order
  const got = order.map((i) => b.receive(ALICE.nodeIdHex, sent[i], depsOf(null, clock), toB));
  const reply = b.send(ALICE.nodeIdHex, te('b0'), depsOf(null, clock));
  const back = a.receive(BOB.nodeIdHex, reply, depsOf(null, clock), toA);
  const next = a.send(BOB.nodeIdHex, te('a3'), depsOf(null, clock));
  const last = b.receive(ALICE.nodeIdHex, next, depsOf(null, clock), toB);
  ok(got.every((g) => g.ok) && sent.every((m) => kindOf(m) === 2) && back.ok && kindOf(next) === 1 && last.ok &&
    a.sessionInfo(BOB.nodeIdHex).sending === b.sessionInfo(ALICE.nodeIdHex).sending && a.sessionInfo(BOB.nodeIdHex).sending === hex(sent[0].subarray(18, 50)),
    `${mode}: initial messages are kind 0x02 until the reply, then 0x01; both sides send on the session named by EK_a`);
}

// ── 3. forged, wrong recipient, wrong key ─────────────────────────────────
console.log('\n=== 3. forged initial, wrong recipient, wrong static key: rejected, nothing stored ===');
{
  const clock = clockAt(T0);
  const env = fresh('forged');
  const b = sealed(env, BOB);
  const fileState = () => fs.readdirSync(env.dir).sort().map((f) => `${f}:${sha(fs.readFileSync(path.join(env.dir, f)))}`).join('|');
  const before = fileState();
  // Mallory knows S_a and S_b public keys only; she runs the initiator with her own static key and claims to be Alice.
  const m = mem(MALLORY);
  m.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const forged = m.send(BOB.nodeIdHex, te('trust me, I am alice'), depsOf(null, clock));
  const r = b.receive(ALICE.nodeIdHex, forged, depsOf(null, clock), toB);
  ok(!r.ok && r.reason === 'auth-failed' && !b.sessionInfo(ALICE.nodeIdHex).sending && fileState() === before,
    `forged (no S_a): rejected (${r.reason}); no session, no file changed`);
  const c = mem(ALICE);
  c.initiate(CAROL.nodeIdHex, { peerStaticPub: CAROL.staticPubKey }, depsOf(null, clock));
  const forCarol = c.send(CAROL.nodeIdHex, te('for carol'), depsOf(null, clock));
  const r2 = b.receive(ALICE.nodeIdHex, forCarol, depsOf(null, clock), toB);
  ok(!r2.ok && r2.reason === 'auth-failed' && fileState() === before, `Alice's initial for Carol, delivered to Bob: rejected (${r2.reason})`);
  const r3 = b.receive(ALICE.nodeIdHex, forged, depsOf(null, clock), { peerStaticPub: MALLORY.staticPubKey });
  ok(!r3.ok && r3.reason === 'peer-key-mismatch' && fileState() === before, `a static key whose SHA-512 is not the claimed NodeID: rejected before any DH (${r3.reason})`);
  const a = mem(ALICE);
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const genuine = a.send(BOB.nodeIdHex, te('really alice'), depsOf(null, clock));
  const g = b.receive(ALICE.nodeIdHex, genuine, depsOf(null, clock), toB);
  ok(g.ok && td(g.plaintext) === 'really alice' && fileState() !== before, 'control: the genuine initial is accepted and stored');
  b.close();
}

// ── 4. replay ─────────────────────────────────────────────────────────────
console.log('\n=== 4. replay: dedup in the window, sentAt after it; sentAt from the future ===');
{
  const clock = clockAt(T0);
  const a = mem(ALICE), b = mem(BOB);
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const m1 = a.send(BOB.nodeIdHex, te('once'), depsOf(null, clock));
  const first = b.receive(ALICE.nodeIdHex, m1, depsOf(null, clock), toB);
  clock.t += 1 * DAY;
  const again = b.receive(ALICE.nodeIdHex, m1, depsOf(null, clock), toB);
  ok(first.ok && !again.ok && again.reason === 'duplicate', `replay one day later: rejected by dedup (${again.reason})`);
  const idM1 = idOf(m1);
  const dedupHad = b.dedupIds(ALICE.nodeIdHex).includes(idM1);
  clock.t = T0 + 8 * DAY + 60_000;
  const late = b.receive(ALICE.nodeIdHex, m1, depsOf(null, clock), toB);
  ok(!late.ok && late.reason === 'initial-too-old' && dedupHad, `replay after the dedup entry expired (8 days + 1 min): rejected by the sentAt bound (${late.reason})`);
  const m2 = a.send(BOB.nodeIdHex, te('fresh'), depsOf(null, clock));
  const fresh2 = b.receive(ALICE.nodeIdHex, m2, depsOf(null, clock), toB);
  ok(kindOf(m2) === 2 && fresh2.ok && td(fresh2.plaintext) === 'fresh', 'control: a fresh initial (same session, current sentAt) is accepted');
  // A brand-new session replayed: dedup off (new store), sentAt still bounds it.
  const b2 = mem(BOB);
  const old = b2.receive(ALICE.nodeIdHex, m1, depsOf(null, clock), toB);
  ok(!old.ok && old.reason === 'initial-too-old', `an initial older than 8 days on a store that never saw it: rejected before any DH (${old.reason})`);
  const fut = mem(ALICE), skewed = clockAt(T0 + 6 * 60_000);
  fut.initiate(BOB.nodeIdHex, toA, depsOf(null, skewed));
  const ahead = fut.send(BOB.nodeIdHex, te('from the future'), depsOf(null, skewed));
  const rFut = mem(BOB).receive(ALICE.nodeIdHex, ahead, depsOf(null, clockAt(T0)), toB);
  const near = mem(ALICE), nearClock = clockAt(T0 + 4 * 60_000);
  near.initiate(BOB.nodeIdHex, toA, depsOf(null, nearClock));
  const rNear = mem(BOB).receive(ALICE.nodeIdHex, near.send(BOB.nodeIdHex, te('4 min ahead'), depsOf(null, nearClock)), depsOf(null, clockAt(T0)), toB);
  ok(!rFut.ok && rFut.reason === 'initial-from-future' && rNear.ok, `sentAt 6 min ahead: rejected (${rFut.reason}); control: 4 min ahead is accepted`);
  const dedupNow = b.dedupIds(ALICE.nodeIdHex);
  ok(dedupHad && !dedupNow.includes(idM1) && dedupNow.includes(idOf(m2)), `dedup entries expire after TTL + 1 day (m1 listed at day 1, gone at day 8; ${dedupNow.length} entry now)`);
}

// ── 5. tamper ─────────────────────────────────────────────────────────────
console.log('\n=== 5. tampered initial: rejected, state byte-identical ===');
{
  const clock = clockAt(T0);
  const env = fresh('tamper');
  const a = mem(ALICE);
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const m = a.send(BOB.nodeIdHex, te('tamper me'), depsOf(null, clock));
  const b = sealed(env, BOB);
  const snap = () => `${JSON.stringify(b.sessionInfo(ALICE.nodeIdHex))}|${fs.readdirSync(env.dir).sort().map((f) => sha(fs.readFileSync(path.join(env.dir, f)))).join(',')}`;
  const before = snap();
  const flip = (i) => { const c = new Uint8Array(m); c[i] ^= 1; return c; };
  const cases = [['messageId', 5], ['EK_s', 20], ['sentAt (low byte)', 57], ['DHr', 60], ['N', 97], ['body', 100], ['tag', m.length - 1]];
  for (const [name, i] of cases) {
    const r = b.receive(ALICE.nodeIdHex, flip(i), depsOf(null, clock), toB);
    ok(!r.ok && snap() === before, `tampered ${name}: rejected (${r.reason}), state and files byte-identical`);
  }
  const g = b.receive(ALICE.nodeIdHex, m, depsOf(null, clock), toB);
  ok(g.ok && snap() !== before, 'control: the untouched message is accepted');
  b.close();
}

// ── 6. glare ──────────────────────────────────────────────────────────────
console.log(`\n=== 6. glare: 100 seeded simultaneous starts (tie-break: the session initiated by the lower NodeID, ${LOW.label}) ===`);
{
  let converged = 0, onLow = 0, lateGlare = 0, total = 0, problems = [];
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = prng(seed);
    const clock = clockAt(T0);
    const st = { [ALICE.nodeIdHex]: mem(ALICE), [BOB.nodeIdHex]: mem(BOB) };
    const who = { [ALICE.nodeIdHex]: ALICE, [BOB.nodeIdHex]: BOB };
    const other = (id) => (id === ALICE.nodeIdHex ? BOB : ALICE);
    const inflight = [], delivered = new Map();
    const send = (from, text) => { const to = other(from); const m = st[from].send(to.nodeIdHex, te(text), depsOf(null, clock)); inflight.push({ from, to: to.nodeIdHex, m, text }); total++; };
    for (const id of [ALICE.nodeIdHex, BOB.nodeIdHex]) st[id].initiate(other(id).nodeIdHex, { peerStaticPub: other(id).staticPubKey }, depsOf(null, clock));
    for (const id of [ALICE.nodeIdHex, BOB.nodeIdHex]) for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) send(id, `${who[id].label}-init-${k}`);
    for (let step = 0; step < 40; step++) {
      clock.t += Math.floor(rnd() * 600_000);
      if (inflight.length && rnd() < 0.6) {
        const i = Math.floor(rnd() * inflight.length);
        const x = inflight.splice(i, 1)[0];
        const r = st[x.to].receive(x.from, x.m, depsOf(null, clock), { peerStaticPub: who[x.from].staticPubKey });
        if (!r.ok || td(r.plaintext) !== x.text) problems.push(`seed ${seed}: ${x.text} → ${r.ok ? 'wrong text' : r.reason}`);
        else delivered.set(idOf(x.m), x);
        if (rnd() < 0.15) { const again = st[x.to].receive(x.from, x.m, depsOf(null, clock), { peerStaticPub: who[x.from].staticPubKey }); if (again.ok) problems.push(`seed ${seed}: ${x.text} decrypted twice`); }
      } else {
        const from = rnd() < 0.5 ? ALICE.nodeIdHex : BOB.nodeIdHex;
        send(from, `${who[from].label}-${step}`);
      }
    }
    while (inflight.length) {                                    // drain, then one exchange each way
      const x = inflight.shift();
      const r = st[x.to].receive(x.from, x.m, depsOf(null, clock), { peerStaticPub: who[x.from].staticPubKey });
      if (!r.ok || td(r.plaintext) !== x.text) problems.push(`seed ${seed} drain: ${x.text} → ${r.ok ? 'wrong text' : r.reason}`); else delivered.set(idOf(x.m), x);
    }
    for (const from of [ALICE.nodeIdHex, BOB.nodeIdHex, ALICE.nodeIdHex]) {
      send(from, `${who[from].label}-final`);
      const x = inflight.pop();
      const r = st[x.to].receive(x.from, x.m, depsOf(null, clock), { peerStaticPub: who[x.from].staticPubKey });
      if (!r.ok) problems.push(`seed ${seed} final: ${r.reason}`); else delivered.set(idOf(x.m), x);
    }
    const sa = st[ALICE.nodeIdHex].sessionInfo(BOB.nodeIdHex), sb = st[BOB.nodeIdHex].sessionInfo(ALICE.nodeIdHex);
    if (sa.sending && sa.sending === sb.sending) converged++;
    const lowSession = st[LOW.nodeIdHex].sessionInfo(HIGH.nodeIdHex).sessions.find((s) => s.initiator === LOW.nodeIdHex);
    if (lowSession && sa.sending === lowSession.id) onLow++; else lateGlare++;
  }
  ok(problems.length === 0, `100 runs, ${total} messages: every one decrypted exactly once (problems: ${problems.slice(0, 3).join('; ') || 'none'})`);
  ok(converged === 100, `both sides send on ONE session at the end of every run (${converged}/100): ${onLow} on ${LOW.label}'s (the tie-break), ${lateGlare} on ${HIGH.label}'s after a late initial`);
}

// ── 7. crash during initiate / accept ─────────────────────────────────────
console.log('\n=== 7. crash (SIGKILL) at every step of initiating and accepting ===');
{
  const childRun = (job) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, 'helpers', 'ratchet-init-child.mjs'), JSON.stringify({ sealKey: hex(SEAL), ...job })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
    p.on('exit', (code, signal) => resolve({ code, signal, lines: o.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }), stderr: e }));
  });
  const self = (id) => ({ priv: hex(id.staticPrivKey), pub: hex(id.staticPubKey), nodeId: id.nodeIdHex });
  const allSendKeys = [], allRoots = [];
  for (const point of ['initiate:anchored', 'initiate:computed', 'initiate:persisted', 'send:anchored', 'send:computed', 'send:persisted']) {
    const env = fresh(point.replace(':', '-'));
    const keys = path.join(env.base, 'keys'), released = path.join(env.base, 'released');
    const index = point.startsWith('initiate') ? 0 : 2;
    const job = { action: 'initiate-send', dir: env.dir, anchorFile: env.anchorFile, self: self(ALICE), peer: BOB.nodeIdHex, peerStaticPub: hex(BOB.staticPubKey), count: 3, keysOut: keys, releasedOut: released };
    const c1 = await childRun({ ...job, tag: 'pre', crashAt: { point, index } });
    const c2 = await childRun({ ...job, tag: 'post' });
    const lines = readLines(keys);
    const sendKeys = lines.filter((l) => l.startsWith('encrypt ')).map((l) => l.slice(8));
    const roots = lines.filter((l) => l.startsWith('root-initiator ')).map((l) => l.slice(15));
    allSendKeys.push(...sendKeys); allRoots.push(...roots);
    const b = mem(BOB);
    const results = readLines(released).map((h) => b.receive(ALICE.nodeIdHex, Buffer.from(h, 'hex'), depsOf(null, clockAt(Date.now())), toB));
    ok(c1.signal === 'SIGKILL' && new Set(sendKeys).size === sendKeys.length && new Set(roots).size === roots.length && results.every((r) => r.ok) && results.length >= 3,
      `${point}: killed; ${roots.length} SK / ${sendKeys.length} message keys derived, none twice; all ${results.length} released messages decrypt at Bob`);
  }
  ok(new Set(allSendKeys).size === allSendKeys.length && new Set(allRoots).size === allRoots.length, `initiator side overall: ${allRoots.length} SK, ${allSendKeys.length} message keys, 0 repeated`);
  for (const point of ['receive:computed', 'receive:anchored', 'receive:persisted']) {
    const env = fresh(point.replace(':', '-'));
    const a = mem(ALICE);
    const clock = clockAt(Date.now());
    a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
    const msgsIn = path.join(env.base, 'msgs');
    fs.writeFileSync(msgsIn, ['i-0', 'i-1', 'i-2'].map((t) => hex(a.send(BOB.nodeIdHex, te(t), depsOf(null, clock)))).join('\n') + '\n');
    const keys = path.join(env.base, 'keys'), released = path.join(env.base, 'released');
    const job = { action: 'accept', dir: env.dir, anchorFile: env.anchorFile, self: self(BOB), peer: ALICE.nodeIdHex, peerStaticPub: hex(ALICE.staticPubKey), messagesIn: msgsIn, keysOut: keys, releasedOut: released };
    const c1 = await childRun({ ...job, crashAt: { point, index: 0 } });
    const c2 = await childRun(job);
    const c3 = await childRun(job);                              // and once more: everything is a replay now
    const rel = readLines(released);
    const twice = rel.filter((t, i) => rel.indexOf(t) !== i);
    const lastResults = c3.lines.find((l) => l.results)?.results || [];
    const restart = c2.lines.find((l) => l.opened)?.startup || {};
    ok(c1.signal === 'SIGKILL' && twice.length === 0 && lastResults.every((r) => r === 'duplicate' || r === 'initial-too-old' || r === 'no-key' || r === 'auth-failed'),
      `${point}: killed on the first initial; restart ${restart.rollback ? `discards (${restart.rollback.reason})` : 'resumes'}; released ${JSON.stringify(rel)}, none twice; a third run rejects all (${[...new Set(lastResults)].join(', ')})`);
  }
  {
    const env = fresh('dedup-survives');
    const a = mem(ALICE), clock = clockAt(Date.now());
    a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
    const m = a.send(BOB.nodeIdHex, te('once only'), depsOf(null, clock));
    const b1 = sealed(env, BOB); const r1 = b1.receive(ALICE.nodeIdHex, m, depsOf(null, clock), toB); b1.close();
    const b2 = sealed(env, BOB); const r2 = b2.receive(ALICE.nodeIdHex, m, depsOf(null, clock), toB); b2.close();
    ok(r1.ok && !r2.ok && r2.reason === 'duplicate', `dedup survives a restart: the same initial after reopening is rejected (${r2.reason})`);
  }
}

// ── 8. reset → re-handshake ───────────────────────────────────────────────
console.log('\n=== 8. reset on one side → re-handshake; unacknowledged messages are reported exactly ===');
{
  const clock = clockAt(T0);
  const envB = fresh('rehandshake-bob');
  const events = [];
  let a = mem(ALICE);
  const b = sealed(envB, BOB, { on: { 'ratchet-session-replaced': (i) => events.push(i) } });
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  b.receive(ALICE.nodeIdHex, a.send(BOB.nodeIdHex, te('hello'), depsOf(null, clock)), depsOf(null, clock), toB);
  const hi = b.send(ALICE.nodeIdHex, te('hi'), depsOf(null, clock));
  a.receive(BOB.nodeIdHex, hi, depsOf(null, clock), toA);
  const ids = [];
  for (const t of ['b1', 'b2', 'b3', 'b4']) { const m = b.send(ALICE.nodeIdHex, te(t), depsOf(null, clock)); ids.push(idOf(m)); if (t !== 'b4') a.receive(BOB.nodeIdHex, m, depsOf(null, clock), toA); }
  b.acknowledge(ALICE.nodeIdHex, [idOf(hi), ids[0]]);          // receipts for hi and b1 arrived; b2, b3 delivered but not receipted; b4 lost
  const oldSession = b.sessionInfo(ALICE.nodeIdHex).sending;
  const before = JSON.stringify(b.sessionInfo(ALICE.nodeIdHex));
  // A forged initial while the session is established: no replacement.
  const mal = mem(MALLORY); mal.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const forged = b.receive(ALICE.nodeIdHex, mal.send(BOB.nodeIdHex, te('reset!'), depsOf(null, clock)), depsOf(null, clock), toB);
  ok(!forged.ok && JSON.stringify(b.sessionInfo(ALICE.nodeIdHex)) === before && events.length === 0, `a forged initial on an established session: rejected (${forged.reason}), session not replaced, no event`);
  // Alice loses her state (R5 rollback / crash reset) and starts over.
  a = mem(ALICE);
  a.initiate(BOB.nodeIdHex, toA, depsOf(null, clock));
  const restart = a.send(BOB.nodeIdHex, te('it is me again'), depsOf(null, clock));
  const cap = captureLogs(() => b.receive(ALICE.nodeIdHex, restart, depsOf(null, clock), toB));
  const info = b.sessionInfo(ALICE.nodeIdHex);
  ok(cap.value.ok && info.sending !== oldSession && info.sending === hex(restart.subarray(18, 50)) && events.length === 1 && events[0].reason === 'peer-reset' && cap.lines.some((l) => l.event === 'ratchet-session-replaced'),
    `a valid initial on an established session replaces it (${events[0]?.reason}); one event, one log line`);
  ok(JSON.stringify([...events[0].unacknowledged].sort()) === JSON.stringify([ids[1], ids[2], ids[3]].sort()),
    `the event lists exactly the 3 unacknowledged messages (b2, b3, b4) by messageId`);
  assertAbsent({
    channel: 'an acknowledged message in the unacknowledged list',
    controlMessage: 'the list does report messages (b2, b3, b4)',
    control: () => events[0].unacknowledged,
    absent: () => !events[0].unacknowledged.includes(ids[0]) && !events[0].unacknowledged.includes(idOf(hi)) && !events[0].unacknowledged.includes(idOf(restart)),
    message: 'hi and b1 (acknowledged) are not listed',
  });
  ok(JSON.stringify(b.unacknowledged(ALICE.nodeIdHex).sort()) === JSON.stringify([ids[1], ids[2], ids[3]].sort()), 'the store still reports them on request until the app acknowledges or resends');
  const replay = b.receive(ALICE.nodeIdHex, restart, depsOf(null, clock), toB);
  ok(!replay.ok && replay.reason === 'duplicate' && events.length === 1, `replaying the re-handshake initial: rejected (${replay.reason}), no second replacement`);
  const reply = b.send(ALICE.nodeIdHex, te('welcome back'), depsOf(null, clock));
  const got = a.receive(BOB.nodeIdHex, reply, depsOf(null, clock), toA);
  ok(got.ok && td(got.plaintext) === 'welcome back', 'control: the new session works both ways');
  b.close();
  const b2 = sealed(envB, BOB);
  ok(b2.sessionInfo(ALICE.nodeIdHex).sending === info.sending && JSON.stringify(b2.unacknowledged(ALICE.nodeIdHex).sort()) === JSON.stringify([ids[1], ids[2], ids[3], idOf(reply)].sort()),
    'the replacement and the unacknowledged list survive a restart (sealed store)');
  b2.close();
}

console.log('\n=== x3dh.ts is reached only through the store ===');
{
  const src = path.join(here, '..', 'src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js)$/.test(e.name)) files.push(p); } };
  walk(src);
  const re = /['"]\.\/x3dh(\.js)?['"]|ratchet\/x3dh(\.js)?['"]/;
  const users = () => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(src, f));
  assertAbsent({
    channel: 'an importer of x3dh.ts other than the ratchet store',
    controlMessage: 'the matcher finds a planted import',
    control: () => re.test("import { x3dhInitiate } from './x3dh.js';"),
    absent: () => JSON.stringify(users()) === JSON.stringify(['ratchet/ratchet-store.ts']),
    message: `only ratchet/ratchet-store.ts (got ${JSON.stringify(users())})`,
  });
}

fs.rmSync(root, { recursive: true, force: true });
done();
