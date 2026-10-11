/**
 * Multi-instance isolation: three nodes in one process over MemoryTransport,
 * each with its own identity, config, port and data directory. A talks to B
 * and C; B only to A.
 *
 * 1. identity and key material differ, nothing shared by reference
 * 2. configs are independent
 * 3. every state file lives in its own node's dataDir
 * 4. A and B communicate
 * 5. C is in A's peer table and peer cache only
 * 6. claim counts follow each node's own sessions, in separate claim logs
 * 7. a node rebuilt from its dataDir gets back exactly its own state
 *
 * Run: node test/multi-instance-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-multi-instance-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

const SEEDS = {
  A: 'multi instance test node alpha seed',
  B: 'multi instance test node bravo seed',
  C: 'multi instance test node charlie seed',
};
const network = new MemoryNetwork();

function makeNode(name, overrides) {
  return createGMPNode({
    config: { ...DEFAULTS, ...overrides },
    dataDir: path.join(root, name),
    seedPhrase: SEEDS[name],
    port: 0,
    transport: new MemoryTransport(network),
  });
}

const inDir = (file, name) => path.resolve(file).startsWith(path.join(root, name) + path.sep);
const cachedIds = (node) => new Set(node.peerCache.cache.map((p) => p.nodeId));

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S3 — Multi-Instance Isolation Test              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const A = makeNode('A', { GMP_MIN_PEERS: 2, GMP_TOPOLOGY_TTL: 8 });
  const B = makeNode('B', { GMP_MIN_PEERS: 5, GMP_TOPOLOGY_TTL: 12 });
  const C = makeNode('C', {});
  const idA = await A.loadIdentity(SEEDS.A);
  const idB = await B.loadIdentity(SEEDS.B);
  const idC = await C.loadIdentity(SEEDS.C);
  await A.listen(); await B.listen(); await C.listen();

  console.log('\n=== 1. identity and keys ===');
  assert(hex(idA.nodeId) !== hex(idB.nodeId), 'NodeIDs differ');
  assert(hex(idA.staticPrivKey) !== hex(idB.staticPrivKey), 'static private keys differ');
  assert(hex(idA.signingPrivKey) !== hex(idB.signingPrivKey), 'signing private keys differ');
  assert(A.identity !== B.identity && A.identity.staticPrivKey !== B.identity.staticPrivKey, 'no key material shared by reference');
  assert(!A.nonceStore.encryptionKey.equals(B.nonceStore.encryptionKey), 'at-rest nonce-store keys differ');
  assert(A.port !== B.port, `ports differ (${A.port} / ${B.port})`);

  console.log('\n=== 2. configuration ===');
  assert(A.config !== B.config, 'config objects are distinct');
  assert(A.config.GMP_MIN_PEERS === 2 && B.config.GMP_MIN_PEERS === 5, 'each node keeps its own GMP_MIN_PEERS');
  assert(A.topologyManager.ttl === 8 && B.topologyManager.ttl === 12, 'each node\'s subsystems use its own values');
  let mutated = false;
  try { A.config.GMP_MIN_PEERS = 99; mutated = A.config.GMP_MIN_PEERS === 99; } catch { /* frozen */ }
  assert(!mutated && B.config.GMP_MIN_PEERS === 5, 'config is read-only; one node cannot change another\'s');

  console.log('\n=== 3. state lives in each node\'s own dataDir ===');
  for (const [name, node] of [['A', A], ['B', B], ['C', C]]) {
    assert(inDir(node.nonceStore.claimsFile, name) && inDir(node.peerCache.filePath, name),
      `${name}: claim log and peer cache under ${name}/`);
  }
  assert(A.nonceStore !== B.nonceStore && A.peerCache !== B.peerCache && A.routingTable !== B.routingTable,
    'no store or table instance is shared');

  console.log('\n=== 4. A and B communicate ===');
  const received = { A: [], B: [] };
  A.on('message', ({ msg }) => received.A.push(String(msg)));
  B.on('message', ({ msg }) => received.B.push(String(msg)));
  const ab = await A.dial('memory', B.port);
  await delay(100);
  const ba = [...B.connections.values()][0];
  await ab.link.send('hello B, from A');
  await ba.send('hello A, from B');
  await delay(100);
  assert(received.B.includes('hello B, from A'), 'B received A\'s message');
  assert(received.A.includes('hello A, from B'), 'A received B\'s message');

  // A also connects to C; B never does.
  await A.dial('memory', C.port);
  await delay(150);

  console.log('\n=== 5. peer state ===');
  const peersOf = (node) => new Set([...node.connections.values()].map((l) => hex(l.remoteNodeId)));
  assert(peersOf(A).has(hex(idB.nodeId)) && peersOf(A).has(hex(idC.nodeId)), 'A is connected to B and C');
  assert(peersOf(B).size === 1 && peersOf(B).has(hex(idA.nodeId)), 'B is connected only to A');
  assert(cachedIds(A).has(hex(idC.nodeId)), 'C is in A\'s peer cache');
  assert(!cachedIds(B).has(hex(idC.nodeId)), 'C is not in B\'s peer cache');

  console.log('\n=== 6. nonce / replay state ===');
  const claimsA = A.nonceStore.claimCount;
  const claimsB = B.nonceStore.claimCount;
  assert(claimsA === 2, `A claimed one session key per session (A–B, A–C): ${claimsA}`);
  assert(claimsB === 1, `B claimed only its own session (A–B): ${claimsB}`);
  assert(A.nonceStore.claimsFile !== B.nonceStore.claimsFile, 'claim logs are separate files');

  console.log('\n=== 7. restart from each node\'s own dataDir ===');
  A.close();
  await delay(50);
  const A2 = makeNode('A', { GMP_MIN_PEERS: 2 });
  await A2.loadIdentity(SEEDS.A);
  assert(cachedIds(A2).has(hex(idB.nodeId)) && cachedIds(A2).has(hex(idC.nodeId)), 'restarted A recovers its own peer cache (B and C)');
  assert(A2.nonceStore.claimCount === claimsA, `restarted A recovers its own ${claimsA} claims`);
  assert(B.nonceStore.claimCount === claimsB && !cachedIds(B).has(hex(idC.nodeId)), 'B is unaffected by A\'s restart');

  const globalDir = process.env.GMP_DATA_DIR;
  const leaked = fs.readdirSync(globalDir).filter((f) => /nonce|peer-cache/.test(f));
  assertAbsent({
    channel: 'state filenames in a data dir',
    control: () => fs.readdirSync(B.dataDir).filter((f) => /nonce|peer-cache/.test(f)),
    controlMessage: 'the pattern matches the state files B wrote in its own dataDir',
    absent: () => leaked.length === 0,
    message: `nothing was written to the process-wide GMP_DATA_DIR${leaked.length ? ' — found ' + leaked.join(', ') : ''}`,
  });

  A2.close(); B.close(); C.close();

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\nTest suite error:', err);
  process.exit(1);
});
