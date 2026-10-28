/**
 * src/ratchet/ratchet.ts — Double Ratchet core (identity-v2.md §3.1, §4.3,
 * §4.4, §5, §7 tests 1, 2, 5; task R4). Every negative has a positive control.
 *
 *  1. vectors: a scripted A<->B conversation (five DH turns) with a fixed RNG;
 *     digests in the committed test/vectors/ratchet-v1.json; message 1 rebuilt
 *     byte-for-byte with node:crypto; the same JSON re-checked in Electron main
 *     (ELECTRON_RUN_AS_NODE=1).
 *  2. seeded random schedules: in-order, reordered, delayed, lost, crossing
 *     sends; every delivered message decrypts exactly once.
 *  3. every failure path leaves the state byte-identical (the input is also
 *     deep-frozen, so a write to it would throw).
 *  4. serialise -> deserialise mid-conversation.
 *  5. behavioural differential against @signalapp/libsignal-client
 *     (gmp-core devDependency only): same schedule, same accept/reject
 *     outcomes. Prints SKIP with the reason if it cannot load.
 *  6. AGPL boundary: libsignal in no runtime dependency, not in gmp-core/dist,
 *     app.bundle.js, the RN bundle or the packaged Electron app.
 *  + §7 test 5 (nonce-reuse witness), sizes (§3.1), purity, no importers.
 *
 * Regenerate vectors (only when the format deliberately changes):
 *   node test/ratchet-test.js --write-vectors
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { absenceAsserter } from './helpers/assert-absent.mjs';
import { x25519 } from '@noble/curves/ed25519';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const repo = path.join(pkg, '..');
const VECTORS = path.join(here, 'vectors', 'ratchet-v1.json');
const vectorsOnly = process.argv.includes('--vectors-only');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; if (!vectorsOnly) console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

let R = null;
try { R = await import('../dist/ratchet/ratchet.js'); } catch (e) { console.log(`  (import failed: ${e.code || e.message})`); }
if (!vectorsOnly) console.log('\n=== the module exists ===');
ok(!!R && typeof R.encrypt === 'function' && typeof R.decrypt === 'function' && typeof R.initSender === 'function' && typeof R.initReceiver === 'function',
  'dist/ratchet/ratchet.js exports initSender / initReceiver / encrypt / decrypt');
if (!R) done();

// ── deterministic helpers ─────────────────────────────────────────────────
/** A seeded byte stream: HMAC-SHA256(seed, counter). */
function seededRng(seed) {
  let ctr = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let o = 0; o < n; o += 32) crypto.createHmac('sha256', seed).update(String(ctr++)).digest().copy(out, o, 0, Math.min(32, n - o));
    return new Uint8Array(out);
  };
}
/** A seeded float PRNG for schedules (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const T0 = 1_800_000_000_000;
const deps = (seed, clock = { t: T0 }) => ({ rng: seededRng(seed), now: () => clock.t });
const A_ID = 'a1'.repeat(64), B_ID = 'b2'.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const te = (s) => new TextEncoder().encode(s);
const td = (b) => new TextDecoder().decode(b);
function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
const flip = (m, i) => { const c = new Uint8Array(m); c[i] ^= 0x01; return c; };

/** A fresh pair of sessions over the same root secret (X3DH-lite is R6). */
function pair(seed, clock) {
  const dA = deps(seed + '/A', clock), dB = deps(seed + '/B', clock);
  const setup = seededRng(seed + '/setup');
  const rootKey = setup(32);
  const bPriv = setup(32);
  const bPub = x25519.getPublicKey(bPriv);
  const alice = R.initSender({ rootKey, remoteDhPub: bPub, selfNodeId: A_ID, peerNodeId: B_ID }, dA);
  const bob = R.initReceiver({ rootKey, selfDh: { priv: bPriv, pub: bPub }, selfNodeId: B_ID, peerNodeId: A_ID }, dB);
  return { alice, bob, dA, dB, rootKey };
}

// ── 1. vectors ────────────────────────────────────────────────────────────
if (!vectorsOnly) console.log('\n=== 1. pinned vectors: a scripted conversation with a fixed RNG ===');
const SCRIPT = ['A', 'A', 'A', 'B', 'B', 'A', 'B', 'A', 'A', 'B'];   // five DH turns
function runScript() {
  const p = pair('ratchet-v1-vectors');
  const st = { A: p.alice, B: p.bob }, dep = { A: p.dA, B: p.dB };
  const digests = [], dhKeys = new Set();
  SCRIPT.forEach((who, i) => {
    const to = who === 'A' ? 'B' : 'A';
    const e = R.encrypt(st[who], te(`${who} says ${i}`), dep[who]); st[who] = e.state;
    const d = R.decrypt(st[to], e.message, dep[to]); if (!d.ok) throw new Error(`step ${i}: ${d.reason}`); st[to] = d.state;
    digests.push(sha(e.message));
    dhKeys.add(Buffer.from(e.message.subarray(18, 50)).toString('hex'));
  });
  return { digests, alice: sha(R.serializeState(st.A)), bob: sha(R.serializeState(st.B)), dhKeys: dhKeys.size };
}
const got = runScript();
if (vectorsOnly) { console.log(`VECTORS ${JSON.stringify(got)}`); process.exit(0); }
if (process.argv.includes('--write-vectors')) {
  fs.mkdirSync(path.dirname(VECTORS), { recursive: true });
  fs.writeFileSync(VECTORS, JSON.stringify({ format: 'gl-ratchet v1 (identity-v2.md §3.1/§4.3)', seed: 'ratchet-v1-vectors', script: SCRIPT,
    plaintexts: '`${who} says ${i}`', messageSha256Prefix: got.digests, finalStateSha256Prefix: { alice: got.alice, bob: got.bob } }, null, 2) + '\n');
  console.log(`  wrote ${path.relative(pkg, VECTORS)}`);
}
const vec = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, 'utf8')) : null;
ok(!!vec, 'test/vectors/ratchet-v1.json is committed');
ok(got.dhKeys === 6, `the script uses ${got.dhKeys} sending ratchet keys (Alice's first + five DH turns)`);
if (vec) {
  ok(JSON.stringify(got.digests) === JSON.stringify(vec.messageSha256Prefix), `all ${SCRIPT.length} message digests match the vectors (${got.digests.slice(0, 3).join(', ')}, …)`);
  ok(got.alice === vec.finalStateSha256Prefix.alice && got.bob === vec.finalStateSha256Prefix.bob, `both final states match the vectors (${got.alice} / ${got.bob})`);
  const other = JSON.parse(JSON.stringify(vec)); other.messageSha256Prefix[0] = '0000000000000000';
  ok(JSON.stringify(got.digests) !== JSON.stringify(other.messageSha256Prefix), 'control: one changed digest is noticed');
}
{
  // Independent rebuild of the first message with node:crypto (HKDF, HMAC, AES-GCM, AD).
  const p = pair('independent-check');
  const e = R.encrypt(p.alice, te('hello'), p.dA);
  const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
  const aPriv = Buffer.from(p.alice.dhSelf.priv, 'hex');
  const bPub = Buffer.from(p.bob.dhSelf.pub, 'hex');
  const rk = hkdf(Buffer.from(x25519.getSharedSecret(aPriv, bPub)), Buffer.from(p.rootKey), 'gl-ratchet-rk-v1', 64);
  const mk = crypto.createHmac('sha256', rk.subarray(32)).update(Buffer.from([1])).digest();
  const kn = hkdf(mk, Buffer.alloc(32), 'gl-ratchet-mk-v1', 44);
  const header = Buffer.from(e.message.subarray(0, 58));
  const ad = Buffer.concat([Buffer.from('gl-ratchet-ad-v1'), header, Buffer.from(A_ID, 'hex'), Buffer.from(B_ID, 'hex')]);
  const c = crypto.createCipheriv('aes-256-gcm', kn.subarray(0, 32), kn.subarray(32, 44));
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(Buffer.from('hello')), c.final(), c.getAuthTag()]);
  ok(Buffer.concat([header, ct]).equals(Buffer.from(e.message)), 'message 1 is byte-identical to an independent node:crypto build');
  ok(header[0] === 0x01 && header[1] === 0x01 && header.subarray(2, 18).toString('hex') === e.messageId &&
    header.subarray(18, 50).toString('hex') === p.alice.dhSelf.pub && header.readUInt32BE(50) === 0 && header.readUInt32BE(54) === 0,
    'header fields at the §3.1 offsets: version 0x01, kind 0x01, messageId 2-17, DHr 18-49, PN 50-53, N 54-57');
  const e2 = R.encrypt(e.state, te('two'), p.dA);
  ok(Buffer.from(e2.message).readUInt32BE(54) === 1, 'control: the second message carries N = 1');
}
{
  let bin = null;
  try { bin = createRequire(path.join(repo, 'package.json'))('electron'); } catch { bin = null; }
  if (typeof bin !== 'string' || !fs.existsSync(bin)) console.log('  NOT CHECKED: Electron binary not found next to gmp-core — Electron vector check not run');
  else {
    const r = spawnSync(bin, [fileURLToPath(import.meta.url), '--vectors-only'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').trim().split('\n').find((l) => l.startsWith('VECTORS ')) || '';
    const ver = spawnSync(bin, ['-p', 'process.versions.electron + " / node " + process.versions.node'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).stdout.trim();
    ok(line === `VECTORS ${JSON.stringify(got)}` && vec && JSON.parse(line.slice(8)).digests.join() === vec.messageSha256Prefix.join(),
      `Electron main (${ver}, ELECTRON_RUN_AS_NODE) produces the committed digests (${line ? 'got output' : 'no output: ' + (r.stderr || '').slice(0, 160)})`);
  }
}

// ── sizes, labels ────────────────────────────────────────────────────────
console.log('\n=== sizes (§3.1) and labels (§5) ===');
{
  const p = pair('sizes');
  ok(R.OVERHEAD[1] === 74 && R.OVERHEAD[2] === 114 && R.HEADER_LEN[1] === 58 && R.HEADER_LEN[2] === 98 && R.TAG_LEN === 16,
    'overhead 74 (kind 0x01) / 114 (kind 0x02); headers 58 / 98; tag 16');
  const lens = [0, 1, 100, 3998].map((n) => R.encrypt(p.alice, new Uint8Array(n), p.dA).message.length);
  ok(JSON.stringify(lens) === JSON.stringify([74, 75, 174, 4072]), `plaintext 0 / 1 / 100 / 3998 → message ${lens.join(' / ')} (74 + plaintext, no padding: R7)`);
  const h = R.encodeHeader({ version: 1, kind: 2, messageId: new Uint8Array(16).fill(5), ek: new Uint8Array(32).fill(7), sentAt: T0, dh: new Uint8Array(32).fill(9), pn: 3, n: 4 });
  const back = R.decodeMessage(new Uint8Array([...h, ...new Uint8Array(16)]));
  ok(h.length === 98 && h[18] === 7 && h[50 + 7] === Number(BigInt(T0) & 0xffn) && h[58] === 9 && back.header.sentAt === T0 && back.header.pn === 3 && back.header.n === 4,
    'kind 0x02 header codec: EK_s at 18, sentAt (u64 BE) at 50, DHr at 58, PN/N after');
  let refused = 0;
  for (const bad of [{ kind: 2 }, { kind: 9 }, { pn: -1 }, { n: 2 ** 32 }, { messageId: new Uint8Array(15) }]) {
    try { R.encodeHeader({ version: 1, kind: 1, messageId: new Uint8Array(16), dh: new Uint8Array(32), pn: 0, n: 0, ...bad }); } catch { refused++; }
  }
  ok(refused === 5, `the encoder refuses bad headers (${refused}/5: initial without EK_s, unknown kind, negative PN, N ≥ 2^32, short messageId)`);
  ok(R.LABELS.RK === 'gl-ratchet-rk-v1' && R.LABELS.MK === 'gl-ratchet-mk-v1' && R.LABELS.AD === 'gl-ratchet-ad-v1' && Object.keys(R.LABELS).length === 3,
    'the module uses exactly the doc\'s three ratchet labels (uniqueness: keys-test.js)');
  ok(R.MAX_SKIP === 1000 && R.MAX_SKIPPED_KEYS === 2000 && R.SKIPPED_TTL_MS === 8 * 86400000, 'MAX_SKIP 1000, skipped cap 2000, skipped TTL 8 days (§4.4)');
}

// ── 2. random schedules ───────────────────────────────────────────────────
console.log('\n=== 2. seeded schedules: reorder, delay, loss, crossing sends ===');
{
  let schedules = 0, delivered = 0, lost = 0, reordered = 0, crossing = 0, replaysRejected = 0, replaysTried = 0, maxGap = 0;
  const problems = [];
  const keysSeen = new Map();
  const observe = { onMessageKey: (op, k) => { if (op === 'encrypt') keysSeen.set(k, (keysSeen.get(k) || 0) + 1); } };
  for (let seed = 1; seed <= 60; seed++) {
    schedules++;
    const rnd = prng(seed);
    const clock = { t: T0 };
    const p = pair(`schedule-${seed}`, clock);
    const st = { A: p.alice, B: p.bob }, dep = { A: p.dA, B: p.dB };
    const inflight = [];
    const done_ = [];
    const lastN = { A: -1, B: -1 };
    let bobCanSend = false;
    const deliver = (m) => {
      const d = R.decrypt(st[m.to], m.msg, dep[m.to]);
      if (!d.ok || td(d.plaintext) !== m.text || d.messageId !== m.id) { problems.push(`seed ${seed} ${m.text}: ${d.ok ? 'wrong text' : d.reason}`); return; }
      st[m.to] = d.state; delivered++; done_.push(m);
      if (m.seq < lastN[m.to]) reordered++;
      lastN[m.to] = Math.max(lastN[m.to], m.seq);
      if (m.to === 'B') bobCanSend = true;
    };
    let seq = 0;
    for (let step = 0; step < 220; step++) {
      clock.t += Math.floor(rnd() * 60000);
      const r = rnd();
      const sender = r < 0.35 ? 'A' : r < 0.6 ? 'B' : null;
      if (sender && (sender === 'A' || bobCanSend)) {
        const to = sender === 'A' ? 'B' : 'A';
        if (inflight.some((m) => m.to === sender)) crossing++;                    // the other side's message is still in flight
        const text = `${sender}#${step}`;
        const e = R.encrypt(st[sender], te(text), dep[sender], { observe });
        st[sender] = e.state;
        inflight.push({ to, msg: e.message, text, id: e.messageId, seq: seq++ });
      } else if (inflight.length) {
        const i = Math.floor(rnd() * inflight.length);
        const m = inflight[i];
        const action = rnd();
        if (action < 0.08) { inflight.splice(i, 1); lost++; continue; }          // lost for good
        if (action < 0.30) continue;                                              // delayed
        const gap = inflight.filter((x) => x.to === m.to && x.seq < m.seq).length;
        maxGap = Math.max(maxGap, gap);
        inflight.splice(i, 1);
        deliver(m);
        if (rnd() < 0.1 && done_.length) {                                        // an immediate replay of something delivered
          const old = done_[Math.floor(rnd() * done_.length)];
          replaysTried++;
          const again = R.decrypt(st[old.to], old.msg, dep[old.to]);
          if (again.ok) problems.push(`seed ${seed}: replay of ${old.text} accepted`); else replaysRejected++;
        }
      }
    }
    for (const m of inflight) deliver(m);                                         // drain (lost ones stay lost)
    for (const m of done_) {                                                      // and every delivered message once more
      replaysTried++;
      const again = R.decrypt(st[m.to], m.msg, dep[m.to]);
      if (again.ok) problems.push(`seed ${seed}: replay of ${m.text} at the end accepted`); else replaysRejected++;
    }
  }
  ok(problems.length === 0, `${schedules} schedules: ${delivered} delivered messages each decrypted to the right text (problems: ${problems.slice(0, 3).join('; ') || 'none'})`);
  ok(reordered > 100 && crossing > 100 && lost > 50, `the schedules really reorder (${reordered}), cross (${crossing} sends with the peer's message in flight) and lose (${lost}); largest gap ${maxGap} ≤ MAX_SKIP`);
  ok(replaysTried > delivered && replaysRejected === replaysTried, `exactly once: ${replaysRejected}/${replaysTried} replays rejected (every delivered message replayed at the end)`);
  const reused = [...keysSeen.values()].filter((v) => v > 1).length;
  ok(keysSeen.size > 3000 && reused === 0, `one message key (key ‖ nonce) per encryption: ${keysSeen.size} encryptions, ${reused} reused`);
}

// ── §7 test 5: nonce-reuse witness ─────────────────────────────────────────
console.log('\n=== §7 test 5: re-using a state repeats (key, nonce) — the R5 restore rule is load-bearing ===');
{
  const p = pair('witness');
  const seen = [];
  const observe = { onMessageKey: (op, k) => { if (op === 'encrypt') seen.push(k); } };
  const snapshot = R.encrypt(p.alice, te('advance'), p.dA, { observe }).state;   // a chain-key snapshot
  const first = R.encrypt(snapshot, te('attack at dawn'), p.dA, { observe });
  const next = R.encrypt(first.state, te('later'), p.dA, { observe });
  ok(new Set(seen).size === 3, 'control: a state lineage gives three distinct (key, nonce) pairs');
  const restored = R.deserializeState(R.serializeState(snapshot));               // "restore" without the discard rule
  const again = R.encrypt(restored, te('attack at dusk'), p.dA, { observe });
  ok(seen[3] === seen[1], 'the restored snapshot derives the SAME AES key and nonce again (the rule in §4.5 is needed)');
  const x = Buffer.from(first.message.subarray(58, 58 + 14)), y = Buffer.from(again.message.subarray(58, 58 + 14));
  const xorCt = Buffer.from(x.map((b, i) => b ^ y[i])), xorPt = Buffer.from(te('attack at dawn').map((b, i) => b ^ te('attack at dusk')[i]));
  ok(xorCt.equals(xorPt), 'and the two ciphertexts XOR to the two plaintexts XOR (a real GCM keystream reuse)');
  ok(next.state.Ns === 3 && first.state.Ns === 2, 'control: within one lineage Ns only moves forward');
}

// ── 3. failure paths ──────────────────────────────────────────────────────
console.log('\n=== 3. every failure leaves the state byte-identical ===');
/** Decrypt against a deep-frozen copy; prove it unchanged and that no state came back. */
function attempt(state, msg, d) {
  const before = R.serializeState(state);
  const frozen = deepFreeze(JSON.parse(before));
  let res;
  try { res = R.decrypt(frozen, msg, d); } catch (e) { return { reason: `threw: ${e.message}`, same: false }; }
  return { reason: res.ok ? 'ACCEPTED' : res.reason, same: R.serializeState(frozen) === before && !('state' in res), res };
}
{
  const p = pair('failures');
  let { alice, bob } = p;
  const msgs = [];
  for (let i = 0; i < 4; i++) { const e = R.encrypt(alice, te(`m${i}`), p.dA); alice = e.state; msgs.push(e.message); }
  const other = pair('another-session');
  const otherSameKeys = R.initSender({ rootKey: crypto.randomBytes(32), remoteDhPub: Buffer.from(p.bob.dhSelf.pub, 'hex'), selfNodeId: A_ID, peerNodeId: B_ID }, deps('wrong-root'));
  const long = R.encrypt(p.alice, new Uint8Array(64), deps('failures-long')).message;   // 138 bytes ≥ 98 + 16
  const lowOrder = (() => { const c = new Uint8Array(msgs[0]); c.fill(0, 18, 50); return c; })();
  const cases = [
    ['tampered ciphertext', flip(msgs[0], 60), 'auth-failed'],
    ['tampered tag', flip(msgs[0], msgs[0].length - 1), 'auth-failed'],
    ['tampered header: N', flip(msgs[0], 57), 'auth-failed'],
    ['tampered header: PN', flip(msgs[0], 53), 'auth-failed'],
    ['tampered header: DHr', flip(msgs[0], 20), 'auth-failed'],
    ['tampered header: messageId (in the AD)', flip(msgs[0], 5), 'auth-failed'],
    ['malformed header: low-order DHr (all zero)', lowOrder, 'malformed'],
    ['malformed header: unknown version', (() => { const c = new Uint8Array(msgs[0]); c[0] = 0x09; return c; })(), 'unsupported-version'],
    ['malformed header: unknown kind', (() => { const c = new Uint8Array(msgs[0]); c[1] = 0x07; return c; })(), 'unsupported-kind'],
    ['malformed header: kind 0x02 (R6), full length', (() => { const c = new Uint8Array(long); c[1] = 0x02; return c; })(), 'unsupported-kind'],
    ['malformed header: kind 0x02, shorter than its header + tag', (() => { const c = new Uint8Array(msgs[0]); c[1] = 0x02; return c; })(), 'truncated'],
    ['truncated inside the header', msgs[0].slice(0, 50), 'truncated'],
    ['truncated tag', msgs[0].slice(0, msgs[0].length - 1), 'auth-failed'],
    ['truncated to header + 15', msgs[0].slice(0, 58 + 15), 'truncated'],
    ['one byte', msgs[0].slice(0, 1), 'malformed'],
    ['empty', new Uint8Array(0), 'malformed'],
    ['not bytes', 'a string', 'malformed'],
    ['wrong session (other keys)', R.encrypt(other.alice, te('not yours'), other.dA).message, 'auth-failed'],
    ['wrong session (same peer key, other root)', R.encrypt(otherSameKeys, te('not yours'), deps('wrong-root')).message, 'auth-failed'],
    ['wrong direction (Alice\'s own message back to Alice)', msgs[0], 'auth-failed', 'alice'],
    ['wrong NodeIDs in the AD', R.encrypt({ ...p.alice, selfNodeId: 'c3'.repeat(64) }, te('m0'), deps('failures/A')).message, 'auth-failed'],
  ];
  for (const [name, msg, want, who] of cases) {
    const r = attempt(who === 'alice' ? alice : bob, msg, who === 'alice' ? p.dA : p.dB);
    ok(r.same && r.reason === want, `${name}: rejected (${r.reason}), state byte-identical`);
  }
  // Positive control: the same untouched state takes the genuine message.
  const g = R.decrypt(bob, msgs[0], p.dB);
  ok(g.ok && td(g.plaintext) === 'm0', 'control: the unchanged state then decrypts the genuine m0');
  bob = g.state;
  const replay = attempt(bob, msgs[0], p.dB);
  ok(replay.same && replay.reason === 'no-key', `replay of m0 (current chain, key deleted): rejected (${replay.reason}), state byte-identical`);
  // Skipped-key path: m3 first stores m1, m2; a tampered m1 fails without using up the key.
  const d3 = R.decrypt(bob, msgs[3], p.dB); bob = d3.state;
  ok(d3.ok && bob.skipped.length === 2, 'control: m3 out of order stores the keys for m1 and m2');
  const t1 = attempt(bob, flip(msgs[1], 60), p.dB);
  ok(t1.same && t1.reason === 'auth-failed', `tampered m1 on the skipped-key path: rejected (${t1.reason}), state byte-identical`);
  const g1 = R.decrypt(bob, msgs[1], p.dB);
  ok(g1.ok && td(g1.plaintext) === 'm1' && g1.state.skipped.length === 1, 'control: the genuine m1 still decrypts, and its skipped key is then deleted');
  bob = g1.state;
  const r1 = attempt(bob, msgs[1], p.dB);
  ok(r1.same && r1.reason === 'no-key', `replayed m1 after its skipped key was deleted: rejected (${r1.reason}), state byte-identical`);
  // DH-ratchet path: a reply from Bob, tampered, must not step Alice's ratchet.
  const rep = R.encrypt(bob, te('reply'), p.dB);
  for (const [name, bad] of [['ciphertext', flip(rep.message, 60)], ['DHr', flip(rep.message, 25)], ['PN', flip(rep.message, 52)]]) {
    const tr = attempt(alice, bad, p.dA);
    ok(tr.same && tr.reason !== 'ACCEPTED', `new ratchet key, tampered ${name}: rejected (${tr.reason}), no ratchet step, state byte-identical`);
  }
  const gr = R.decrypt(alice, rep.message, p.dA);
  ok(gr.ok && td(gr.plaintext) === 'reply' && gr.state.dhRemote !== alice.dhRemote, 'control: the genuine reply then steps the ratchet and decrypts');
  const rr = attempt(gr.state, rep.message, p.dA);
  ok(rr.same && rr.reason === 'no-key', `replay of the reply after the DH step: rejected (${rr.reason}), state byte-identical`);
  let threw = false;
  try { R.encrypt(pair('fresh').bob, te('x'), p.dB); } catch { threw = true; }
  ok(threw, 'a receiver with no sending chain cannot encrypt');
}
console.log('\n=== 3b. MAX_SKIP (1000 per chain step), on the current chain and across a DH step ===');
{
  const p = pair('max-skip');
  let alice = p.alice;
  const msgs = [];
  for (let i = 0; i <= R.MAX_SKIP + 1; i++) { const e = R.encrypt(alice, te(`n${i}`), p.dA); alice = e.state; msgs.push(e.message); }
  const far = attempt(p.bob, msgs[R.MAX_SKIP + 1], p.dB);
  ok(far.same && far.reason === 'too-many-skipped', `a gap of MAX_SKIP+1 (${R.MAX_SKIP + 1} skipped): rejected (${far.reason}), state byte-identical`);
  const edge = R.decrypt(p.bob, msgs[R.MAX_SKIP], p.dB);
  ok(edge.ok && edge.state.skipped.length === R.MAX_SKIP, `control: a gap of exactly MAX_SKIP decrypts and stores ${R.MAX_SKIP} skipped keys`);
  const after = R.decrypt(edge.state, msgs[R.MAX_SKIP + 1], p.dB);
  ok(after.ok, 'and the message that was too far ahead now decrypts');
  // Across a DH step: Bob has m0 only; Alice sends 1001 more, then Bob replies and Alice answers on a new chain.
  const q = pair('max-skip-pn');
  let a = q.alice, b = q.bob;
  const e0 = R.encrypt(a, te('first'), q.dA); a = e0.state; b = R.decrypt(b, e0.message, q.dB).state;
  const rep = R.encrypt(b, te('reply'), q.dB); b = rep.state;
  for (let i = 0; i <= R.MAX_SKIP; i++) a = R.encrypt(a, te(`x${i}`), q.dA).state;   // 1001 never delivered: PN = 1002
  a = R.decrypt(a, rep.message, q.dA).state;
  const newChain = R.encrypt(a, te('new chain'), q.dA);
  const pnFar = attempt(b, newChain.message, q.dB);
  ok(pnFar.same && pnFar.reason === 'too-many-skipped', `PN says ${R.MAX_SKIP + 1} unseen on the old chain: rejected (${pnFar.reason}), state byte-identical`);
  const q2 = pair('max-skip-pn');
  let a2 = q2.alice, b2 = q2.bob;
  const f0 = R.encrypt(a2, te('first'), q2.dA); a2 = f0.state; b2 = R.decrypt(b2, f0.message, q2.dB).state;
  const rep2 = R.encrypt(b2, te('reply'), q2.dB); b2 = rep2.state;
  for (let i = 0; i < R.MAX_SKIP; i++) a2 = R.encrypt(a2, te(`x${i}`), q2.dA).state;
  a2 = R.decrypt(a2, rep2.message, q2.dA).state;
  const ok2 = R.decrypt(b2, R.encrypt(a2, te('new chain'), q2.dA).message, q2.dB);
  ok(ok2.ok && ok2.state.skipped.length === R.MAX_SKIP, `control: exactly ${R.MAX_SKIP} unseen on the old chain is accepted (${ok2.ok ? ok2.state.skipped.length + ' stored' : ok2.reason})`);
}
console.log('\n=== 3c. skipped-key cap (2000, oldest evicted) and 8-day expiry ===');
{
  const clock = { t: T0 };
  const p = pair('cap', clock);
  let { alice, bob } = p;
  const chain = (tag) => { const out = []; for (let i = 0; i <= 1000; i++) { const e = R.encrypt(alice, te(`${tag}${i}`), p.dA); alice = e.state; out.push(e.message); } return out; };
  const turn = () => { const e = R.encrypt(bob, te('turn'), p.dB); bob = e.state; alice = R.decrypt(alice, e.message, p.dA).state; };
  const c1 = chain('a'); bob = R.decrypt(bob, c1[1000], p.dB).state;
  turn(); const c2 = chain('b'); bob = R.decrypt(bob, c2[1000], p.dB).state;
  ok(bob.skipped.length === 2000, `two chains of 1000 skipped: ${bob.skipped.length} stored`);
  const beforeThird = bob;
  turn(); const c3 = chain('c'); bob = R.decrypt(bob, c3[1000], p.dB).state;
  ok(bob.skipped.length === R.MAX_SKIPPED_KEYS, `a third chain keeps the store at the cap (${bob.skipped.length})`);
  const oldest = attempt(bob, c1[0], p.dB);
  ok(oldest.same && oldest.reason !== 'ACCEPTED', `the oldest skipped key was evicted (${oldest.reason}), state byte-identical`);
  const oldestBefore = R.decrypt(beforeThird, c1[0], p.dB);
  ok(oldestBefore.ok, 'control: before the third chain the same message decrypted');
  const newest = R.decrypt(bob, c3[999], p.dB);
  ok(newest.ok && td(newest.plaintext) === 'c999', 'control: the newest skipped key still decrypts');
  const fresh = R.decrypt(newest.state, c3[998], { ...p.dB, now: () => T0 + 1 });
  ok(fresh.ok, 'control: a skipped key inside 8 days decrypts');
  const late = attempt(newest.state, c3[998], { ...p.dB, now: () => T0 + R.SKIPPED_TTL_MS + 1 });
  ok(late.same && late.reason === 'no-key', `a skipped key older than 8 days is not used (${late.reason}), state byte-identical`);
}

// ── 4. serialisation ──────────────────────────────────────────────────────
console.log('\n=== 4. serialise -> deserialise mid-conversation ===');
{
  const p = pair('serialise');
  let { alice, bob } = p;
  const m = [];
  for (let i = 0; i < 3; i++) { const e = R.encrypt(alice, te(`s${i}`), p.dA); alice = e.state; m.push(e.message); }
  bob = R.decrypt(bob, m[2], p.dB).state;                                       // s0, s1 skipped
  const rt = (s) => R.deserializeState(R.serializeState(s));
  ok(R.serializeState(rt(bob)) === R.serializeState(bob), 'a round trip is byte-identical');
  alice = rt(alice); bob = rt(bob);
  const d0 = R.decrypt(bob, m[0], p.dB); bob = rt(d0.state);
  const e = R.encrypt(bob, te('after restore'), p.dB); bob = rt(e.state);
  const da = R.decrypt(alice, e.message, p.dA); alice = rt(da.state);
  const d1 = R.decrypt(bob, m[1], p.dB); bob = rt(d1.state);
  const e2 = R.encrypt(alice, te('new chain'), p.dA);
  const d2 = R.decrypt(bob, e2.message, p.dB);
  ok(d0.ok && da.ok && d1.ok && d2.ok && td(d2.plaintext) === 'new chain', 'skipped keys, two DH turns and both directions continue across round trips');
  const good = R.serializeState(alice);
  const bad = {
    'not JSON': '{', 'empty object': '{}', 'wrong version': good.replace('"v":1', '"v":2'),
    'bad root key': good.replace(/"rootKey":"[0-9a-f]+"/, '"rootKey":"zz"'),
    'dhSelf.pub not from dhSelf.priv': good.replace(/"pub":"[0-9a-f]+"/, `"pub":"${'00'.repeat(32)}"`),
    'negative counter': good.replace(/"Ns":\d+/, '"Ns":-1'),
    'skipped over the cap': JSON.stringify({ ...JSON.parse(good), skipped: Array.from({ length: 2001 }, (_, n) => ({ dh: '11'.repeat(32), n, mk: '22'.repeat(32), at: T0 })) }),
  };
  const refused = Object.entries(bad).filter(([, t]) => { try { R.deserializeState(t); return false; } catch { return true; } }).map(([k]) => k);
  ok(refused.length === Object.keys(bad).length, `malformed states are refused (${refused.length}/${Object.keys(bad).length}: ${Object.keys(bad).filter((k) => !refused.includes(k)).join(', ') || 'all'})`);
  let goodOk = false; try { R.deserializeState(good); goodOk = true; } catch { /* reported */ }
  ok(goodOk, 'control: the genuine state is accepted');
}

// ── purity, isolation ─────────────────────────────────────────────────────
console.log('\n=== purity: no I/O, timers, globals or node built-ins; inputs never written ===');
{
  const src = fs.readFileSync(path.join(pkg, 'src', 'ratchet', 'ratchet.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const impure = /from ['"](node:)?(crypto|fs|path|os|net|dgram|child_process|worker_threads)['"]|\bDate\b|\bMath\.random\b|\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bprocess\b|\bglobalThis\b|\bwindow\b|\brequire\(|\bBuffer\b|\bcrypto\.getRandomValues\b|\brandomBytes\b|\bfetch\(/;
  assertAbsent({
    channel: 'I/O, timers, globals or node built-ins in src/ratchet/ratchet.ts',
    controlMessage: 'the matcher finds planted Date.now(), Buffer.from() and an fs import',
    control: () => ['const t = Date.now();', 'Buffer.from(x)', "import fs from 'fs';"].filter((s) => impure.test(s)).length === 3,
    absent: () => !impure.test(src),
    message: 'none: randomness and time come only from the injected deps',
  });
  const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  ok(imports.length === 5 && imports.every((m) => m.startsWith('@noble/')), `the only imports are @noble (${imports.join(', ')})`);
  const p = pair('purity');
  const a = deepFreeze(JSON.parse(R.serializeState(p.alice)));
  const b = deepFreeze(JSON.parse(R.serializeState(p.bob)));
  let threw = null;
  try { const e = R.encrypt(a, te('frozen input'), p.dA); const d = R.decrypt(b, e.message, p.dB); if (!d.ok) threw = d.reason; } catch (e) { threw = e.message; }
  ok(threw === null, 'encrypt and a successful decrypt both work on deep-frozen inputs (they never write to them)');
  const before = R.serializeState(p.alice);
  R.encrypt(p.alice, te('x'), p.dA);
  ok(R.serializeState(p.alice) === before, 'the caller\'s state object is unchanged after encrypt');
}
console.log('\n=== nothing outside tests imports the ratchet yet ===');
{
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === 'node_modules') continue; if (e.isDirectory()) walk(p); else if (/\.(ts|js|mjs|cjs|html)$/.test(e.name)) files.push(p); } };
  for (const d of ['gmp-core/src', 'electron/src', 'src', 'mobile/src', 'scripts', 'shared']) if (fs.existsSync(path.join(repo, d))) walk(path.join(repo, d));
  for (const f of ['index.html', 'app.bundle.js', 'mobile/index.js']) if (fs.existsSync(path.join(repo, f))) files.push(path.join(repo, f));
  const re = /ratchet\/ratchet(\.js|\.ts)?['"]|['"]\.\/ratchet(\.js)?['"]/;
  const self = path.join(pkg, 'src', 'ratchet', 'ratchet.ts');
  assertAbsent({
    channel: 'an importer of the ratchet outside tests',
    controlMessage: 'the matcher finds a planted `import … from \'./ratchet/ratchet.js\'`',
    control: () => re.test("import { encrypt } from './ratchet/ratchet.js';"),
    absent: () => files.filter((f) => f !== self && re.test(fs.readFileSync(f, 'utf8'))).length === 0,
    message: `none in ${files.length} source files (gmp-core/src, electron/src, src, mobile/src, scripts, shared, index.html, app.bundle.js)`,
  });
}

// ── 5. libsignal behavioural differential ─────────────────────────────────
console.log('\n=== 5. behavioural differential vs @signalapp/libsignal-client ===');
{
  let diff = null, why = null;
  try { diff = await import('./helpers/libsignal-differential.mjs'); } catch (e) { why = `helper failed to load: ${e.message}`; }
  const result = diff ? await diff.run(R, { pair, te, td, prng, flip }) : { skip: why };
  if (result.skip) console.log(`  SKIP libsignal differential: ${result.skip}`);
  else for (const c of result.checks) ok(c.ok, c.msg);
}

// ── 6. AGPL boundary ──────────────────────────────────────────────────────
console.log('\n=== 6. AGPL boundary: libsignal never ships ===');
{
  const NAME = '@signalapp/libsignal-client';
  const LIBSIGNAL = /@signalapp\/libsignal|libsignal-client|libsignal_client|signal_node/i;
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8'));
  const manifests = { 'gmp-core/package.json': readJson('gmp-core/package.json'), 'package.json': readJson('package.json'), 'electron/package.json': readJson('electron/package.json') };
  const mobilePkg = path.join(repo, 'mobile', 'package.json');
  if (fs.existsSync(mobilePkg)) manifests['mobile/package.json'] = readJson('mobile/package.json');
  const runtimeHits = (ms) => Object.entries(ms).flatMap(([f, m]) => ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']
    .filter((k) => m[k] && (Array.isArray(m[k]) ? m[k].includes(NAME) : NAME in m[k])).map((k) => `${f} ${k}`));
  assertAbsent({
    channel: `${NAME} in a runtime dependency (${Object.keys(manifests).join(', ')})`,
    controlMessage: 'the same check finds a planted gmp-core dependency',
    control: () => runtimeHits({ ...manifests, 'gmp-core/package.json': { ...manifests['gmp-core/package.json'], dependencies: { ...manifests['gmp-core/package.json'].dependencies, [NAME]: '1' } } }),
    absent: () => runtimeHits(manifests).length === 0,
    message: `not a runtime dependency anywhere; gmp-core devDependency: ${NAME in (manifests['gmp-core/package.json'].devDependencies || {}) ? 'yes' : 'no'}`,
  });
  const lockPkgs = JSON.parse(fs.readFileSync(path.join(pkg, 'package-lock.json'), 'utf8')).packages || {};
  const lockEntry = lockPkgs[`node_modules/${NAME}`];
  ok(!lockEntry || lockEntry.dev === true, `gmp-core lockfile marks it dev-only (${lockEntry ? `dev: ${lockEntry.dev}` : 'absent'})`);

  /** Paths and text under a directory that mention libsignal. */
  const scanDir = (dir) => {
    const hits = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (LIBSIGNAL.test(p)) hits.push(p);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.asar')) hits.push(...scanAsar(fs.readFileSync(p)).map((h) => `${p}:${h}`));
      else if (e.name === 'package.json') { if (runtimeHits({ [p]: JSON.parse(fs.readFileSync(p, 'utf8')) }).length) hits.push(p); }
      // A manifest may NAME it under devDependencies (the shipped gmp-core/package.json does); that is not the library.
      else if (/\.(js|mjs|cjs|json|node|ts|map|bundle)$/.test(e.name) && LIBSIGNAL.test(fs.readFileSync(p, 'latin1'))) hits.push(p);
    } };
    walk(dir);
    return hits;
  };
  /** asar = u32 4, u32 headerPickleSize, u32, u32 jsonLen, JSON header, then file bodies. */
  function scanAsar(buf) {
    const jsonLen = buf.readUInt32LE(12);
    const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
    const base = 8 + buf.readUInt32LE(4);
    const hits = [];
    const walk = (node, p) => { for (const [k, v] of Object.entries(node.files || {})) {
      const q = `${p}/${k}`;
      if (LIBSIGNAL.test(q)) hits.push(q);
      if (v.files) walk(v, q);
      else if (!v.unpacked && v.size && LIBSIGNAL.test(buf.toString('latin1', base + Number(v.offset), base + Number(v.offset) + v.size))) hits.push(q);
    } };
    walk(header, '');
    return hits;
  }
  const makeAsar = (files) => {
    const header = { files: {} }; const bodies = []; let off = 0;
    for (const [name, text] of Object.entries(files)) {
      let node = header; const parts = name.split('/');
      for (const d of parts.slice(0, -1)) node = (node.files[d] ||= { files: {} });
      const b = Buffer.from(text); node.files[parts.at(-1)] = { size: b.length, offset: String(off) }; off += b.length; bodies.push(b);
    }
    const json = Buffer.from(JSON.stringify(header));
    const pad = (4 - (json.length % 4)) % 4;
    const h = Buffer.alloc(16); h.writeUInt32LE(4, 0); h.writeUInt32LE(8 + json.length + pad, 4); h.writeUInt32LE(4 + json.length + pad, 8); h.writeUInt32LE(json.length, 12);
    return Buffer.concat([h, json, Buffer.alloc(pad), ...bodies]);
  };
  const plantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-agpl-'));
  fs.mkdirSync(path.join(plantDir, 'gmp-core', 'node_modules', '@signalapp', 'libsignal-client'), { recursive: true });
  fs.writeFileSync(path.join(plantDir, 'gmp-core', 'node_modules', '@signalapp', 'libsignal-client', 'index.js'), '');
  fs.writeFileSync(path.join(plantDir, 'chunk.js'), `require("${NAME}")`);
  fs.mkdirSync(path.join(plantDir, 'runtime')); fs.mkdirSync(path.join(plantDir, 'devonly'));
  fs.writeFileSync(path.join(plantDir, 'runtime', 'package.json'), JSON.stringify({ dependencies: { [NAME]: '1' } }));
  fs.writeFileSync(path.join(plantDir, 'devonly', 'package.json'), JSON.stringify({ devDependencies: { [NAME]: '1' } }));
  fs.writeFileSync(path.join(plantDir, 'app.asar'), makeAsar({ 'node_modules/x/index.js': 'ok', 'node_modules/@signalapp/libsignal-client/index.js': '' }));
  const control = scanDir(plantDir);
  fs.rmSync(plantDir, { recursive: true, force: true });
  const has = (frag) => control.some((h) => h.includes(frag));
  ok(has(`node_modules${path.sep}@signalapp`) && has('chunk.js') && has('app.asar:') && has(`runtime${path.sep}package.json`) && !has('devonly'),
    `scanner control: finds a planted module directory, require, asar module and runtime manifest entry, and not a devDependencies-only manifest (${control.length} hits)`);

  const targets = [
    ['gmp-core/dist', path.join(pkg, 'dist')],
    ['app.bundle.js', path.join(repo, 'app.bundle.js')],
    ['the RN bundle (mobile/android/app/src/main/assets)', path.join(repo, 'mobile', 'android', 'app', 'src', 'main', 'assets')],
    ['the packaged Electron app (electron/dist/linux-unpacked/resources: app.asar + gmp-core/node_modules + webapp)', path.join(repo, 'electron', 'dist', 'linux-unpacked', 'resources')],
  ];
  for (const [label, p] of targets) {
    if (!fs.existsSync(p)) { console.log(`  NOT CHECKED: ${label} — not built here`); continue; }
    const st = fs.statSync(p);
    const hits = st.isDirectory() ? scanDir(p) : (LIBSIGNAL.test(fs.readFileSync(p, 'latin1')) ? [p] : []);
    const age = st.isDirectory() && label.includes('packaged') ? ` (asar built ${fs.statSync(path.join(p, 'app.asar')).mtime.toISOString()})` : '';
    ok(hits.length === 0, `${label}: no libsignal${age} (${hits.slice(0, 3).join(', ') || '0 hits'})`);
  }
  const shipped = path.join(repo, 'electron', 'dist', 'linux-unpacked', 'resources', 'gmp-core', 'package.json');
  if (fs.existsSync(shipped)) {
    const m = JSON.parse(fs.readFileSync(shipped, 'utf8'));
    console.log(`  note: the packaged gmp-core/package.json names ${NAME} under devDependencies: ${NAME in (m.devDependencies || {}) ? 'yes (name only; no code ships)' : 'no'}`);
  }
  const extra = (manifests['electron/package.json'].build || {}).extraResources || [];
  const fromNodeModules = extra.filter((r) => /node_modules/.test(r.from)).map((r) => r.from);
  ok(fromNodeModules.length > 0 && fromNodeModules.every((f) => f.startsWith('../node_modules/') && !LIBSIGNAL.test(f)),
    `electron-builder copies modules only from the ROOT node_modules, never gmp-core's (${fromNodeModules.join(', ')})`);
}

done();
