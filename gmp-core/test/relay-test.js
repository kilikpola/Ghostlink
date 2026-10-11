/**
 * Relay tier: B holds a reservation on relay R; A dials B through R with the
 * voucher. Everything R handles is recorded.
 *
 *  1. reservation: voucher signed by R's Ed25519 key, 30-min default TTL,
 *     auto-renewal at 80% of TTL keeps the same voucher ID
 *  2. relayed chat both ways; each side proves the other's real NodeID
 *  3. 10 MB through the relay, byte-exact
 *  4. R saw no NodeID or key of A or B, no plaintext, no inner session key,
 *     and cannot open a sealed record (B's static key can)
 *  5. dialling with the wrong static key for B gets nowhere
 *  6. quotas, each torn down with a RELAY_STOP reason: bytes, duration,
 *     circuits per reservation, reservations per /24, total reservations;
 *     unknown and expired vouchers; relay switched off
 *  7. metrics: reservations active, relayed bytes, rejections by reason
 *
 * Run: node test/relay-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { verifyVoucher, RELAY_STOP_REASONS } from '../dist/relay/relay-protocol.js';
import { openFirstRecordForTest } from '../dist/relay/circuit-crypto.js';
import metrics from '../dist/metrics.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-relay-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];

function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, ...cfg },
    dataDir: path.join(tmp, `node${n++}`),
    port: 0,
    transport: new MemoryTransport(network),
  });
  node.on('error', () => {});
  nodes.push(node);
  return node.loadIdentity(seed).then(() => node);
}

async function makeRelay(network, quotas = {}) {
  const relay = await makeNode(network, `relay test relay ${n}`, { GMP_RELAY_ENABLED: true, ...quotas });
  await relay.listen();
  const seen = [];
  const original = relay.relayServer.handleFrame.bind(relay.relayServer);
  relay.relayServer.handleFrame = (link, type, plaintext) => {
    seen.push(Buffer.from(plaintext));
    return original(link, type, plaintext);
  };
  return { relay, seen, addr: { address: 'memory', port: relay.port } };
}

/** Resolve with the inner link once B accepts a relayed connection. */
function nextIncoming(node) {
  return new Promise((resolve) => {
    const onConn = (evt) => {
      if (evt.type === 'incoming' && evt.link.socket && evt.link.socket.isRelayed) {
        node.off('connection', onConn);
        resolve(evt);
      }
    };
    node.on('connection', onConn);
  });
}

async function expectRejection(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

const contains = (haystacks, needle) => haystacks.some((h) => h.includes(Buffer.from(needle)));

// ── 1-5 ─────────────────────────────────────────────

async function testRelayedSession() {
  const network = new MemoryNetwork();
  const { relay, seen, addr } = await makeRelay(network);
  const A = await makeNode(network, 'relay test alice');
  const B = await makeNode(network, 'relay test bob');

  console.log('\n=== 1. reservation ===');
  const res = await B.reserveRelay(addr);
  assert(typeof res.voucherId === 'string' && res.voucherId.length === 32, `voucher issued (${res.voucherId})`);
  assert(verifyVoucher(res.voucher, relay.identity.signingPubKey), 'voucher signature verifies under the relay\'s Ed25519 key');
  const ttl = res.voucher.expiresAt - Date.now();
  assert(ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000, `default TTL is 30 minutes (${Math.round(ttl / 1000)}s)`);
  const tampered = { ...res.voucher, expiresAt: res.voucher.expiresAt + 1 };
  assert(!verifyVoucher(tampered, relay.identity.signingPubKey), 'a tampered voucher does not verify');

  console.log('\n=== 2. relayed chat ===');
  const incoming = nextIncoming(B);
  const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
  const inc = await incoming;
  assert(Buffer.from(out.peerNodeId).equals(Buffer.from(B.identity.nodeId)), 'A proved it is talking to B');
  assert(Buffer.from(inc.peerNodeId).equals(Buffer.from(A.identity.nodeId)), 'B proved it is talking to A');
  assert(out.link.socket.isRelayed === true, 'the connection is marked relayed');
  const toB = []; const toA = [];
  inc.link.on('message', (m) => toB.push(m));
  out.link.on('message', (m) => toA.push(m));
  await out.link.send('hello over relay');
  await inc.link.send('hello back over relay');
  await delay(100);
  assert(toB.includes('hello over relay') && toA.includes('hello back over relay'), 'chat flows both ways');

  console.log('\n=== 3. 10 MB ===');
  const chunk = 256 * 1024;
  const total = 10 * 1024 * 1024;
  const sent = crypto.createHash('sha256');
  const got = crypto.createHash('sha256');
  let received = 0;
  const done = new Promise((resolve) => {
    inc.link.on('message', (m) => {
      if (m.startsWith('bulk:')) {
        got.update(m);
        received += m.length;
        if (received >= total) resolve();
      }
    });
  });
  const t0 = Date.now();
  for (let off = 0; off < total; off += chunk) {
    const body = 'bulk:' + crypto.randomBytes((chunk - 5) / 2).toString('hex') + 'x';
    sent.update(body);
    await out.link.send(body);
  }
  await Promise.race([done, delay(60000)]);
  assert(received >= total && sent.digest('hex') === got.digest('hex'), `10 MB arrived intact (${(received / 1048576).toFixed(1)} MiB in ${Date.now() - t0} ms)`);
  assert(out.link.state === 'connected' && inc.link.state === 'connected', 'the relayed link survives it');

  console.log('\n=== 4. what the relay saw ===');
  assert(seen.length > 0, `relay handled ${seen.length} relay-layer frames`);
  for (const [who, id] of [['A', A.identity], ['B', B.identity]]) {
    assert(!contains(seen, id.nodeId) && !contains(seen, id.staticPubKey) && !contains(seen, id.signingPubKey),
      `no NodeID, static or signing key of ${who} in anything the relay handled`);
  }
  assert(!contains(seen, 'hello over relay') && !contains(seen, 'bulk:'), 'no chat plaintext');
  assert(!contains(seen, out.link.sendKey) && !contains(seen, inc.link.sendKey), 'no inner session key');
  // Hops are infrastructure links (relay.links), never peers (relay.connections).
  const hopIds = [...relay.links.values()].filter((l) => l.remoteNodeId).map((l) => Buffer.from(l.remoteNodeId).toString('hex'));
  assert(!hopIds.includes(A.identity.nodeIdHex) && !hopIds.includes(B.identity.nodeIdHex) && hopIds.length >= 2,
    `relay's hop links carry throwaway identities, never A's or B's (${hopIds.length} links)`);
  const probe = openFirstRecordForTest(seen, [relay.identity.staticPrivKey]);
  assert(probe === null, 'the relay cannot open a sealed circuit record with any key it holds');
  const control = openFirstRecordForTest(seen, [B.identity.staticPrivKey]);
  assert(control !== null, 'positive control: B\'s static key does open it');

  console.log('\n=== 5. wrong key for B ===');
  const impostorKey = (await makeNode(network, 'relay test not bob')).identity.staticPubKey;
  const wrong = await expectRejection(A.dialRelayed(addr, res.voucherId, impostorKey));
  assert(wrong !== null, `a dial sealed to the wrong key fails (${wrong && wrong.message})`);

  console.log('\n=== 7. metrics ===');
  const stats = relay.relayServer.getStats();
  assert(stats.reservationsActive === 1, `reservations active: ${stats.reservationsActive}`);
  assert(stats.bytesRelayed >= total, `relayed bytes: ${stats.bytesRelayed}`);
  metrics.registerNode(relay);
  const json = metrics.getMetricsJSON();
  assert(json.relay && json.relay.reservationsActive === 1 && json.relay.bytesRelayed >= total && typeof json.relay.rejections === 'object',
    '/metrics carries a relay section');

  out.link.destroy();
  await delay(100);
  assert(relay.relayServer.getStats().circuitsActive === 0, 'closing the link frees the circuit on the relay');
}

// ── 6. quotas ─────────────────────────────────────────

async function testQuotas() {
  console.log('\n=== 6. quotas ===');

  {
    const network = new MemoryNetwork();
    const { relay, addr } = await makeRelay(network, { GMP_RELAY_MAX_CIRCUIT_BYTES: 1024 * 1024 });
    const A = await makeNode(network, 'quota bytes alice');
    const B = await makeNode(network, 'quota bytes bob');
    const res = await B.reserveRelay(addr);
    const incoming = nextIncoming(B);
    const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
    const inc = await incoming;
    const closedA = new Promise((r) => out.link.on('close', r));
    const closedB = new Promise((r) => inc.link.on('close', r));
    const stopReasons = [];
    out.link.socket.on('relay-stop', (reason) => stopReasons.push(reason));
    for (let i = 0; i < 40 && out.link.state === 'connected'; i++) {
      try { await out.link.send('y'.repeat(64 * 1024)); } catch { break; }
      await delay(5);
    }
    const bothClosed = await Promise.race([Promise.all([closedA, closedB]).then(() => true), delay(3000).then(() => false)]);
    assert(bothClosed, 'byte quota: both ends of the relayed link close');
    assert(stopReasons.includes('bytes-exceeded'), `byte quota: RELAY_STOP reason bytes-exceeded (${stopReasons})`);
    assert(relay.relayServer.getStats().rejections['bytes-exceeded'] === 1, 'byte quota: counted by reason');
    assert(A.links.size === 0 || [...A.links.values()].every((l) => !l.socket.isRelayed), 'byte quota: no relayed link left behind on A');
  }

  {
    const network = new MemoryNetwork();
    const { relay, addr } = await makeRelay(network, { GMP_RELAY_MAX_CIRCUIT_DURATION_MS: 300 });
    const A = await makeNode(network, 'quota time alice');
    const B = await makeNode(network, 'quota time bob');
    const res = await B.reserveRelay(addr);
    const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
    const reasons = [];
    out.link.socket.on('relay-stop', (r) => reasons.push(r));
    await delay(600);
    assert(out.link.state === 'closed' && reasons.includes('duration-exceeded'), `duration quota: stopped with duration-exceeded (${reasons})`);
    assert(relay.relayServer.getStats().rejections['duration-exceeded'] === 1, 'duration quota: counted');
  }

  {
    const network = new MemoryNetwork();
    const { addr } = await makeRelay(network, { GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION: 1 });
    const A = await makeNode(network, 'quota circuits alice');
    const C = await makeNode(network, 'quota circuits carol');
    const B = await makeNode(network, 'quota circuits bob');
    const res = await B.reserveRelay(addr);
    await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
    const err = await expectRejection(C.dialRelayed(addr, res.voucherId, B.identity.staticPubKey));
    assert(err && err.reason === 'circuit-limit', `circuit quota: second dial refused with circuit-limit (${err && err.reason})`);
  }

  {
    const network = new MemoryNetwork();
    const { relay, addr } = await makeRelay(network, { GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET: 1 });
    const B = await makeNode(network, 'quota subnet bob');
    const D = await makeNode(network, 'quota subnet dave');
    await B.reserveRelay(addr);
    const err = await expectRejection(D.reserveRelay(addr));
    assert(err && err.reason === 'subnet-limit', `subnet quota: second reservation from the same /24 refused (${err && err.reason})`);
    assert(relay.relayServer.getStats().rejections['subnet-limit'] === 1, 'subnet quota: counted');
  }

  {
    const network = new MemoryNetwork();
    const { addr } = await makeRelay(network, { GMP_RELAY_MAX_RESERVATIONS: 1 });
    const B = await makeNode(network, 'quota total bob');
    const D = await makeNode(network, 'quota total dave');
    await B.reserveRelay(addr);
    const err = await expectRejection(D.reserveRelay(addr));
    assert(err && err.reason === 'reservation-limit', `total quota: refused with reservation-limit (${err && err.reason})`);
  }

  {
    const network = new MemoryNetwork();
    const { addr } = await makeRelay(network, { GMP_RELAY_RESERVATION_TTL_MS: 200 });
    const A = await makeNode(network, 'expiry alice');
    const B = await makeNode(network, 'expiry bob');
    const res = await B.reserveRelay(addr, { autoRenew: false });
    await delay(350);
    const err = await expectRejection(A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey));
    assert(err && err.reason === 'reservation-expired', `an expired voucher is refused (${err && err.reason})`);
    const unknown = await expectRejection(A.dialRelayed(addr, 'ab'.repeat(16), B.identity.staticPubKey));
    assert(unknown && unknown.reason === 'no-reservation', `an unknown voucher is refused (${unknown && unknown.reason})`);
  }

  {
    const network = new MemoryNetwork();
    const { addr } = await makeRelay(network, { GMP_RELAY_RESERVATION_TTL_MS: 500 });
    const A = await makeNode(network, 'renew alice');
    const B = await makeNode(network, 'renew bob');
    const res = await B.reserveRelay(addr);
    const firstExpiry = res.voucher.expiresAt;
    await delay(700);
    const current = B.relayReservation(addr);
    assert(current && current.voucherId === res.voucherId && current.voucher.expiresAt > firstExpiry,
      'auto-renewal at 80% of TTL extends the same voucher');
    const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey);
    assert(out && out.link.state === 'connected', 'a renewed voucher still dials after its first expiry');
  }

  {
    const network = new MemoryNetwork();
    const plain = await makeNode(network, 'relay disabled node');
    await plain.listen();
    const B = await makeNode(network, 'relay disabled bob');
    const err = await expectRejection(B.reserveRelay({ address: 'memory', port: plain.port }));
    assert(err && err.reason === 'relay-disabled', `a node without the relay enabled refuses (${err && err.reason})`);
  }

  assert(Array.isArray(RELAY_STOP_REASONS) && RELAY_STOP_REASONS.includes('bytes-exceeded'), 'reason codes are exported');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N1 — Relay Tier Test                                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testRelayedSession();
    await testQuotas();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
