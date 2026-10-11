/**
 * Ephemeral non-repetition: a repeated RNG output must not repeat an ephemeral
 * scalar, HKDF(rng || bootCounter || processSequence, ctx).
 *
 * Each case pins the RNG to a constant. A = raw RNG scalar; B = the source.
 *
 *  a. RNG repeat, same process       -> A identical, B differ (processSequence)
 *  b. RNG repeat across restart      -> A identical, B differ (bootCounter)
 *  c. relay: two handshakes to a relay host -> B's responder ephemerals differ,
 *     so no two RELAY_RESERVATIONs share a (key, nonce)
 *  d. the same for a storage host
 *  e. counter persist fails          -> throws; loadIdentity refuses
 *  f. crash after persist, before use -> next boot reads N+1; N never reused
 *  g. counter rollback (cleared)     -> returns to 0 (known residual)
 *  + a counter-bound node interoperates with the old build
 *
 * Run: node test/ephemeral-nonrepeat-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { generateEphemeralKeyPair, generateEphemeralIdentity } from '../dist/identity.js';
import { EphemeralKeySource } from '../dist/link/ephemeral-source.js';
import { advanceBootCounter, BootCounterError } from '../dist/boot-counter.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { StorageSession } from '../dist/storage/storage-client.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { withSource } from './helpers/ephemeral-source.mjs';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-m32-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const nodes = [];

/** Pin the global RNG to a constant for the duration of `fn` (simulate total RNG failure). */
async function withPinnedRng(fn) {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const fixed = new Uint8Array(32).fill(0x7);
  globalThis.crypto.getRandomValues = (arr) => { new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).fill(0x7); return arr; };
  try { return await fn(); } finally { globalThis.crypto.getRandomValues = real; }
}

async function makeNode(seed, cfg = {}, network = new MemoryNetwork()) {
  const n = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false, ...cfg }, dataDir: path.join(tmp, seed.replace(/\W+/g, '-')), port: 0, transport: new MemoryTransport(network) });
  n.on('error', () => {});
  nodes.push(n);
  await n.loadIdentity(seed);
  return { n, network };
}

async function run() {
  console.log('=== a-b. RNG repeat: A raw-RNG identical, B source differs ===');
  await withPinnedRng(() => {
    const A1 = generateEphemeralKeyPair();
    const A2 = generateEphemeralKeyPair();
    assert(hex(A1.ephemeralPub) === hex(A2.ephemeralPub), 'A (pre-fix, raw RNG): two keypairs are IDENTICAL under a repeated RNG — the vulnerability');

    const Ai1 = generateEphemeralIdentity();
    const Ai2 = generateEphemeralIdentity();
    assert(Ai1.nodeIdHex === Ai2.nodeIdHex, 'A (pre-fix, raw RNG): two THROWAWAY IDENTITIES are IDENTICAL under a repeated RNG — two hops that should be unlinkable are the same node');

    const src = new EphemeralKeySource(5n);
    const b1 = src.next(); const b2 = src.next();
    assert(hex(b1.ephemeralPub) !== hex(b2.ephemeralPub), 'B same process: source keypairs DIFFER under the same repeated RNG (processSequence)');

    const bi1 = src.nextIdentity(); const bi2 = src.nextIdentity();
    assert(bi1.nodeIdHex !== bi2.nodeIdHex, 'B: source throwaway identities DIFFER under the same repeated RNG');
    assert(bi1.ephemeral === true && bi2.ephemeral === true, 'B: source identities are still marked ephemeral (the GM-N2-4 guard still applies)');
    // one shared sequence: a keypair draw and an identity draw never reuse a context
    const sameCtx = new EphemeralKeySource(5n);
    sameCtx.next(); sameCtx.next();
    assert(hex(sameCtx.nextIdentity().seed) !== hex(new EphemeralKeySource(5n).next().ephemeralPriv), 'keypair and identity draws share one sequence and use distinct HKDF info — no cross-collision');

    const restart = new EphemeralKeySource(6n); // boot counter advanced
    const b3 = restart.next();
    assert(hex(b3.ephemeralPub) !== hex(b1.ephemeralPub), 'B across restart: seq 0 at boot 6 differs from seq 0 at boot 5 (bootCounter)');
    // and identical inputs are deterministic, proving the difference is the counter, not luck
    const same = new EphemeralKeySource(5n).next();
    assert(hex(same.ephemeralPub) === hex(b1.ephemeralPub), 'sanity: identical (boot, seq, pinned RNG) is deterministic, so the differences above come only from the counter');
  });

  console.log('\n=== c. §6 relay host: BOTH sides differ under a pinned RNG ===');
  await withPinnedRng(async () => {
    const { n: relay, network } = await makeNode('m32 relay host', { GMP_RELAY_ENABLED: true });
    await relay.listen();
    const addr = { address: 'memory', port: relay.port };
    const before = relay.ephemeralSource.produced;
    const pubs = new Set();      // responder (relay-side) ephemerals
    const hopPubs = new Set();   // initiator (hop-side) ephemerals
    const hopIds = new Set();    // throwaway hop identities
    // One source across all three hops, as a real node has: proves the
    // sequence advances per draw, not merely per source.
    const src = withSource();
    for (let i = 0; i < 3; i++) {
      const hop = await RelayHop.open(new MemoryTransport(network), addr, src);
      // the relay's link to this hop is the responder; its ephemeral is what §6 reuses
      for (const l of relay.links.values()) if (l.ephemeralKeyPair) pubs.add(hex(l.ephemeralKeyPair.ephemeralPub));
      hopPubs.add(hex(hop.link.ephemeralKeyPair.ephemeralPub));
      hopIds.add(hop.hopIdentity.nodeIdHex);
      hop.close();
      await delay(20);
    }
    assert(pubs.size >= 3, `RESPONDER: relay produced ${pubs.size} distinct ephemerals across 3 hops under a pinned RNG (A would give 1) — no two RELAY_RESERVATIONs share a (key, nonce)`);
    assert(hopPubs.size === 3, `INITIATOR: the hop side produced ${hopPubs.size}/3 distinct ephemerals under the same pinned RNG (A gave 1/3)`);
    assert(hopIds.size === 3, `the 3 throwaway hop identities are distinct (${hopIds.size}/3) under a pinned RNG — A gave 1/3, which also re-linked hops meant to be unlinkable`);
    assert(relay.ephemeralSource.produced > before, `the relay's ephemerals came from its bound source (produced ${relay.ephemeralSource.produced})`);
  });

  console.log('\n=== d. §6 storage host: same ===');
  await withPinnedRng(async () => {
    const { n: store, network } = await makeNode('m32 storage host', { GMP_STORAGE_ENABLED: true });
    await store.listen();
    const addr = { address: 'memory', port: store.port };
    const pubs = new Set();
    const sessPubs = new Set();
    const src = withSource();
    for (let i = 0; i < 3; i++) {
      const sess = await StorageSession.open(new MemoryTransport(network), addr, src);
      for (const l of store.links.values()) if (l.ephemeralKeyPair) pubs.add(hex(l.ephemeralKeyPair.ephemeralPub));
      sessPubs.add(hex(sess.link.ephemeralKeyPair.ephemeralPub));
      sess.close();
      await delay(20);
    }
    assert(pubs.size >= 3, `RESPONDER: storage host produced ${pubs.size} distinct ephemerals under a pinned RNG — no two FETCH_RESPONSEs share a (key, nonce)`);
    assert(sessPubs.size === 3, `INITIATOR: the session side produced ${sessPubs.size}/3 distinct ephemerals (A gave 1/3)`);
  });

  console.log('\n=== c/d-bis. the source is REQUIRED, not optional (M3-1b-2) ===');
  {
    const { n: relay, network } = await makeNode('m32 required src', { GMP_RELAY_ENABLED: true });
    await relay.listen();
    const addr = { address: 'memory', port: relay.port };
    let e1 = null, e2 = null, e3 = null;
    try { await RelayHop.open(new MemoryTransport(network), addr); } catch (e) { e1 = e; }
    assert(e1 && e1.reason === 'no-ephemeral-source', `RelayHop.open with no source REFUSES (${e1 && e1.reason}) rather than falling back to the bare RNG`);
    try { await StorageSession.open(new MemoryTransport(network), addr, {}); } catch (e) { e2 = e; }
    assert(e2 && e2.reason === 'no-ephemeral-source', `StorageSession.open with empty opts REFUSES (${e2 && e2.reason})`);
    // and a node that has not loaded an identity cannot draw one at all
    const bare = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false }, port: 0, transport: new MemoryTransport(network) });
    bare.on('error', () => {});
    try { bare.nextEphemeralKeyPair(); } catch (e) { e3 = e; }
    assert(e3 instanceof Error && /bare RNG/.test(e3.message), 'nextEphemeralKeyPair before loadIdentity THROWS instead of silently returning an RNG-only keypair');
    bare.close();
  }

  console.log('\n=== e-g. boot counter durability, write-ahead, rollback ===');
  const cfile = path.join(tmp, 'bc', 'boot-counter');
  const v0 = advanceBootCounter(cfile);
  assert(v0 === 1n && fs.readFileSync(cfile, 'utf8').trim() === '1', 'write-ahead: first call has already persisted 1 before returning it (0 never names a boot)');
  const v1 = advanceBootCounter(cfile);
  assert(v1 === 2n && fs.readFileSync(cfile, 'utf8').trim() === '2', 'second call persists 2, returns 2');
  // f. crash after persist, before use: the persisted value is read next boot; the used value is skipped, never reused
  fs.writeFileSync(cfile, '9\n'); // simulate: 9 persisted, process died before using 9
  const vf = advanceBootCounter(cfile);
  assert(vf === 10n && fs.readFileSync(cfile, 'utf8').trim() === '10', 'crash after persist: next boot uses 10 (9 skipped, never reused)');
  // e. persist failure -> throws; loadIdentity refuses
  let threw = null;
  try { advanceBootCounter(path.join(tmp, 'bc', 'boot-counter', 'cannot', 'be', 'a', 'dir', 'file')); } catch (e) { threw = e; }
  assert(threw instanceof BootCounterError, `persist failure throws BootCounterError (${threw && threw.name})`);
  {
    const bad = path.join(tmp, 'refuse'); fs.mkdirSync(bad, { recursive: true });
    // make the data dir's boot-counter path unwritable by making it a directory
    fs.mkdirSync(path.join(bad, 'boot-counter'));
    const n = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false }, dataDir: bad, port: 0, transport: new MemoryTransport() });
    n.on('error', () => {});
    let loadErr = null;
    try { await n.loadIdentity('m32 refuse to load'); } catch (e) { loadErr = e; }
    assert(loadErr instanceof BootCounterError, `loadIdentity refuses (throws) when the counter cannot persist (${loadErr && loadErr.name})`);
  }
  // g. rollback: clear the file -> counter returns to 0, re-issuing used values. Named residual.
  fs.rmSync(cfile);
  const roll = advanceBootCounter(cfile);
  assert(roll === 1n, 'ROLLBACK (file cleared): the counter returns to 1 and will re-issue counters it already used — the named residual; cross-restart non-repetition is lost for that range');

  console.log('\n=== unilateral: counter-bound node interoperates with the old build ===');
  const oldDist = path.join(process.cwd(), '..', '..', '62829549-8979-4739-bcb5-2967c6e4b48e', 'scratchpad', 'old', 'dist', 'link.js');
  const altOld = '/tmp/claude-1000/-home-shadow-Documents-Ghostlink/3f53d67d-11c2-4f27-ad38-60816e533a41/scratchpad/old/dist/link.js';
  const oldPath = fs.existsSync(oldDist) ? oldDist : (fs.existsSync(altOld) ? altOld : null);
  if (!oldPath) {
    console.log('  ~ old build snapshot not found; interop covered by interop-test.mjs');
  } else {
    const Old = await import(oldPath);
    const net = new MemoryNetwork();
    const { n: mine } = await makeNode('m32 mine', {}, net);
    await mine.listen();
    // old build uses TCP by default; use its own MemoryTransport if exported, else skip gracefully
    const oldNode = new Old.GMPNode({ port: 0, dataDir: path.join(tmp, 'old'), transport: new MemoryTransport(net) });
    oldNode.on('error', () => {});
    await oldNode.loadIdentity('m32 old peer');
    await oldNode.listen();
    let connected = false;
    mine.on('connection', () => { connected = true; });
    try { await oldNode.dial('memory', mine.port); await delay(200); } catch (e) { /* transport mismatch */ }
    assert(connected, 'an old-build peer completes a handshake with our counter-bound node (unilateral: the wire is unchanged)');
  }

  for (const n of nodes) { try { n.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
