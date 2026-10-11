/**
 * Relay hop nonce state is observed, not signalled. The dialer keeps hop
 * state in memory locally; the relay holds every inbound session's nonce state
 * in memory until its first non-relay frame.
 *
 *  1. ephemeral identities are local only; their HELLO uses version 0x01 and a
 *     0x81 HELLO is refused like any unknown version
 *  2. a strict-state relay carries 10 relayed sessions without growing its
 *     claim log, counter state or peer cache, and emits no 'connection' for hops
 *  3. a real identity is claimed and persisted before its first non-relay
 *     frame is dispatched; 'connection' precedes the message
 *  4. a silent real peer becomes a peer when the observation window closes
 *  5. a refused claim tears the session down before dispatch (fails closed)
 *  6. a link observed as a hop carries relay frames only
 *  7. replayed handshake against a relay-only link (docs/relay-metadata.md)
 *  8. after restart: exactly the real claims survive, no hop NodeID anywhere
 *  9. EphemeralNonceState unit properties
 *
 * Run: node test/relay-ephemeral-nonce-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { generateEphemeralIdentity, deriveIdentityFromSeedPhrase, generateEphemeralKeyPair } from '../dist/identity.js';
import { buildHello } from '../dist/link/handshake.js';
import { fingerprintKey } from '../dist/link/session.js';
import { encodeFrame, MESSAGETYPES } from '../dist/link/frame.js';
import { EphemeralNonceState } from '../dist/link/ephemeral-nonce-state.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { withSource } from './helpers/ephemeral-source.mjs';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-ephemeral-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const nodes = [];
const RELAY_SEED = 'ephemeral nonce test relay';
const relayDir = path.join(tmp, 'relay');

async function makeNode(network, seed, cfg = {}, dir = null, extra = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_STRICT_STATE: true, ...cfg },
    dataDir: dir || path.join(tmp, seed.replace(/\W+/g, '-')),
    port: 0,
    transport: new MemoryTransport(network),
    ...extra,
  });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}

/** R's link to the node with this NodeID. */
const linkTo = (R, nodeIdHex) => [...R.links.values()].find((l) => l.remoteNodeId && hex(l.remoteNodeId) === nodeIdHex);

async function testMarking() {
  console.log('\n=== 1. the hop identity is marked locally, never on the wire ===');
  const eph = generateEphemeralIdentity();
  assert(eph.ephemeral === true, 'generateEphemeralIdentity() marks the identity ephemeral (local knowledge)');
  const real = await deriveIdentityFromSeedPhrase('ephemeral nonce test real');
  assert(!real.ephemeral, 'a seed-phrase identity is not ephemeral');
  const kp = generateEphemeralKeyPair();
  const hEph = buildHello(eph, kp.ephemeralPub, Date.now(), crypto.randomBytes(32));
  const hReal = buildHello(real, kp.ephemeralPub, Date.now(), crypto.randomBytes(32));
  assert(hEph[0] === 0x01 && hReal[0] === 0x01,
    `version byte is 0x01 for both (ephemeral 0x${hEph[0].toString(16).padStart(2, '0')}, real 0x${hReal[0].toString(16).padStart(2, '0')}) — nothing marks a hop`);
  assert(hEph.length === hReal.length, 'same HELLO length for hop and real identities');

  // A HELLO carrying the retired 0x81 is an unknown version, as on any old node.
  const network = new MemoryNetwork();
  const R = await makeNode(network, 'flag probe responder', { GMP_RELAY_ENABLED: true });
  await R.listen();
  const errors = [];
  R.on('error', (e) => errors.push(e.err.message));
  const conn = await new MemoryTransport(network).dial({ port: R.port });
  const signer = { ...eph };
  const flagged = buildHello(signer, kp.ephemeralPub, Date.now(), crypto.randomBytes(32));
  flagged[0] = 0x81; // signature no longer matters: the version check comes first
  conn.write(encodeFrame(MESSAGETYPES.HELLO, flagged));
  await delay(50);
  assert(errors.some((m) => /Unsupported protocol version: 129/.test(m)), `a 0x81 HELLO is refused as an unsupported version (${JSON.stringify(errors)})`);
  conn.destroy();
}

async function testRelay() {
  const network = new MemoryNetwork();
  const R = await makeNode(network, RELAY_SEED, { GMP_RELAY_ENABLED: true, GMP_RELAY_ROLE_OBSERVATION_MS: 300 }, relayDir);
  await R.listen();
  const relayConnections = [];
  R.on('connection', (e) => relayConnections.push(hex(e.peerNodeId)));
  const claimsBefore = R.nonceStore.claimCount;
  const claimLogSize = () => (fs.existsSync(R.nonceStore.claimsFile) ? fs.statSync(R.nonceStore.claimsFile).size : 0);
  const logBefore = claimLogSize();

  console.log('\n=== 2. ten relayed sessions through a strict-state relay ===');
  const B = await makeNode(network, 'ephemeral nonce test callee');
  const addr = { address: 'memory', port: R.port };
  const res = await B.reserveRelay(addr);
  const hopIds = new Set();
  const hopLinks = [];
  const record = () => {
    for (const l of R.links.values()) {
      if (l.remoteNodeId && !hopLinks.includes(l)) { hopIds.add(hex(l.remoteNodeId)); hopLinks.push(l); }
    }
  };
  for (let i = 0; i < 10; i++) {
    const A = await makeNode(network, `ephemeral nonce test dialler ${i}`);
    const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
    await out.link.send(`hello ${i}`);
    await delay(20);
    record();
    out.link.destroy();
    await delay(20);
  }
  record();
  await delay(400); // past the observation window: nothing may flip to 'peer' late
  const clientHop = [...B.relayReservations.values()][0].hop;
  assert(hopIds.size >= 11, `relay saw ${hopIds.size} throwaway hop identities`);
  assert(R.nonceStore.claimCount === claimsBefore && claimLogSize() === logBefore,
    `relay claim log did not grow (${claimsBefore} claims, ${logBefore} bytes)`);
  const entries = Object.keys(R.nonceStore.state.entries);
  assert(!entries.some((k) => [...hopIds].some((id) => k.startsWith(id))), `relay counter state holds no hop NodeID (${entries.length} entries)`);
  assert(!R.peerCache.cache.some((p) => hopIds.has(p.nodeId)), 'relay peer cache holds no hop NodeID');
  assert(relayConnections.length === 0 && R.connections.size === 0, 'the relay treats hops as infrastructure, not peers (no connection event)');
  assert(hopLinks.length > 0 && hopLinks.every((l) => l.role === 'hop'), `every relay-side hop link was observed as a hop (${hopLinks.map((l) => l.role).join(',')})`);
  assert(hopLinks.every((l) => l.nonceStore instanceof EphemeralNonceState), 'and kept in-memory EphemeralNonceState');
  assert(clientHop.link.nonceStore instanceof EphemeralNonceState && clientHop.link.role === 'hop', 'client side of the hop: in-memory state by local decision');

  console.log('\n=== 3. a real identity: in memory until its first non-relay frame ===');
  const C = await makeNode(network, 'ephemeral nonce test real peer');
  await C.dial('memory', R.port);
  await delay(30);
  const rc = linkTo(R, C.identity.nodeIdHex);
  assert(rc && rc.state === 'connected' && rc.role === 'pending', `after the handshake the relay has not classified the link yet (${rc && rc.role})`);
  assert(R.nonceStore.claimCount === claimsBefore && rc.nonceStore instanceof EphemeralNonceState, 'its nonce state is in memory: no claim persisted yet');
  const order = [];
  R.once('connection', () => order.push(`connection(claims=${R.nonceStore.claimCount})`));
  R.once('message', () => order.push(`message(claims=${R.nonceStore.claimCount})`));
  const outC = C.getLinkByNodeId(R.identity.nodeId);
  await outC.send('first non-relay frame');
  await delay(30);
  const n = claimsBefore + 1;
  assert(order.join(' ') === `connection(claims=${n}) message(claims=${n})`,
    `claimed and persisted before the frame is dispatched; connection precedes message (${order.join(' ')})`);
  assert(rc.role === 'peer' && rc.nonceStore === R.nonceStore, 'the link is a peer and now uses the persisted store');
  assert(claimLogSize() > logBefore, 'the claim is in the log on disk');

  console.log('\n=== 4. a silent real peer ===');
  const D = await makeNode(network, 'ephemeral nonce test silent peer');
  D.peerExchange.close();
  await D.dial('memory', R.port);
  await delay(30);
  const rd = linkTo(R, D.identity.nodeIdHex);
  assert(rd.role === 'pending' && R.nonceStore.claimCount === n, 'silent: still pending inside the observation window, nothing persisted');
  // Watch what the relay sends it: the send side promotes too.
  const sent = [];
  const write = rd.socket.write.bind(rd.socket);
  rd.socket.write = (d, cb) => { sent.push({ type: Buffer.from(d)[4], claims: R.nonceStore.claimCount }); return write(d, cb); };
  await delay(400);
  assert(rd.role === 'peer' && relayConnections.includes(D.identity.nodeIdHex), 'after the window it is a peer (connection emitted)');
  const firstOther = sent.find((f) => ![MESSAGETYPES.PING, MESSAGETYPES.PONG].includes(f.type));
  assert(firstOther && firstOther.claims === n + 1 && rd.nonceStore === R.nonceStore,
    `persisted by the first non-relay frame in either direction — here the relay's own 0x${firstOther ? firstOther.type.toString(16).padStart(2, '0') : '??'} to the new peer, claimed before it was written`);
  const outD = D.getLinkByNodeId(R.identity.nodeId);
  await outD.send('late first frame');
  await delay(30);
  assert(R.nonceStore.claimCount === n + 1, 'its own first frame claims nothing more (one claim per session)');

  console.log('\n=== 5. the persisted store refuses: torn down before dispatch ===');
  {
    const refusing = {
      claimSessionKey: () => ({ valid: false, reason: 'test: fingerprint already claimed' }),
      updateCounters: () => {},
      close: () => {},
      setEncryptionKey: () => {},
    };
    const net2 = new MemoryNetwork();
    const R2 = await makeNode(net2, 'refusing relay', {}, null, { nonceStore: refusing });
    await R2.listen();
    const got = [];
    R2.on('message', (e) => got.push(e.msg));
    const E = await makeNode(net2, 'refused peer');
    E.peerExchange.close();
    await E.dial('memory', R2.port);
    await delay(30);
    const re = linkTo(R2, E.identity.nodeIdHex);
    const outE = E.getLinkByNodeId(R2.identity.nodeId);
    await outE.send('must never be dispatched');
    await delay(50);
    assert(re.state === 'closed' && got.length === 0, `refused claim: link closed (${re.state}), frame never dispatched (${got.length} messages)`);
  }

  console.log('\n=== 6. a link observed as a hop carries relay frames only ===');
  const hop = await RelayHop.open(new MemoryTransport(network), addr, withSource());
  await hop.reserve();
  const rh = linkTo(R, hex(hop.link.identity.nodeId));
  assert(rh && rh.role === 'hop', 'relay classified the reserver hop as a hop on its first relay frame');
  const closed = new Promise((r) => rh.once('close', r));
  hop.link.identity = { ...hop.link.identity, ephemeral: false }; // let the client side send it
  hop.link.role = 'peer';
  await hop.link.send('ordinary data on a relay hop');
  const wasClosed = await Promise.race([closed.then(() => true), delay(1000).then(() => false)]);
  assert(wasClosed, 'a non-relay frame on a hop link tears it down');
  assert(R.nonceStore.claimCount === n + 1, 'and nothing was persisted for it');

  await testReplay(R, network, addr, n + 1);
  await testStorageFrames(R, network, addr, n + 1);

  console.log('\n=== 8. after restart ===');
  for (const node of nodes.splice(0)) node.close();
  await delay(50);
  const R3 = await makeNode(new MemoryNetwork(), RELAY_SEED, { GMP_RELAY_ENABLED: true }, relayDir);
  R3.nonceStore.load();
  const after = Object.keys(R3.nonceStore.state.entries);
  assert(R3.nonceStore.claimCount === claimsBefore + 2, `after restart: exactly the two real claims survive (${R3.nonceStore.claimCount})`);
  assert(!after.some((k) => [...hopIds].some((id) => k.startsWith(id))), 'after restart: no hop NodeID in persisted counters');
  assert(after.some((k) => k.startsWith(C.identity.nodeIdHex)), 'after restart: the real peer\'s counters are there');
}

/**
 * The attack in docs/relay-metadata.md: record a hop's handshake, replay it to
 * open a second session, never send a non-relay frame — so nothing was ever
 * persisted that could refuse it.
 */
async function testReplay(R, network, addr, claims) {
  console.log('\n=== 7. replayed handshake against a relay-only link ===');
  // A recording tap on the client's connection: every write is one frame.
  const recorded = [];
  const tapped = new MemoryTransport(network);
  const dial = tapped.dial.bind(tapped);
  tapped.dial = async (o) => {
    const c = await dial(o);
    const w = c.write.bind(c);
    c.write = (d, cb) => { recorded.push(Buffer.from(d)); return w(d, cb); };
    return c;
  };
  const victim = await RelayHop.open(tapped, addr, withSource());
  await victim.reserve();
  await delay(20);
  const original = linkTo(R, hex(victim.link.identity.nodeId));
  const reservations = R.relayServer.getStats().reservationsActive;
  const types = recorded.map((f) => f[4]);
  assert(types[0] === MESSAGETYPES.HELLO && types[1] === MESSAGETYPES.PING && types.includes(MESSAGETYPES.RELAY_RESERVE),
    `recorded the victim's HELLO, key-confirmation PING and RELAY_RESERVE (types ${types.map((t) => '0x' + t.toString(16)).join(' ')})`);

  // Replay 1: the HELLO alone, then everything else, on a new connection.
  const errors = [];
  const onErr = (e) => errors.push(e.err.message);
  R.on('error', onErr);
  const attacker = await new MemoryTransport(network).dial({ port: R.port });
  const fromRelay = [];
  attacker.on('data', (d) => fromRelay.push(d));
  attacker.write(recorded[0]);
  await delay(30);
  const replayed = [...R.links.values()].find((l) => l !== original && l.remoteNodeId && hex(l.remoteNodeId) === hex(victim.link.identity.nodeId));
  assert(replayed && replayed.state === 'confirming', `the relay accepts the replayed HELLO (valid signature, in window) and waits for key confirmation (${replayed && replayed.state})`);
  assert(replayed && fingerprintKey(replayed.sendKey) !== fingerprintKey(original.sendKey),
    'the replayed session has a different key: the relay contributed a fresh ephemeral, so a claim store could never have matched it');
  for (const f of recorded.slice(1)) attacker.write(f);
  await delay(50);
  assert(replayed.state === 'closed' && errors.some((m) => /PING decryption failed/.test(m)),
    `the recorded key-confirmation PING does not open under the new key: link closed (${JSON.stringify(errors.slice(-1))})`);
  assert(replayed.role !== 'hop' && R.relayServer.getStats().reservationsActive === reservations,
    'the replayed RELAY_RESERVE was never processed: no reservation, never classified');
  assert(R.nonceStore.claimCount === claims, 'nothing persisted, and nothing needed to be');

  // Replay 2: HELLO only, attacker stays silent — no relay frame is ever handled.
  const attacker2 = await new MemoryTransport(network).dial({ port: R.port });
  attacker2.write(recorded[0]);
  await delay(20);
  const replayed2 = [...R.links.values()].find((l) => l !== original && l !== replayed && l.remoteNodeId && hex(l.remoteNodeId) === hex(victim.link.identity.nodeId));
  attacker2.write(recorded[2]);
  await delay(20);
  assert(replayed2 && replayed2.state === 'confirming' && R.relayServer.getStats().reservationsActive === reservations,
    'HELLO replayed alone: stuck in confirming; relay frames are ignored until key confirmation (closed by the 10 s confirmation timer)');
  attacker2.destroy();
  R.off('error', onErr);
  victim.close();
}

/**
 * Storage frames (0x11-0x15) behave like relay frames: a hop whose first frame
 * is one of them persists nothing, and a replay cannot get one processed.
 */
async function testStorageFrames(R, network, addr, claims) {
  console.log('\n=== 7b. storage frames 0x11-0x15 are infrastructure frames ===');
  const handled = [];
  const orig = R.handleStorageFrame ? R.handleStorageFrame.bind(R) : null;
  R.handleStorageFrame = (link, type, pt) => { handled.push({ link, type }); if (orig) orig(link, type, pt); };
  const ALL = [0x11, 0x12, 0x13, 0x14, 0x15];
  const roles = [];
  for (const type of ALL) {
    const hop = await RelayHop.open(new MemoryTransport(network), addr, withSource());
    hop.link.sendRelay(type, Buffer.from('{}'));
    await delay(20);
    const rl = linkTo(R, hex(hop.link.identity.nodeId));
    roles.push(`0x${type.toString(16)}:${rl ? rl.role : 'gone'}`);
    hop.close();
  }
  await delay(20);
  assert(roles.every((r) => r.endsWith(':hop')), `a session whose first frame is 0x11-0x15 is a hop (${roles.join(' ')})`);
  assert(R.nonceStore.claimCount === claims, `nothing persisted for any of them (claims ${R.nonceStore.claimCount})`);
  assert(ALL.every((t) => handled.some((h) => h.type === t)), 'each reached the node\'s storage handler, hop-decrypted');

  // A storage hop is locked to infrastructure frames too.
  const hop = await RelayHop.open(new MemoryTransport(network), addr, withSource());
  hop.link.sendRelay(0x13, Buffer.from('{}'));
  await delay(20);
  const rl = linkTo(R, hex(hop.link.identity.nodeId));
  const closed = new Promise((r) => rl.once('close', r));
  hop.link.role = 'peer';
  hop.link.identity = { ...hop.link.identity, ephemeral: false };
  await hop.link.send('ordinary data on a storage hop');
  assert(await Promise.race([closed.then(() => true), delay(1000).then(() => false)]), 'a non-infrastructure frame on a storage hop tears it down');

  // Replay, restated for storage: record a hop whose first frame is STORE_REQUEST.
  const recorded = [];
  const tapped = new MemoryTransport(network);
  const dial = tapped.dial.bind(tapped);
  tapped.dial = async (o) => {
    const c = await dial(o);
    const w = c.write.bind(c);
    c.write = (d, cb) => { recorded.push(Buffer.from(d)); return w(d, cb); };
    return c;
  };
  const victim = await RelayHop.open(tapped, addr, withSource());
  victim.link.sendRelay(0x11, Buffer.from('{"victim":true}'));
  await delay(20);
  const before = handled.length;
  const errors = [];
  const onErr = (e) => errors.push(e.err.message);
  R.on('error', onErr);
  const attacker = await new MemoryTransport(network).dial({ port: R.port });
  attacker.write(recorded[0]);
  await delay(20);
  const replayed = [...R.links.values()].find((l) => l.state === 'confirming' && l.remoteNodeId && hex(l.remoteNodeId) === hex(victim.link.identity.nodeId));
  assert(replayed && fingerprintKey(replayed.sendKey) !== fingerprintKey(linkTo(R, hex(victim.link.identity.nodeId)).sendKey),
    'replayed HELLO of a storage hop: accepted, new key (fresh relay ephemeral), waiting for confirmation');
  for (const f of recorded.slice(1)) attacker.write(f);
  await delay(40);
  assert(replayed.state === 'closed' && errors.some((m) => /PING decryption failed/.test(m)) && handled.length === before,
    `recorded PING fails under the new key; the replayed STORE_REQUEST is never handled (${handled.length - before} handled)`);
  assert(R.nonceStore.claimCount === claims, 'nothing persisted');
  R.off('error', onErr);
  attacker.destroy();
  victim.close();
  R.handleStorageFrame = orig || undefined;
}

function testEphemeralStore() {
  console.log('\n=== 9. EphemeralNonceState ===');
  const before = fs.readdirSync(tmp).length;
  const s = new EphemeralNonceState();
  const peer = new Uint8Array(64).fill(3);
  const key = crypto.randomBytes(32);
  assert(s.claimSessionKey(peer, 'fp-1').valid === true, 'first claim of a fingerprint succeeds');
  assert(s.claimSessionKey(peer, 'fp-1').valid === false, 'a second claim of it on this connection is refused (I1, connection scope)');
  s.updateCounters(peer, key, 10, 7);
  s.updateCounters(peer, key, 3, 2);
  const e = s.getEntry(peer, key);
  assert(e && e.sendHighWater === 10 && e.recvHighWater === 7, `high-water marks never decrease (I2): send ${e && e.sendHighWater}, recv ${e && e.recvHighWater}`);
  s.close();
  assert(s.size === 0, 'evicted on close');
  assert(s.claimSessionKey(peer, 'fp-2').valid === false, 'a closed store refuses further claims (fails closed)');
  assert(fs.readdirSync(tmp).length === before, 'never touched the filesystem');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N1c-1 — Relay Hop Nonce State (observed) Test          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testMarking();
    await testRelay();
    testEphemeralStore();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
