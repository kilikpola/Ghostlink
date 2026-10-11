/**
 * Link module tests: each link/ module on its own, then a GMPLink responder
 * over an in-memory connection with malformed and hostile input.
 *
 * 1. frame: layout, reassembly from arbitrary chunking, size bound
 * 2. session: IV layout, AEAD round trip, every tamper/mismatch rejected,
 *    directional key agreement, static-key binding, low-order key rejection
 * 3. handshake: HELLO / HELLO_ACK layout, parse round trip, signature and
 *    NodeID-binding checks
 * 4. keepalive: interval, pong timeout, pong clears timeout, stop
 * 5. GMPLink: full handshake over MemoryConnection, NonceStore call semantics,
 *    session-key-reuse refusal, and rejection of oversized / unknown /
 *    truncated / wrong-version / forged / stale / low-order / reflected HELLOs,
 *    and a node dialling itself
 * 6. architecture: dist/link/ imports nothing above its layer
 *
 * Run: node test/link-modules-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MESSAGETYPES, FRAME_HEADER_LEN, MAX_MESSAGE_SIZE,
  encodeFrame, frameHeader, FrameDecoder, FrameTooLargeError,
} from '../dist/link/frame.js';
import {
  AUTH_TAG_LEN, buildGCMIV, sealFramePayload, openFramePayload,
  deriveLinkKeys, fingerprintKey, SessionKeyLRUSet,
} from '../dist/link/session.js';
import {
  HELLO_PAYLOAD_LEN, HELLO_ACK_PAYLOAD_LEN, HELLO_SIGNED_LEN, HELLO_ACK_SIGNED_LEN,
  buildHello, parseHello, buildHelloAck, parseHelloAck,
  nodeIdMatchesKeys, verifyHandshakeSignature,
} from '../dist/link/handshake.js';
import { Keepalive } from '../dist/link/keepalive.js';
import { GMPLink } from '../dist/link/link.js';
import { MemoryConnection, MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { createGMPNode } from '../dist/node-factory.js';
import { deriveIdentityFromSeedPhrase, generateEphemeralKeyPair, sha512 } from '../dist/identity.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

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

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');

// ── 1. frame ──────────────────────────────────────────

function testFrame() {
  console.log('\n=== Test 1: frame ===');

  const payload = Buffer.from('hello');
  const frame = encodeFrame(MESSAGETYPES.DATA, payload);
  assert(frame.length === FRAME_HEADER_LEN + 5, 'frame is header + payload');
  assert(frame.readUInt32BE(0) === 5 && frame[4] === MESSAGETYPES.DATA, 'header is [uint32 BE length][type]');
  assert(frame.slice(5).equals(payload), 'payload follows the header');
  assert(frameHeader(5, MESSAGETYPES.DATA).equals(frame.slice(0, 5)), 'frameHeader matches the encoded header');

  // Three frames, one of them empty, fed one byte at a time.
  const stream = Buffer.concat([
    encodeFrame(MESSAGETYPES.PING, Buffer.alloc(0)),
    encodeFrame(MESSAGETYPES.DATA, Buffer.from('abc')),
    encodeFrame(MESSAGETYPES.PONG, Buffer.alloc(300, 7)),
  ]);
  const decoder = new FrameDecoder();
  const out = [];
  for (const byte of stream) {
    decoder.push(Buffer.from([byte]));
    let f;
    while ((f = decoder.next()) !== null) out.push(f);
  }
  assert(out.length === 3, 'byte-at-a-time stream yields all three frames');
  assert(out[0].type === MESSAGETYPES.PING && out[0].payload.length === 0, 'empty-payload frame decoded');
  assert(out[1].type === MESSAGETYPES.DATA && out[1].payload.toString() === 'abc', 'second frame intact');
  assert(out[2].payload.length === 300 && out[2].payload.every((b) => b === 7), 'large frame intact');
  assert(decoder.buffered.length === 0, 'nothing left buffered');

  // Several frames arriving in one chunk.
  const d2 = new FrameDecoder();
  d2.push(stream);
  let n = 0;
  while (d2.next()) n++;
  assert(n === 3, 'single-chunk stream yields all three frames');

  // A declared length over the bound is refused from the header alone.
  const d3 = new FrameDecoder();
  const big = Buffer.alloc(5);
  big.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0);
  big[4] = MESSAGETYPES.DATA;
  d3.push(big);
  let err = null;
  try { d3.next(); } catch (e) { err = e; }
  assert(err instanceof FrameTooLargeError, 'oversized declared length throws FrameTooLargeError before any payload arrives');

  // Exactly the bound is accepted (waits for payload rather than throwing).
  const d4 = new FrameDecoder();
  const atLimit = Buffer.alloc(5);
  atLimit.writeUInt32BE(MAX_MESSAGE_SIZE, 0);
  atLimit[4] = MESSAGETYPES.DATA;
  d4.push(atLimit);
  assert(d4.next() === null, 'declared length == MAX_MESSAGE_SIZE is accepted');
}

// ── 2. session ────────────────────────────────────────

async function testSession() {
  console.log('\n=== Test 2: session ===');

  const iv = buildGCMIV(0x0102030405);
  assert(iv.length === 12 && iv.slice(0, 4).equals(Buffer.alloc(4)), 'IV is 4 zero bytes + counter');
  assert(iv.readBigUInt64BE(4) === 0x0102030405n, 'IV counter is big-endian');

  const key = crypto.randomBytes(32);
  const pt = Buffer.from('attack at dawn');
  const sealed = sealFramePayload(key, 7, MESSAGETYPES.DATA, pt);
  assert(sealed.length === AUTH_TAG_LEN + pt.length, 'sealed = 16-byte tag + same-length ciphertext');
  assert(openFramePayload(key, 7, MESSAGETYPES.DATA, sealed).equals(pt), 'seal/open round trip');

  const flip = (buf, i) => { const c = Buffer.from(buf); c[i] ^= 1; return c; };
  assert(throws(() => openFramePayload(key, 7, MESSAGETYPES.DATA, flip(sealed, 0))), 'tampered auth tag rejected');
  assert(throws(() => openFramePayload(key, 7, MESSAGETYPES.DATA, flip(sealed, sealed.length - 1))), 'tampered ciphertext rejected');
  assert(throws(() => openFramePayload(key, 8, MESSAGETYPES.DATA, sealed)), 'wrong counter (replay / reorder) rejected');
  assert(throws(() => openFramePayload(key, 7, MESSAGETYPES.PING, sealed)), 'wrong frame type (AAD) rejected');
  assert(throws(() => openFramePayload(crypto.randomBytes(32), 7, MESSAGETYPES.DATA, sealed)), 'wrong key rejected');
  assert(throws(() => openFramePayload(key, 7, MESSAGETYPES.DATA, sealed.slice(0, 10))), 'payload shorter than the tag rejected');
  assert(throws(() => openFramePayload(key, 7, MESSAGETYPES.DATA, sealed.slice(0, sealed.length - 1))), 'truncated ciphertext rejected');

  const a = await deriveIdentityFromSeedPhrase('link modules test identity a');
  const b = await deriveIdentityFromSeedPhrase('link modules test identity b');
  const ea = generateEphemeralKeyPair();
  const eb = generateEphemeralKeyPair();
  const initiator = deriveLinkKeys({
    isInitiator: true, localEphemeralPriv: ea.ephemeralPriv, remoteEphemeralPub: eb.ephemeralPub,
    localStaticPriv: a.staticPrivKey, remoteStaticPub: b.staticPubKey, localNodeId: a.nodeId, remoteNodeId: b.nodeId,
  });
  const responder = deriveLinkKeys({
    isInitiator: false, localEphemeralPriv: eb.ephemeralPriv, remoteEphemeralPub: ea.ephemeralPub,
    localStaticPriv: b.staticPrivKey, remoteStaticPub: a.staticPubKey, localNodeId: b.nodeId, remoteNodeId: a.nodeId,
  });
  assert(initiator.sendKey.equals(responder.recvKey), 'initiator send key == responder recv key');
  assert(initiator.recvKey.equals(responder.sendKey), 'initiator recv key == responder send key');
  assert(!initiator.sendKey.equals(initiator.recvKey), 'the two directions use different keys');

  // An impostor who knows A's public static key but not its private key.
  const mallory = await deriveIdentityFromSeedPhrase('link modules test impostor');
  const impostor = deriveLinkKeys({
    isInitiator: true, localEphemeralPriv: ea.ephemeralPriv, remoteEphemeralPub: eb.ephemeralPub,
    localStaticPriv: mallory.staticPrivKey, remoteStaticPub: b.staticPubKey, localNodeId: a.nodeId, remoteNodeId: b.nodeId,
  });
  assert(!impostor.sendKey.equals(responder.recvKey), 'without the static private key the impostor derives different keys');

  assert(throws(() => deriveLinkKeys({
    isInitiator: false, localEphemeralPriv: eb.ephemeralPriv, remoteEphemeralPub: new Uint8Array(32),
    localStaticPriv: b.staticPrivKey, remoteStaticPub: a.staticPubKey, localNodeId: b.nodeId, remoteNodeId: a.nodeId,
  })), 'low-order (all-zero) peer ephemeral key throws');

  const fp = fingerprintKey(initiator.sendKey);
  assert(/^[0-9a-f]{32}$/.test(fp) && fp === fingerprintKey(Buffer.from(initiator.sendKey)), 'fingerprint is stable 32-hex');

  const lru = new SessionKeyLRUSet(2);
  lru.add('k1'); lru.add('k2'); lru.add('k3');
  assert(!lru.has('k1') && lru.has('k2') && lru.has('k3') && lru.size() === 2, 'LRU evicts the oldest at capacity');
  assert(lru.add('k2') === false, 'LRU add of a present key reports false');
}

// ── 3. handshake ──────────────────────────────────────

async function testHandshake() {
  console.log('\n=== Test 3: handshake ===');

  const id = await deriveIdentityFromSeedPhrase('link modules test handshake');
  const eph = generateEphemeralKeyPair();
  const nonce = crypto.randomBytes(32);
  const ts = 1700000000123;

  const hello = buildHello(id, eph.ephemeralPub, ts, nonce);
  assert(hello.length === HELLO_PAYLOAD_LEN && hello[0] === 0x01, 'HELLO is 265 bytes, version 0x01');
  const h = parseHello(hello);
  assert(hex(h.nodeId) === hex(id.nodeId), 'HELLO NodeID round trips');
  assert(hex(h.staticPubkey) === hex(id.staticPubKey) && hex(h.signingPubkey) === hex(id.signingPubKey), 'HELLO keys round trip');
  assert(hex(h.ephemeralPubkey) === hex(eph.ephemeralPub) && h.timestamp === ts && h.nonce.equals(nonce), 'HELLO ephemeral / timestamp / nonce round trip');
  assert(h.signedPortion.length === HELLO_SIGNED_LEN, 'HELLO signed portion is bytes 0..200');
  assert(verifyHandshakeSignature(h.signingPubkey, h.signedPortion, h.signature), 'HELLO signature verifies');
  assert(nodeIdMatchesKeys(h.nodeId, h.staticPubkey, h.signingPubkey), 'HELLO NodeID binds to its static key');

  // One byte in each field: version, NodeID, static key, signing key,
  // ephemeral key, timestamp, nonce.
  const survivors = [0, 1, 70, 100, 130, 165, 180].filter((i) => {
    const t = Buffer.from(hello);
    t[i] ^= 0x01;
    const p = parseHello(t);
    return verifyHandshakeSignature(p.signingPubkey, p.signedPortion, p.signature);
  });
  assert(survivors.length === 0, `flipping a byte in any signed HELLO field breaks the signature ${JSON.stringify(survivors)}`);

  const other = await deriveIdentityFromSeedPhrase('link modules test other');
  assert(!nodeIdMatchesKeys(id.nodeId, other.staticPubKey, other.signingPubKey), 'NodeID does not bind to someone else\'s keys');
  assert(nodeIdMatchesKeys(sha512(id.signingPubKey), other.staticPubKey, id.signingPubKey), 'signing-key NodeID (rotated identity) accepted');

  const proof = crypto.randomBytes(48);
  const ack = buildHelloAck(id, eph.ephemeralPub, ts, proof);
  assert(ack.length === HELLO_ACK_PAYLOAD_LEN, 'HELLO_ACK is 280 bytes');
  const k = parseHelloAck(ack);
  assert(hex(k.nodeId) === hex(id.nodeId) && k.timestamp === ts && k.encryptedProof.equals(proof), 'HELLO_ACK fields round trip');
  assert(k.signedPortion.length === HELLO_ACK_SIGNED_LEN, 'HELLO_ACK signed portion is bytes 0..215');
  assert(verifyHandshakeSignature(k.signingPubkey, k.signedPortion, k.signature), 'HELLO_ACK signature verifies');
  const tAck = Buffer.from(ack);
  tAck[200] ^= 1; // inside the proof
  const kt = parseHelloAck(tAck);
  assert(!verifyHandshakeSignature(kt.signingPubkey, kt.signedPortion, kt.signature), 'tampered HELLO_ACK proof breaks the signature');
}

// ── 4. keepalive ──────────────────────────────────────

async function testKeepalive() {
  console.log('\n=== Test 4: keepalive ===');

  let ticks = 0;
  const k1 = new Keepalive({ intervalMs: 20, timeoutMs: 1000, onInterval: () => ticks++, onTimeout: () => {} });
  k1.start();
  await delay(110);
  k1.stop();
  const after = ticks;
  await delay(60);
  assert(after >= 3, `interval ticks while running (${after})`);
  assert(ticks === after, 'stop() stops the interval');

  let timedOut = 0;
  const k2 = new Keepalive({ intervalMs: 10000, timeoutMs: 30, onInterval: () => {}, onTimeout: () => timedOut++ });
  k2.pingSent();
  await delay(60);
  assert(timedOut === 1, 'no PONG within timeout fires onTimeout');

  let timedOut3 = 0;
  const k3 = new Keepalive({ intervalMs: 10000, timeoutMs: 30, onInterval: () => {}, onTimeout: () => timedOut3++ });
  k3.pingSent();
  k3.pongReceived();
  await delay(60);
  assert(timedOut3 === 0 && k3.lastPongReceived, 'PONG before timeout prevents teardown');

  const k4 = new Keepalive({ onInterval: () => {}, onTimeout: () => {} });
  assert(k4.intervalMs === 30000 && k4.timeoutMs === 10000, 'defaults are 30s interval / 10s timeout');
}

// ── 5. GMPLink over MemoryConnection ──────────────────

function recordingNonceStore(claimResult = { valid: true }) {
  return {
    claims: [],
    updates: [],
    claimSessionKey(peer, fp) { this.claims.push({ peer: hex(peer), fp }); return claimResult; },
    updateCounters(peer, key, send, recv) { this.updates.push({ send, recv }); },
  };
}

function makeLinkPair(idA, idB, extra = {}) {
  const [clientConn, serverConn] = MemoryConnection.createPair(1111, 2222);
  const initiator = new GMPLink({
    identity: idA, socket: clientConn, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(),
    nonceStore: extra.initiatorStore || null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null,
  });
  const responder = new GMPLink({
    identity: idB, socket: serverConn, isInitiator: false, ephemeralKeyPair: generateEphemeralKeyPair(),
    nonceStore: extra.responderStore || null,
    pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null,
  });
  const errors = { initiator: [], responder: [] };
  initiator.on('error', (e) => errors.initiator.push(e.message));
  responder.on('error', (e) => errors.responder.push(e.message));
  return { initiator, responder, clientConn, serverConn, errors };
}

/** A lone responder link and a raw connection to throw bytes at it. */
function makeResponder(identity, { lru = null, ephemeralKeyPair = generateEphemeralKeyPair() } = {}) {
  const [clientConn, serverConn] = MemoryConnection.createPair(3333, 4444);
  const responder = new GMPLink({
    identity, socket: serverConn, isInitiator: false, ephemeralKeyPair,
    sessionKeyLRUSet: lru, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null,
  });
  const errors = [];
  let closed = false;
  responder.on('error', (e) => errors.push(e.message));
  responder.on('close', () => { closed = true; });
  const received = [];
  clientConn.on('data', (d) => received.push(d));
  return { responder, clientConn, errors, received, isClosed: () => closed };
}

async function testLinkHandshake() {
  console.log('\n=== Test 5: GMPLink handshake + NonceStore call semantics ===');

  const a = await deriveIdentityFromSeedPhrase('link modules test link a');
  const b = await deriveIdentityFromSeedPhrase('link modules test link b');
  const initiatorStore = recordingNonceStore();
  const responderStore = recordingNonceStore();
  const { initiator, responder, errors } = makeLinkPair(a, b, { initiatorStore, responderStore });

  let respConnected = false, initConnected = false;
  responder.on('connected', () => { respConnected = true; });
  initiator.on('connected', () => { initConnected = true; });
  await initiator._sendHELLO();
  await delay(50);

  assert(initConnected && respConnected, 'both sides reach connected');
  assert(initiator.state === 'connected' && responder.state === 'connected', 'state is connected on both sides');
  assert(hex(initiator.remoteNodeId) === hex(b.nodeId) && hex(responder.remoteNodeId) === hex(a.nodeId), 'each side learned the other\'s NodeID');

  assert(initiatorStore.claims.length === 1, 'initiator claims its session key once, at the handshake');
  assert(initiatorStore.claims[0].fp === fingerprintKey(initiator.sendKey), 'initiator claims fingerprint(sendKey)');
  assert(initiatorStore.claims[0].peer === hex(b.nodeId), 'claim is scoped to the peer NodeID');
  // A responder holds its session in memory until the first
  // non-relay frame, then claims in the persisted store before dispatching it.
  assert(responderStore.claims.length === 0 && responderStore.updates.length === 0, 'responder: nothing reaches its persisted store during the handshake');

  const got = [];
  let claimsAtDispatch = null;
  responder.on('message', (m) => { if (claimsAtDispatch === null) claimsAtDispatch = responderStore.claims.length; got.push(m); });
  await initiator.send('one');
  await initiator.send(Buffer.from('two'));
  await delay(30);
  assert(got[0] === 'one' && got[1] === 'two', 'DATA (string and Buffer) delivered in order');
  assert(responderStore.claims.length === 1 && claimsAtDispatch === 1, 'responder claims exactly once, before the first DATA is dispatched');
  assert(responderStore.claims[0].fp === fingerprintKey(responder.sendKey), 'responder claims fingerprint(sendKey)');

  // Every counter update follows one seal/open, so counters step by one.
  const monotone = (ups) => ups.every((u, i) => i === 0 ||
    (u.send + u.recv) - (ups[i - 1].send + ups[i - 1].recv) === 1);
  assert(monotone(initiatorStore.updates), `initiator counter updates step by one (${initiatorStore.updates.length} updates)`);
  assert(monotone(responderStore.updates), `responder counter updates step by one (${responderStore.updates.length} updates)`);
  const lastI = initiatorStore.updates.at(-1), lastR = responderStore.updates.at(-1);
  assert(lastI.send === initiator.sendNonceCounter && lastR.recv === responder.recvNonceCounter, 'last persisted counters match the live counters');
  assert(initiator.sendNonceCounter === responder.recvNonceCounter, 'send/recv counters agree across the link');
  assert(errors.initiator.length === 0 && errors.responder.length === 0, 'no errors on an honest handshake');

  initiator.destroy();
  await delay(20);
  assert(responder.state === 'closed', 'destroying one side closes the other');
}

async function testSessionKeyReuseRefused() {
  console.log('\n=== Test 6: session key reuse refused ===');

  const a = await deriveIdentityFromSeedPhrase('link modules test reuse a');
  const b = await deriveIdentityFromSeedPhrase('link modules test reuse b');
  const responderStore = recordingNonceStore({ valid: false, reason: 'already claimed' });
  const { initiator, responder, errors } = makeLinkPair(a, b, { responderStore });
  const delivered = [];
  responder.on('message', (m) => delivered.push(m));
  await initiator._sendHELLO();
  await delay(50);
  // The responder's claim is made on the first non-relay frame.
  await initiator.send('refused session');
  await delay(30);
  assert(delivered.length === 0, 'responder refuses a session key the NonceStore reports as claimed, before dispatching anything');
  assert(errors.responder.includes('Session key reuse detected: already claimed'), 'refusal names the reason');
  assert(responder.state === 'closed', 'refused link is closed');

  // The in-process LRU: a second responder with the same ephemeral key that
  // sees the same HELLO derives the same session key, and must refuse it.
  const lru = new SessionKeyLRUSet();
  const responderEph = generateEphemeralKeyPair();
  const [c1, s1] = MemoryConnection.createPair(7001, 7002);
  const captured = [];
  s1.on('data', (d) => captured.push(d));
  const init = new GMPLink({ identity: a, socket: c1, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(), node: null });
  init.on('error', () => {});
  await init._sendHELLO();
  await delay(20);
  const helloBytes = Buffer.concat(captured);

  const first = makeResponder(b, { lru, ephemeralKeyPair: responderEph });
  first.clientConn.write(helloBytes);
  await delay(30);
  assert(first.responder.state === 'confirming' && lru.has(fingerprintKey(first.responder.sendKey)),
    'first responder accepts the key and records its fingerprint');

  const second = makeResponder(b, { lru, ephemeralKeyPair: responderEph });
  second.clientConn.write(helloBytes);
  await delay(30);
  assert(second.errors.includes('Session key reuse detected - possible attack or crypto bug') && second.isClosed(),
    'second derivation of the same session key is refused by the LRU');
  init.destroy();
}

async function testMalformedInput() {
  console.log('\n=== Test 7: malformed and hostile input ===');

  const target = await deriveIdentityFromSeedPhrase('link modules test target');
  const attacker = await deriveIdentityFromSeedPhrase('link modules test attacker');

  // Oversized declared length
  {
    const r = makeResponder(target);
    const big = Buffer.alloc(5);
    big.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 0);
    big[4] = MESSAGETYPES.DATA;
    r.clientConn.write(big);
    await delay(20);
    assert(r.errors.includes('Message too large') && r.isClosed(), 'oversized frame: error and close');
  }

  // Unknown message type
  {
    const r = makeResponder(target);
    r.clientConn.write(encodeFrame(0x7f, Buffer.alloc(3)));
    await delay(20);
    assert(r.errors.includes('Unknown message type: 127') && r.isClosed(), 'unknown type: error and close');
  }

  // Truncated HELLO
  {
    const r = makeResponder(target);
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, Buffer.alloc(100)));
    await delay(20);
    assert(r.errors.some((e) => e.startsWith('Invalid HELLO payload length: 100')), 'short HELLO: rejected by length');
  }

  const eph = generateEphemeralKeyPair();

  // Wrong version (checked before the signature, so it is what reports)
  {
    const r = makeResponder(target);
    const hello = buildHello(attacker, eph.ephemeralPub, Date.now(), crypto.randomBytes(32));
    hello[0] = 0x02;
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.includes('Unsupported protocol version: 2'), 'unknown protocol version rejected');
  }

  // Forged signature
  {
    const r = makeResponder(target);
    const hello = buildHello(attacker, eph.ephemeralPub, Date.now(), crypto.randomBytes(32));
    hello[HELLO_PAYLOAD_LEN - 1] ^= 0xff;
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.includes('HELLO signature verification failed'), 'bad signature rejected');
    assert(r.responder.remoteNodeId === null, 'no peer identity recorded from a forged HELLO');
  }

  // NodeID that belongs to someone else, validly signed by the attacker
  {
    const r = makeResponder(target);
    const bystander = await deriveIdentityFromSeedPhrase('link modules test bystander');
    const forged = { ...attacker, nodeId: bystander.nodeId };
    const hello = buildHello(forged, eph.ephemeralPub, Date.now(), crypto.randomBytes(32));
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.some((e) => e.startsWith('HELLO NodeID does not match')), 'NodeID not bound to the presented keys rejected');
  }

  // Stale timestamp (window is 120s without a node)
  {
    const r = makeResponder(target);
    const hello = buildHello(attacker, eph.ephemeralPub, Date.now() - 200000, crypto.randomBytes(32));
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.includes('HELLO timestamp out of range'), 'stale timestamp rejected');
  }

  // Low-order ephemeral key with an otherwise valid, signed HELLO
  {
    const r = makeResponder(target);
    const hello = buildHello(attacker, new Uint8Array(32), Date.now(), crypto.randomBytes(32));
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.includes('HELLO key agreement failed') && r.isClosed(), 'low-order key: rejected without crashing');
  }

  // A replayed, genuine HELLO: the responder answers but never goes live,
  // because the replayer cannot produce the key-confirmation PING.
  {
    const victim = await deriveIdentityFromSeedPhrase('link modules test victim');
    const [c, s] = MemoryConnection.createPair(5555, 6666);
    const captured = [];
    s.on('data', (d) => captured.push(d));
    const real = new GMPLink({ identity: victim, socket: c, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(), node: null });
    real.on('error', () => {});
    await real._sendHELLO();
    await delay(20);
    const helloBytes = Buffer.concat(captured);

    const r = makeResponder(target);
    let connected = false;
    r.responder.on('connected', () => { connected = true; });
    r.clientConn.write(helloBytes);
    await delay(50);
    assert(r.responder.state === 'confirming' && !connected, 'replayed HELLO stalls in confirming, never connected');
    // Anything but a valid PING — here, a garbage PING — tears it down.
    r.clientConn.write(encodeFrame(MESSAGETYPES.PING, crypto.randomBytes(16)));
    await delay(20);
    assert(r.errors.includes('PING decryption failed') && !connected, 'forged key-confirmation PING rejected');
    real.destroy();
  }

  // Reflected HELLO: our own identity coming back at us.
  {
    const r = makeResponder(target);
    const hello = buildHello(target, eph.ephemeralPub, Date.now(), crypto.randomBytes(32));
    r.clientConn.write(encodeFrame(MESSAGETYPES.HELLO, hello));
    await delay(20);
    assert(r.errors.includes('HELLO NodeID is our own (reflected or self-connection)') && r.isClosed(),
      'reflected HELLO (our own NodeID) rejected');
    assert(r.responder.sendKey === null, 'no session keys derived for a reflected HELLO');
  }

  // HELLO_ACK claiming our own NodeID, on an initiator link.
  {
    const [c, s2] = MemoryConnection.createPair(8001, 8002);
    const init = new GMPLink({ identity: target, socket: c, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(), node: null });
    const errs = [];
    init.on('error', (e) => errs.push(e.message));
    await init._sendHELLO();
    const ack = buildHelloAck(target, eph.ephemeralPub, Date.now(), crypto.randomBytes(48));
    s2.write(encodeFrame(MESSAGETYPES.HELLO_ACK, ack));
    await delay(20);
    assert(errs.includes('HELLO_ACK NodeID is our own (reflected or self-connection)'), 'reflected HELLO_ACK (our own NodeID) rejected');
  }

  // Encrypted frames before the handshake are ignored, not decrypted.
  {
    const r = makeResponder(target);
    r.clientConn.write(encodeFrame(MESSAGETYPES.DATA, crypto.randomBytes(40)));
    await delay(20);
    assert(r.errors.length === 0 && r.responder.state === 'handshaking', 'DATA before handshake is dropped');
  }

  // Plain HTTP health check
  {
    const r = makeResponder(target);
    r.clientConn.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await delay(20);
    const body = Buffer.concat(r.received).toString();
    assert(body.startsWith('HTTP/1.1 200 OK') && body.endsWith('{"status":"healthy"}'), 'HTTP GET gets the health-check response');
  }
}

async function testSelfDial() {
  console.log('\n=== Test 8: a node dialling itself ===');

  const network = new MemoryNetwork();
  const node = createGMPNode({ port: 0, transport: new MemoryTransport(network) });
  await node.loadIdentity('link modules test self dial');
  await node.listen();
  node.on('error', () => {});
  let connections = 0;
  node.on('connection', () => { connections++; });

  let err = null;
  try { await node.dial('memory', node.port); } catch (e) { err = e; }
  await delay(50);
  assert(err !== null, 'dialling our own listener fails');
  assert(connections === 0, 'no connection event for a self-connection');

  // Not penalised: a genuine peer from the same (memory) address still gets in.
  const peer = createGMPNode({ port: 0, transport: new MemoryTransport(network) });
  await peer.loadIdentity('link modules test self dial peer');
  let ok = null;
  try { ok = await peer.dial('memory', node.port); } catch (e) { ok = e; }
  await delay(50);
  assert(ok && !(ok instanceof Error) && connections === 1, 'a real peer from the same address still connects afterwards');

  peer.close();
  node.close();
}

// ── 9. architecture ───────────────────────────────────

function testLayering() {
  console.log('\n=== Test 9: architecture — link/ imports only downward ===');

  // What link/ may import: Node built-ins it genuinely uses, its own
  // siblings, L0 primitives, and the logger. Anything else — net/tls, the
  // config singleton, a node/mesh/discovery module — is a layering break.
  const allowed = new Set([
    'events', 'crypto',
    './frame.js', './session.js', './handshake.js', './keepalive.js', './ephemeral-nonce-state.js',
    './ephemeral-source.js',
    '../identity.js', '../logger.js',
  ]);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'link');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert(files.length === 7, `dist/link has the seven modules (${files.join(', ')})`);
  let specsSeen = 0;
  const badByFile = [];
  for (const f of files) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => m[1] || m[2]);
    specsSeen += specs.length;
    badByFile.push([f, specs.filter((spec) => !allowed.has(spec.replace(/^node:/, '')))]);
  }
  for (const [f, bad] of badByFile) {
    assertAbsent({ channel: 'import specifier scan', control: () => specsSeen > 10 && specsSeen, controlMessage: 'the scan extracted real specifiers', absent: () => bad.length === 0, message: `link/${f} imports only allowed modules${bad.length ? ' — found ' + bad.join(', ') : ''}` });
  }

}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S2 — Link Module Tests                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    testFrame();
    await testSession();
    await testHandshake();
    await testKeepalive();
    await testLinkHandshake();
    await testSessionKeyReuseRefused();
    await testMalformedInput();
    await testSelfDial();
    testLayering();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
