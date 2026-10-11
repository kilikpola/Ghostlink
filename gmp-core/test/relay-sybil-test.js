/**
 * Sybil limit vs CGNAT: a per-/24 token bucket (30/min) with a concurrent
 * ceiling of 256.
 *
 *  1. 200 distinct nodes from one source address over 60 s all get reservations
 *  2. 5000 within 1 s from one /24 are rate-limited (subnet-rate-limit)
 *  3. renewals do not spend tokens
 *  4. the concurrent ceiling still applies (subnet-limit)
 *
 * Run: node test/relay-sybil-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { withSource } from './helpers/ephemeral-source.mjs';
import { RelayServer } from '../dist/relay/relay-server.js';
import { generateEphemeralIdentity } from '../dist/identity.js';
import { MESSAGETYPES } from '../dist/link/frame.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-sybil-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A stand-in for a hop link: what RelayServer touches, and the replies it sends. */
class FakeLink extends EventEmitter {
  constructor(ip) {
    super();
    this.state = 'connected';
    this.remoteNodeId = generateEphemeralIdentity().nodeId;
    this.socket = { remoteAddress: ip };
    this.sent = [];
  }
  sendRelay(type, payload) { this.sent.push({ type, msg: JSON.parse(payload.toString()) }); }
}

async function testCgnat() {
  console.log('\n=== 1. simulated CGNAT: 200 nodes, one address, over 60 s ===');
  const network = new MemoryNetwork();
  const R = createGMPNode({ config: { ...DEFAULTS, GMP_RELAY_ENABLED: true }, dataDir: path.join(tmp, 'relay'), port: 0, transport: new MemoryTransport(network) });
  await R.loadIdentity('sybil test relay');
  await R.listen();
  let clock = Date.now();
  R.relayServer.clock = () => clock;

  const transport = new MemoryTransport(network); // every hop arrives from 'memory.local': one source address
  const hops = [];
  const failures = [];
  for (let i = 0; i < 200; i++) {
    clock += 300; // 200 arrivals x 300 ms = 60 s of relay time
    const hop = await RelayHop.open(transport, { address: 'memory', port: R.port }, withSource());
    hops.push(hop);
    try { await hop.reserve(); } catch (e) { failures.push(e.reason); }
  }
  const stats = R.relayServer.getStats();
  assert(failures.length === 0, `all 200 obtained reservations${failures.length ? ' — refused: ' + [...new Set(failures)].join(', ') : ''}`);
  assert(stats.reservationsActive === 200, `relay holds 200 reservations from one address (${stats.reservationsActive})`);
  assert(stats.rejections['subnet-rate-limit'] === 0 && stats.rejections['subnet-limit'] === 0, 'no subnet refusals were counted');

  console.log('\n=== 3. renewals do not spend tokens ===');
  const renewFailures = [];
  for (const hop of hops.slice(0, 100)) {
    const current = [...R.relayServer.reservationsFor(hop.hopIdentity.nodeIdHex)][0];
    try { await hop.reserve(current); } catch (e) { renewFailures.push(e.reason); }
  }
  assert(renewFailures.length === 0, `100 renewals in the same instant all succeed (${renewFailures.length} refused)`);

  for (const hop of hops) hop.close();
  R.close();
}

function testFlood() {
  console.log('\n=== 2. 5000 arrivals within 1 s from one /24 ===');
  let clock = 1_000_000;
  const server = new RelayServer(() => generateEphemeralIdentity(), {});
  server.clock = () => clock;
  const reasons = {};
  let granted = 0;
  for (let i = 0; i < 5000; i++) {
    clock += 0.2; // 5000 x 0.2 ms = 1 s
    const link = new FakeLink(`100.64.0.${i % 250}`); // CGNAT range, one /24
    server.handleFrame(link, MESSAGETYPES.RELAY_RESERVE, Buffer.from('{}'));
    const reply = link.sent[0];
    if (reply.type === MESSAGETYPES.RELAY_RESERVATION) granted++;
    else reasons[reply.msg.reason] = (reasons[reply.msg.reason] || 0) + 1;
  }
  const refused = 5000 - granted;
  assert(granted <= 256 + 1, `burst admitted at most the bucket (${granted} granted)`);
  assert(refused >= 5000 - 257 && reasons['subnet-rate-limit'] === refused, `the rest refused with subnet-rate-limit (${JSON.stringify(reasons)})`);
  assert(server.getStats().rejections['subnet-rate-limit'] === refused, 'counted by reason');

  // Another /24 is untouched by this one's bucket.
  const other = new FakeLink('198.51.100.7');
  server.handleFrame(other, MESSAGETYPES.RELAY_RESERVE, Buffer.from('{}'));
  assert(other.sent[0].type === MESSAGETYPES.RELAY_RESERVATION, 'a different /24 still reserves immediately');
  server.close();
}

function testConcurrentCeiling() {
  console.log('\n=== 4. the concurrent ceiling still applies ===');
  let clock = 5_000_000;
  const server = new RelayServer(() => generateEphemeralIdentity(), { maxReservationsPerSubnet: 3 });
  server.clock = () => clock;
  const replies = [];
  for (let i = 0; i < 4; i++) {
    clock += 60_000; // plenty of tokens
    const link = new FakeLink('203.0.113.9');
    server.handleFrame(link, MESSAGETYPES.RELAY_RESERVE, Buffer.from('{}'));
    replies.push(link.sent[0]);
  }
  assert(replies.slice(0, 3).every((r) => r.type === MESSAGETYPES.RELAY_RESERVATION), 'three reservations fit a ceiling of three');
  assert(replies[3].msg.reason === 'subnet-limit', `the fourth concurrent one is refused with subnet-limit (${replies[3].msg.reason})`);
  server.close();
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N1b-4 — Sybil Limit vs CGNAT Test                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testCgnat();
    testFlood();
    testConcurrentCeiling();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
