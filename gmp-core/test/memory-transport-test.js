/**
 * Memory Transport Test
 *
 * 1. Two GMP nodes complete a handshake over MemoryTransport (no real network)
 * 2. Encrypted DATA flows both directions over it
 * 3. Dialing a port with no listener rejects (ECONNREFUSED semantics)
 * 4. Listening twice on one port rejects (EADDRINUSE semantics)
 * 5. A link destroyed on one side closes on the other
 * 6. Architecture guard: the built link.js must not import Node net/tls
 *
 * Run: node test/memory-transport-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGMPNode } from '../dist/node-factory.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

const TEST_SEED_A = 'memory transport test seed phrase node a';
const TEST_SEED_B = 'memory transport test seed phrase node b';

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

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testTwoNodesOverMemory() {
  console.log('\n=== Test 1: Handshake and DATA over MemoryTransport ===');

  const network = new MemoryNetwork();
  const nodeA = createGMPNode({ port: 0, transport: new MemoryTransport(network) });
  const nodeB = createGMPNode({ port: 0, transport: new MemoryTransport(network) });

  const identityA = await nodeA.loadIdentity(TEST_SEED_A);
  const identityB = await nodeB.loadIdentity(TEST_SEED_B);

  await nodeA.listen();
  assert(nodeA.port !== 0, `Node A bound an ephemeral memory port (${nodeA.port})`);

  let connectedA = null;
  nodeA.on('connection', (evt) => { connectedA = evt; });

  const result = await nodeB.dial('memory', nodeA.port);
  await delay(200);

  assert(connectedA !== null, 'Node A received incoming connection');
  assertEqual(connectedA?.type, 'incoming', 'Node A side is incoming');
  assertEqual(
    Buffer.from(connectedA.peerNodeId).toString('hex'),
    Buffer.from(identityB.nodeId).toString('hex'),
    'Node A sees Node B\'s correct NodeID'
  );
  assertEqual(
    Buffer.from(result.peerNodeId).toString('hex'),
    Buffer.from(identityA.nodeId).toString('hex'),
    'Node B sees Node A\'s correct NodeID'
  );

  let receivedByA = null;
  let receivedByB = null;
  connectedA.link.on('message', (msg) => { receivedByA = msg; });
  result.link.on('message', (msg) => { receivedByB = msg; });

  await result.link.send('hello over memory from B');
  await delay(200);
  assert(receivedByA === 'hello over memory from B', 'Node A received B\'s message');

  await connectedA.link.send('reply over memory from A');
  await delay(200);
  assert(receivedByB === 'reply over memory from A', 'Node B received A\'s reply');

  return { nodeA, nodeB, linkA: connectedA.link, linkB: result.link };
}

function testLinkClosePropagation(linkA, linkB) {
  console.log('\n=== Test 2: Close Propagation ===');
  return new Promise((resolve) => {
    const closedB = new Promise((res) => linkB.on('close', res));
    linkA.destroy();
    closedB.then(() => {
      assert(true, 'Destroying link A closed link B');
      resolve();
    });
    setTimeout(() => {
      assert(false, 'Destroying link A closed link B');
      resolve();
    }, 2000);
  });
}

async function testDialRefused() {
  console.log('\n=== Test 3: Dial With No Listener Rejects ===');

  const node = createGMPNode({ port: 0, transport: new MemoryTransport(new MemoryNetwork()) });
  await node.loadIdentity('memory dial refused seed');

  let error = null;
  try {
    await node.dial('memory', 1);
  } catch (e) {
    error = e;
  }
  assert(error !== null, 'Dial with no listener rejected');
  assertEqual(error?.code, 'ECONNREFUSED', 'Rejection carries ECONNREFUSED');

  node.close();
}

async function testAddressInUse() {
  console.log('\n=== Test 4: Double Listen Rejects (EADDRINUSE) ===');

  const network = new MemoryNetwork();
  const nodeA = createGMPNode({ port: 40001, transport: new MemoryTransport(network) });
  const nodeB = createGMPNode({ port: 40001, transport: new MemoryTransport(network) });
  await nodeA.loadIdentity('memory eaddrinuse seed a');
  await nodeB.loadIdentity('memory eaddrinuse seed b');

  await nodeA.listen();

  let error = null;
  try {
    await nodeB.listen();
  } catch (e) {
    error = e;
  }
  assert(error !== null, 'Second listen on the same port rejected');
  assertEqual(error?.code, 'EADDRINUSE', 'Rejection carries EADDRINUSE');

  nodeA.close();
  nodeB.close();
}

function testNoNetImports() {
  console.log('\n=== Test 5: Architecture Guard — link.js Has No net/tls Imports ===');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = readFileSync(path.join(here, '..', 'dist', 'link.js'), 'utf8');
  const importsNet = /from\s+['"](?:node:)?net['"]|require\(\s*['"](?:node:)?net['"]\s*\)/.test(built);
  const importsTls = /from\s+['"](?:node:)?tls['"]|require\(\s*['"](?:node:)?tls['"]\s*\)/.test(built);

  const tcp = readFileSync(path.join(here, '..', 'dist', 'transport', 'tcp-transport.js'), 'utf8');
  const netRe = /from\s+['"](?:node:)?net['"]|require\(\s*['"](?:node:)?net['"]\s*\)/;
  const tlsRe = /from\s+['"](?:node:)?tls['"]|require\(\s*['"](?:node:)?tls['"]\s*\)/;
  assertAbsent({ channel: 'net import pattern', control: () => netRe.test(tcp), controlMessage: 'it matches tcp-transport.js, which imports net', absent: () => !importsNet, message: 'dist/link.js does not import net' });
  assertAbsent({ channel: 'tls import pattern', control: () => tlsRe.test(tcp), controlMessage: 'it matches tcp-transport.js, which imports tls', absent: () => !importsTls, message: 'dist/link.js does not import tls' });
  assert(built.includes('tcp-transport'), 'dist/link.js goes through the transport abstraction');
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S1 — Memory Transport Test                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  let nodeA, nodeB;
  try {
    const { linkA, linkB } = await testTwoNodesOverMemory().then(r => {
      nodeA = r.nodeA;
      nodeB = r.nodeB;
      return r;
    });
    await testLinkClosePropagation(linkA, linkB);
    await testDialRefused();
    await testAddressInUse();
    testNoNetImports();
  } catch (err) {
    console.error('\nTest suite error:', err);
    console.error(err.stack);
    testsFailed++;
  } finally {
    if (nodeA) nodeA.close();
    if (nodeB) nodeB.close();
  }

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
