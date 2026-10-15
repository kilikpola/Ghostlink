/**
 * Multi-instance bridge: real WebSocket clients against startBridge() with a
 * NodeRegistry (nodes on MemoryTransport):
 *
 * 1. different seeds -> different nodes
 * 2. a second session with the same seed shares the node
 * 3. A reaches B through the bridge (connect + sendDirect)
 * 4. events reach only the sessions of the node they belong to
 * 5. isolation: identity, keys, config, dataDir, claim logs, peer tables
 * 6. host node: no seed or the host's seed -> host node; any other seed -> never
 * 7. maxNodes enforced with a START_FAILED / REGISTRY_FULL reply
 * 8. foreign and null Origin refused
 * 9. close(): port released, created nodes stopped, host node left running
 * 10. an identity whose claim log is in the process-wide data dir keeps that
 *     layout; any other gets nodes/<id>/
 *
 * Run: node test/bridge-multi-instance-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { startBridge } from '../dist/gmp-bridge.js';
import { NodeRegistry } from '../dist/node-registry.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { createGMPNode } from '../dist/node-factory.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-bridge-multi-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SEED_A = 'bridge multi instance browser alpha seed';
const SEED_B = 'bridge multi instance browser bravo seed';
const SEED_HOST = 'bridge multi instance host node seed';
const METRICS_PORT = 45000 + Math.floor(Math.random() * 1000);

/** A WebSocket client that keeps every message it receives. */
class Client {
  constructor(port, headers = {}) {
    this.messages = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
      this.ws.once('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async waitFor(pred, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await delay(20);
    }
    return null;
  }
  async start(seedPhrase) {
    const before = this.messages.length;
    this.send({ type: 'start', ...(seedPhrase ? { seedPhrase } : {}) });
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const hit = this.messages.slice(before).find((m) => m.type === 'started' || m.type === 'error');
      if (hit) return hit;
      await delay(20);
    }
    return null;
  }
  close() { try { this.ws.terminate(); } catch { /* gone */ } }
}

async function testBrowsers() {
  const network = new MemoryNetwork();
  const registry = new NodeRegistry({
    maxNodes: 3,
    dataRoot: path.join(tmp, 'bridge-root'),
    defaultPort: 0,
    managerOptions: { transport: new MemoryTransport(network), GMP_METRICS_PORT: METRICS_PORT },
  });
  const bridge = await startBridge(null, 0, '127.0.0.1', { registry, allowTokenless: true });

  console.log('\n=== 1. different seeds -> different nodes ===');
  const a = new Client(bridge.port); const b = new Client(bridge.port);
  await a.opened; await b.opened;
  const startedA = await a.start(SEED_A);
  const startedB = await b.start(SEED_B);
  assert(startedA?.type === 'started' && startedB?.type === 'started', 'both browsers get a started node');
  assert(startedA.nodeId !== startedB.nodeId, 'Browser A and Browser B run different NodeIDs');
  assertEq(registry.size, 2, 'the registry holds two nodes');

  console.log('\n=== 2. same seed, second session -> same node ===');
  const a2 = new Client(bridge.port);
  await a2.opened;
  const startedA2 = await a2.start(SEED_A);
  assert(startedA2?.nodeId === startedA.nodeId, 'a second session with A\'s seed is bound to A\'s node');
  assertEq(registry.size, 2, 'no extra node was created for it');

  console.log('\n=== 3. A reaches B through the bridge ===');
  a.send({ type: 'connect', address: 'memory', port: startedB.port });
  const conn = await a.waitFor((m) => m.type === 'connect-result');
  assert(conn?.connected === true && conn.nodeId === startedB.nodeId, 'A connected to B\'s node');
  await delay(100);
  a.send({ type: 'sendDirect', destinationNodeId: startedB.nodeId, payload: 'for B only' });

  console.log('\n=== 4. events reach only the bound node\'s sessions ===');
  const got = await b.waitFor((m) => m.type === 'message' && m.payload === 'for B only');
  assert(got?.fromNodeId === startedA.nodeId, 'B\'s session receives the message, from A\'s NodeID');
  await delay(150);
  assert(!a.messages.some((m) => m.type === 'message'), 'A\'s session does not receive B\'s incoming message');
  assert(!a2.messages.some((m) => m.type === 'message'), 'A\'s second session does not receive it either');
  assert(!b.messages.some((m) => m.type === 'peer-connected' && m.nodeId === startedB.nodeId) &&
    a.messages.some((m) => m.type === 'peer-connected' && m.nodeId === startedB.nodeId),
    'peer-connected events are per node (A sees B as a peer; B does not see itself)');

  b.send({ type: 'getStatus' });
  const statusB = await b.waitFor((m) => m.type === 'status');
  // Status lists peers, not the node itself: B's view has A as its peer; A's
  // view would have B.
  const peersB = (statusB?.peers || []).map((p) => p.nodeId);
  assert(peersB.includes(startedA.nodeId) && !peersB.includes(startedB.nodeId), 'B\'s getStatus describes B\'s node (its peer is A)');

  console.log('\n=== 5. isolation between the two nodes ===');
  const mA = await registry.acquire(SEED_A);
  const mB = await registry.acquire(SEED_B);
  const nA = mA.node; const nB = mB.node;
  assert(mA !== mB && nA !== nB, 'separate manager and node objects');
  assert(!Buffer.from(nA.identity.staticPrivKey).equals(Buffer.from(nB.identity.staticPrivKey)) &&
    !Buffer.from(nA.identity.signingPrivKey).equals(Buffer.from(nB.identity.signingPrivKey)), 'separate key material');
  assert(!nA.nonceStore.encryptionKey.equals(nB.nonceStore.encryptionKey), 'separate at-rest keys');
  assert(nA.config !== nB.config, 'separate config objects');
  assert(mA.dataDir && mB.dataDir && mA.dataDir !== mB.dataDir &&
    mA.dataDir.startsWith(path.join(tmp, 'bridge-root', 'nodes')), `separate dataDirs under nodes/ (${path.basename(mA.dataDir)}, ${path.basename(mB.dataDir)})`);
  assert(nA.nonceStore.claimsFile.startsWith(mA.dataDir) && nB.nonceStore.claimsFile.startsWith(mB.dataDir), 'each claim log in its own dataDir');
  assert(nA.nonceStore !== nB.nonceStore && nA.routingTable !== nB.routingTable && nA.peerCache !== nB.peerCache, 'separate stores and tables');

  console.log('\n=== 7. capacity ===');
  const c = new Client(bridge.port); const d = new Client(bridge.port);
  await c.opened; await d.opened;
  const startedC = await c.start('bridge multi instance browser charlie seed');
  const refused = await d.start('bridge multi instance browser delta seed');
  assert(startedC?.type === 'started', 'the third node (maxNodes 3) starts');
  assert(refused?.type === 'error' && refused.code === 'START_FAILED' && refused.reason === 'REGISTRY_FULL', 'a fourth seed is refused with REGISTRY_FULL');
  d.send({ type: 'sendDirect', destinationNodeId: startedA.nodeId, payload: 'x' });
  const unbound = await d.waitFor((m) => m.code === 'NOT_STARTED');
  assert(unbound !== null, 'a refused session is bound to nothing: its commands answer NOT_STARTED');

  console.log('\n=== 8. existing restrictions ===');
  let evil = null;
  try { await new Client(bridge.port, { Origin: 'https://evil.example' }).opened; } catch (e) { evil = e.message; }
  assert(evil === 'HTTP 403', 'a foreign Origin is refused (403)');
  let nul = null;
  try { await new Client(bridge.port, { Origin: 'null' }).opened; } catch (e) { nul = e.message; }
  assert(nul === 'HTTP 403', 'the opaque null Origin is refused (403)');

  console.log('\n=== 9. close() ===');
  for (const cl of [a, a2, b, c, d]) cl.close();
  await bridge.close();
  let refusedAfterClose = false;
  try { await new Client(bridge.port).opened; } catch { refusedAfterClose = true; }
  assert(refusedAfterClose, 'the bridge port is released');
  assert(mA.node === null && mB.node === null, 'created nodes are stopped');
}

function assertEq(actual, expected, message) {
  assert(actual === expected, actual === expected ? message : `${message} (expected ${expected}, got ${actual})`);
}

async function testHostNode() {
  console.log('\n=== 6. the host\'s node ===');
  const network = new MemoryNetwork();
  const transport = new MemoryTransport(network);
  const host = new GMPNodeManager({ seedPhrase: SEED_HOST, dataDir: path.join(tmp, 'host'), GMP_PORT: 0, GMP_METRICS_PORT: METRICS_PORT, transport });
  const registry = new NodeRegistry({
    dataRoot: path.join(tmp, 'host-root'),
    defaultPort: 0,
    managerOptions: { transport, GMP_METRICS_PORT: METRICS_PORT },
  });
  const bridge = await startBridge(host, 0, '127.0.0.1', { registry, allowTokenless: true });
  await host.start();

  const noSeed = new Client(bridge.port);
  await noSeed.opened;
  const greeted = await noSeed.waitFor((m) => m.type === 'started');
  assert(greeted?.nodeId === host.getNodeId(), 'a client that sends nothing is greeted with the host\'s node');
  const noSeedStart = await noSeed.start();
  assert(noSeedStart?.nodeId === host.getNodeId(), 'start without a seed binds the host\'s node');

  const sameSeed = new Client(bridge.port);
  await sameSeed.opened;
  const same = await sameSeed.start(SEED_HOST);
  assert(same?.nodeId === host.getNodeId() && registry.size === 0, 'the host\'s own seed binds the host\'s node, no new node');

  const other = new Client(bridge.port);
  await other.opened;
  const otherStarted = await other.start(SEED_A);
  assert(otherStarted?.type === 'started' && otherStarted.nodeId !== host.getNodeId(),
    'a different seed gets its own node, never the host\'s (it used to be silently ignored)');

  // The other node's traffic stays off the host's sessions.
  other.send({ type: 'connect', address: 'memory', port: host.node.port });
  await other.waitFor((m) => m.type === 'connect-result');
  await delay(100);
  noSeed.send({ type: 'sendDirect', destinationNodeId: otherStarted.nodeId, payload: 'host to other' });
  const arrived = await other.waitFor((m) => m.type === 'message' && m.payload === 'host to other');
  await delay(100);
  assert(arrived !== null, 'the host\'s node reaches the other node');
  assert(!noSeed.messages.some((m) => m.type === 'message') && !sameSeed.messages.some((m) => m.type === 'message'),
    'host sessions do not see the other node\'s incoming message');

  for (const cl of [noSeed, sameSeed, other]) cl.close();
  await bridge.close();
  assert(host.node !== null, 'bridge close() leaves the host\'s node to its host');
  await host.stop();
}

async function testLegacyLayout() {
  console.log('\n=== 10. existing data directory layout ===');
  const LEGACY = 'bridge multi instance legacy seed';
  // A pre-registry node: default paths, i.e. the process-wide GMP_DATA_DIR.
  const old = createGMPNode({ port: 0, transport: new MemoryTransport() });
  await old.loadIdentity(LEGACY);
  const legacyClaims = old.nonceStore.claimsFile;
  old.nonceStore.claimSessionKey(new Uint8Array(64).fill(7), 'f'.repeat(32));
  old.close();
  assert(fs.existsSync(legacyClaims), `legacy claim log exists (${path.basename(legacyClaims)})`);

  const registry = new NodeRegistry({ defaultPort: 0, managerOptions: { transport: new MemoryTransport(), GMP_METRICS_PORT: METRICS_PORT } });
  const mLegacy = await registry.acquire(LEGACY);
  const mOther = await registry.acquire(SEED_B);
  assert(mLegacy.dataDir === null, 'the identity already living in the data dir keeps the pre-registry layout');
  assert(mLegacy.node.nonceStore.claimsFile === legacyClaims && mLegacy.node.nonceStore.claimCount === 1,
    'and keeps its claim log (1 claim carried over, nothing moved)');
  assert(mOther.dataDir && mOther.dataDir.includes(`${path.sep}nodes${path.sep}`), 'another identity gets nodes/<id>/');
  await registry.stopAll();
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S5 — Multi-Instance Bridge Test                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testBrowsers();
    await testHostNode();
    await testLegacyLayout();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
