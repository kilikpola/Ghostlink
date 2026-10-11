/**
 * Nonce-store invariant trace (I0-I4 from nonce-store.ts) against a strict
 * NonceStore and, where they apply, EphemeralNonceState; one TRACE line per
 * check. The "-promo" lines walk I1-I4 through a responder session's deferred
 * claim with real nodes.
 *
 * Run: node test/nonce-invariant-trace-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NonceStore, deriveNonceStoreKey } from '../dist/nonce-store.js';
import { DEBUG_ASSERTS } from '../dist/claim-log.js';
import { EphemeralNonceState } from '../dist/link/ephemeral-nonce-state.js';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { fingerprintKey } from '../dist/link/session.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { withSource } from './helpers/ephemeral-source.mjs';

let run = 0, passed = 0, failed = 0;
function trace(inv, ok, msg) {
  run++;
  if (ok) passed++; else failed++;
  console.log(`  TRACE ${inv.padEnd(9)} ${ok ? 'HOLDS' : 'VIOLATED'}  ${msg}`);
}

const SEED = 'invariant trace seed phrase';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-invariants-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
const stateFile = path.join(dir, 'nonce-state.json');
const open = (extra = {}) => new NonceStore({ stateFile, seedPhrase: SEED, strictState: true, ...extra }).load();
const peerA = new Uint8Array(64).fill(0xa1);
const peerB = new Uint8Array(64).fill(0xb2);
const fp = () => crypto.randomBytes(16).toString('hex');

console.log(`strictState: true   claim-log debug asserts armed: ${DEBUG_ASSERTS}   dir=${dir}\n`);

// I0 — record boundaries, asserted by claim-log.ts after every mutation when GMP_DEBUG_ASSERTS is set
{
  const s = open();
  let threw = null;
  try {
    for (let i = 0; i < 300; i++) s.claimSessionKey(peerA, fp());
    s.close();
    open().close();
  } catch (e) { threw = e; }
  trace('I0', threw === null && DEBUG_ASSERTS === true,
    `300 appends + reload with boundary assertions armed (GMP_DEBUG_ASSERTS, armed=${DEBUG_ASSERTS}): ${threw ? threw.message : 'no assertion fired'}`);
}

// I1 — a fingerprint is claimed at most once, ever
{
  const s = open();
  const f = fp();
  const first = s.claimSessionKey(peerA, f).valid;
  const again = s.claimSessionKey(peerA, f).valid;
  const otherPeer = s.claimSessionKey(peerB, f).valid;
  s.close();
  const afterRestart = open();
  const restart = afterRestart.claimSessionKey(peerA, f).valid;
  afterRestart.close();
  trace('I1', first && !again, 'same fingerprint, same peer, same process: second claim refused');
  trace('I1', !otherPeer, 'same fingerprint, different peer: refused (keyed by fingerprint alone)');
  trace('I1', !restart, 'same fingerprint after restart (fresh strict store on the same files): refused');

  const e1 = new EphemeralNonceState();
  const ef = fp();
  const eFirst = e1.claimSessionKey(peerA, ef).valid;
  const eAgain = e1.claimSessionKey(peerA, ef).valid;
  e1.close();
  trace('I1-eph', eFirst && !eAgain, 'ephemeral identity: second claim on the same connection refused');
  const e2 = new EphemeralNonceState();
  const nextConnection = e2.claimSessionKey(peerA, ef).valid;
  e2.close();
  trace('I1-eph', nextConnection === true,
    'SCOPE (observed): a new connection\'s ephemeral store accepts the same fingerprint — for ephemeral identities I1 is per connection, not across connections or restarts (by design, GM-N1b-3)');
}

// I2 — high-water marks never decrease
{
  const key = crypto.randomBytes(32);
  const s = open();
  s.updateCounters(peerA, key, 10, 7);
  s.updateCounters(peerA, key, 3, 2);
  const live = s.getEntry(peerA, key);
  s.close();
  const r = open();
  const reloaded = r.getEntry(peerA, key);
  r.close();
  trace('I2', live && live.sendHighWater === 10 && live.recvHighWater === 7, `lower counters ignored in memory (send ${live && live.sendHighWater}, recv ${live && live.recvHighWater})`);
  trace('I2', reloaded && reloaded.sendHighWater === 10 && reloaded.recvHighWater === 7, `and after reload (send ${reloaded && reloaded.sendHighWater}, recv ${reloaded && reloaded.recvHighWater})`);

  const e = new EphemeralNonceState();
  e.updateCounters(peerA, key, 10, 7);
  e.updateCounters(peerA, key, 3, 2);
  const ee = e.getEntry(peerA, key);
  e.close();
  trace('I2-eph', ee && ee.sendHighWater === 10 && ee.recvHighWater === 7, 'ephemeral: lower counters ignored');
}

// I3 — a claim reported successful is durable; no lock, no claim
{
  const s = open();
  const f = fp();
  const ok = s.claimSessionKey(peerA, f).valid;
  const other = open();                       // a second process's view, s still open
  const seenElsewhere = !other.claimSessionKey(peerB, f).valid;
  other.close();
  trace('I3', ok && seenElsewhere, 'successful claim is on disk before return (an independent store sees it; the original is still open)');

  const lockPath = `${s.claimsFile}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() }));
  s.close();
  const blocked = open({ lockTimeoutMs: 150 });
  const underLock = blocked.claimSessionKey(peerA, fp()).valid;
  fs.rmSync(lockPath, { force: true });
  blocked.close();
  trace('I3', underLock === false, 'lock held by a live owner: the claim is refused, not reported successful');

  const before = fs.readdirSync(dir).sort().join(',');
  const e = new EphemeralNonceState();
  e.claimSessionKey(peerA, fp());
  e.updateCounters(peerA, crypto.randomBytes(32), 5, 5);
  e.close();
  trace('I3-eph', fs.readdirSync(dir).sort().join(',') === before, 'ephemeral: nothing written anywhere (no durability claimed, none needed)');
}

// I4 — state is merged, never replaced
{
  const keyA = crypto.randomBytes(32);
  const keyB = crypto.randomBytes(32);
  const s1 = open();
  const s2 = open();
  s1.updateCounters(peerA, keyA, 4, 4);
  s2.updateCounters(peerB, keyB, 9, 9);
  s1.close();
  s2.close();
  const s3 = open();
  const a = s3.getEntry(peerA, keyA);
  const b = s3.getEntry(peerB, keyB);
  s3.close();
  trace('I4', a && b && a.sendHighWater === 4 && b.sendHighWater === 9, 'two writers on one file: both entries survive (merge, not replace)');
}

// strict mode itself
{
  const f = path.join(dir, 'corrupt-state.json');
  const w = new NonceStore({ stateFile: f, seedPhrase: SEED, strictState: true }).load();
  w.updateCounters(peerA, crypto.randomBytes(32), 1, 1);
  w.close();
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  o.ciphertext = (o.ciphertext.slice(0, 2) === 'ff' ? '00' : 'ff') + o.ciphertext.slice(2);
  fs.writeFileSync(f, JSON.stringify(o));
  let name = null;
  const realErr = console.error;
  console.error = () => {};
  try { new NonceStore({ stateFile: f, seedPhrase: SEED, strictState: true }).load(); } catch (e) { name = e.name; } finally { console.error = realErr; }
  trace('strict', name === 'StateAuthenticationError', `an unauthenticatable state file is refused (${name})`);
}

// Promotion: the responder's claim moves to the first non-relay frame
{
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const hexOf = (b) => Buffer.from(b).toString('hex');
  const network = new MemoryNetwork();
  const nodeDir = path.join(dir, 'promo');
  const made = [];
  const mk = async (seed, cfg = {}) => {
    const n = createGMPNode({ config: { ...DEFAULTS, GMP_STRICT_STATE: true, ...cfg }, dataDir: path.join(nodeDir, seed.replace(/\W+/g, '-')), port: 0, transport: new MemoryTransport(network) });
    n.on('error', () => {});
    made.push(n);
    await n.loadIdentity(seed);
    n.peerExchange.close(); // keep the peers silent: every frame below is the test's
    return n;
  };
  const R = await mk('trace relay', { GMP_RELAY_ENABLED: true, GMP_RELAY_ROLE_OBSERVATION_MS: 60000 });
  await R.listen();
  // Another process's view of R's files, opened the way GMPNode opens them.
  const rDir = path.join(nodeDir, 'trace-relay');
  const independent = () => {
    const st = new NonceStore({ stateFile: path.join(rDir, 'nonce-state.json'), claimsFile: path.join(rDir, 'nonce-claims.log'), strictState: true });
    st.setEncryptionKey(deriveNonceStoreKey('trace relay'));
    return st.load();
  };
  const linkFrom = (node) => [...R.links.values()].find((l) => l.remoteNodeId && hexOf(l.remoteNodeId) === node.identity.nodeIdHex);

  // I1 + I3: durable before dispatch, refused by another process's view
  const C = await mk('trace peer one');
  await C.dial('memory', R.port);
  await delay(20);
  const rc = linkFrom(C);
  const pendingClaims = R.nonceStore.claimCount;
  let atDispatch = null;
  R.once('message', () => {
    const other = independent();
    atDispatch = !other.claimSessionKey(new Uint8Array(64).fill(9), fingerprintKey(rc.sendKey)).valid;
    other.close();
  });
  await C.getLinkByNodeId(R.identity.nodeId).send('first');
  await delay(30);
  trace('I3-promo', rc.role === 'peer' && atDispatch === true,
    `claim made on the first non-relay frame is on disk when that frame is dispatched (independent strict store refuses the fingerprint: ${atDispatch})`);
  trace('I1-promo', pendingClaims === 0 && R.nonceStore.claimCount === 1, `one claim per session, none while pending (pending ${pendingClaims}, after ${R.nonceStore.claimCount})`);

  // I2: counters carried into the persisted store, never below the link's
  await C.getLinkByNodeId(R.identity.nodeId).send('second');
  await delay(30);
  const entry = R.nonceStore.getEntry(rc.remoteNodeId, rc.sendKey);
  trace('I2-promo', entry && entry.sendHighWater === rc.sendNonceCounter && entry.recvHighWater === rc.recvNonceCounter,
    `persisted marks equal the live counters after promotion (send ${entry && entry.sendHighWater}/${rc.sendNonceCounter}, recv ${entry && entry.recvHighWater}/${rc.recvNonceCounter}), including those advanced in memory before it`);

  // I1: a fingerprint already claimed elsewhere is refused at promotion, before dispatch
  const D = await mk('trace peer two');
  await D.dial('memory', R.port);
  await delay(20);
  const rd = linkFrom(D);
  const other = independent();
  const preclaimed = other.claimSessionKey(new Uint8Array(64).fill(7), fingerprintKey(rd.sendKey)).valid;
  other.close();
  let dispatched = 0;
  const onMsg = () => { dispatched++; };
  R.on('message', onMsg);
  await D.getLinkByNodeId(R.identity.nodeId).send('must not be dispatched');
  await delay(30);
  R.off('message', onMsg);
  trace('I1-promo', preclaimed && rd.state === 'closed' && dispatched === 0,
    `fingerprint claimed by another process first: promotion refused, session torn down, frame never dispatched (state ${rd.state}, dispatched ${dispatched})`);

  // I4: promotion merges into the file other writers share
  R.nonceStore._saveNow(); // counters are batched once a second; write now
  const r2 = independent();
  const merged = r2.getEntry(rc.remoteNodeId, rc.sendKey);
  const bothClaims = r2.claimCount;
  r2.close();
  trace('I4-promo', merged && merged.sendHighWater === rc.sendNonceCounter && bothClaims === 2,
    `promoted counters reach the shared file (send ${merged && merged.sendHighWater}) beside the other writer's claim: ${bothClaims} claims, both survive`);

  // A relay-only session leaves nothing behind
  const claimsBeforeHop = R.nonceStore.claimCount;
  const hop = await RelayHop.open(new MemoryTransport(network), { address: 'memory', port: R.port }, withSource());
  await hop.reserve();
  const rh = [...R.links.values()].find((l) => l.remoteNodeId && hexOf(l.remoteNodeId) === hexOf(hop.link.identity.nodeId));
  hop.close();
  await delay(30);
  R.nonceStore.save();
  const after = independent();
  const hopEntry = Object.keys(after.state.entries).some((k) => k.startsWith(hexOf(hop.link.identity.nodeId)));
  after.close();
  trace('scope', rh.role === 'hop' && R.nonceStore.claimCount === claimsBeforeHop && !hopEntry,
    'SCOPE (by design): a session that carries only relay frames is never persisted — I1 for it holds per connection; its replay protection is the handshake\'s fresh ephemeral + key confirmation (docs/relay-metadata.md)');
  // The same for a session that carries only storage frames (0x11-0x15)
  const claimsBeforeSf = R.nonceStore.claimCount;
  const sfHops = [];
  for (const type of [0x11, 0x12, 0x13, 0x14, 0x15]) {
    const h = await RelayHop.open(new MemoryTransport(network), { address: 'memory', port: R.port }, withSource());
    h.link.sendRelay(type, Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]));
    sfHops.push(h);
  }
  await delay(30);
  const sfRoles = sfHops.map((h) => [...R.links.values()].find((l) => l.remoteNodeId && hexOf(l.remoteNodeId) === hexOf(h.link.identity.nodeId))?.role);
  for (const h of sfHops) h.close();
  await delay(30);
  R.nonceStore._saveNow();
  const afterSf = independent();
  const sfEntry = Object.keys(afterSf.state.entries).some((k) => sfHops.some((h) => k.startsWith(hexOf(h.link.identity.nodeId))));
  afterSf.close();
  trace('scope-sf', sfRoles.every((r) => r === 'hop') && R.nonceStore.claimCount === claimsBeforeSf && !sfEntry,
    `SCOPE (by design, GM-N2-0): sessions whose first frame is 0x11-0x15 are hops, never persisted (roles ${sfRoles.join(',')}; claims ${claimsBeforeSf}->${R.nonceStore.claimCount})`);
  for (const n of made) n.close();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
