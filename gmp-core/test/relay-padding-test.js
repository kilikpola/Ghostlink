/**
 * Relayed record padding
 *
 *  1. INTERACTIVE (default): every sealed record the relay sees is exactly
 *     256, 1024 or 4096 bytes plus the 16-byte tag, whatever the message size
 *  2. messages of different lengths inside one bucket produce identical
 *     record-size sequences at the relay
 *  3. BULK: every record is 16 KiB plus tag, the final one padded
 *  4. the class is agreed at circuit set-up and both ends know it
 *  5. padding is inside the AEAD: the callee's key opens a record to exactly
 *     the bucket size; the relay's keys open nothing
 *
 * Run: node test/relay-padding-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { decodeRelayData } from '../dist/relay/relay-protocol.js';
import { openFirstRecordForTest } from '../dist/relay/circuit-crypto.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-padding-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
const TAG = 16;
const HELLO = 32;

async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({ config: { ...DEFAULTS, ...cfg }, dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new MemoryTransport(network) });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}

/** Relay + callee + dialler; returns the relayed link pair and the relay's view of the dialler's circuit. */
async function circuit(trafficClass) {
  const network = new MemoryNetwork();
  const R = await makeNode(network, `padding relay ${n}`, { GMP_RELAY_ENABLED: true });
  await R.listen();
  const seen = [];
  const handle = R.relayServer.handleFrame.bind(R.relayServer);
  R.relayServer.handleFrame = (link, type, plaintext) => { if (type === 0x0F) seen.push(Buffer.from(plaintext)); return handle(link, type, plaintext); };
  const A = await makeNode(network, `padding dialler ${n}`);
  const B = await makeNode(network, `padding callee ${n}`);
  const addr = { address: 'memory', port: R.port };
  const res = await B.reserveRelay(addr);
  const incoming = new Promise((r) => B.on('connection', (e) => e.link.socket.isRelayed && r(e)));
  const out = await A.dialRelayed(addr, res.voucherId, B.identity.staticPubKey, trafficClass ? { trafficClass } : undefined);
  const inc = await incoming;
  await delay(50);
  return { R, A, B, out, inc, seen };
}

/** Sizes of every sealed record the relay forwarded, both directions; the 32-byte circuit hello excluded. */
function recordSizes(seen) {
  return seen.map((p) => decodeRelayData(p)).filter(Boolean).map((f) => f.data.length).filter((l) => l !== HELLO);
}

async function testInteractive() {
  console.log('\n=== 1-2. INTERACTIVE ===');
  const c = await circuit();
  assert(c.out.link.socket.trafficClass === 'interactive' && c.inc.link.socket.trafficClass === 'interactive',
    'default class is interactive on both ends');
  for (const len of [1, 10, 100, 250, 900, 3000, 10000, 40000]) await c.out.link.send('m'.repeat(len));
  await delay(150);
  const allowed = new Set([256 + TAG, 1024 + TAG, 4096 + TAG]);
  const sizes = recordSizes(c.seen);
  const bad = sizes.filter((s) => !allowed.has(s));
  assert(sizes.length > 0 && bad.length === 0, `every record is a bucket: ${[...new Set(sizes)].sort((a, b) => a - b).join(', ')}${bad.length ? ' — off-bucket: ' + [...new Set(bad)].join(', ') : ''}`);

  const before = c.seen.length;
  for (let i = 0; i < 5; i++) await c.out.link.send('a'.repeat(5));
  await delay(80);
  const small = c.seen.slice(before).map((p) => decodeRelayData(p).data.length);
  const mid = c.seen.length;
  for (let i = 0; i < 5; i++) await c.out.link.send('b'.repeat(150));
  await delay(80);
  const larger = c.seen.slice(mid).map((p) => decodeRelayData(p).data.length);
  assert(small.length > 0 && JSON.stringify(small) === JSON.stringify(larger),
    `5-byte and 150-byte messages look identical to the relay (${JSON.stringify(small)})`);

  const control = openFirstRecordForTest(c.seen, [c.B.identity.staticPrivKey]);
  assert(control !== null && control.length === 256, `the callee's key opens a record to exactly the bucket (${control && control.length} bytes)`);
  assert(openFirstRecordForTest(c.seen, [c.R.identity.staticPrivKey]) === null, 'the relay\'s key opens nothing');
}

async function testBulk() {
  console.log('\n=== 3-4. BULK ===');
  const c = await circuit('bulk');
  assert(c.out.link.socket.trafficClass === 'bulk' && c.inc.link.socket.trafficClass === 'bulk', 'bulk agreed on both ends');
  for (const len of [3, 5000, 100000]) await c.out.link.send('z'.repeat(len));
  await c.inc.link.send('reply');
  await delay(150);
  const sizes = recordSizes(c.seen);
  assert(sizes.length > 0 && sizes.every((s) => s === 16384 + TAG), `every record is 16 KiB (${[...new Set(sizes)].join(', ')})`);
  const got = [];
  c.inc.link.on('message', (m) => got.push(m.length));
  await c.out.link.send('q'.repeat(40000));
  await delay(100);
  assert(got.includes(40000), 'bulk records reassemble to the original message');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N1b-2 — Relayed Record Padding Test                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testInteractive();
    await testBulk();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
