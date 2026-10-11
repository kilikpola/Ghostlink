/**
 * Event Contract Test: src/events.ts checked at runtime.
 *
 * 1. Every emitted event name is in the contract, and every contract event
 *    has an emit site
 * 2. Events from real flows are validated against the contract; each must be
 *    observed (external-address excepted: it needs a public peer)
 * 3. no-route carries hex from both emit sites
 * 4. binding-response is validated (isBindingResponse)
 *
 * Run: node test/event-contract-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { GMPLink } from '../dist/link.js';
import { createGMPNode } from '../dist/node-factory.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import { encodeFrame } from '../dist/link/frame.js';
import { isBindingResponse } from '../dist/public-peer-list.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-events-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let dirs = 0;
const dataDir = () => path.join(tmp, `n${dirs++}`);

// ── 1. census ─────────────────────────────────────────

/** Event names per interface in events.ts, parsed from the source. */
function contractFromSource() {
  const src = fs.readFileSync(path.join(SRC, 'events.ts'), 'utf8');
  const maps = {};
  for (const m of src.matchAll(/export interface (\w+Events) \{([\s\S]*?)\n\}/g)) {
    maps[m[1]] = new Set([...m[2].matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*\[/gm)].map((x) => x[1]));
  }
  return maps;
}

function emitSites() {
  const names = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js)$/.test(e.name) || e.name === 'events.ts') continue;
      const rel = path.relative(SRC, full);
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/\.emit\(\s*'([a-z-]+)'/g)) {
        if (!names.has(m[1])) names.set(m[1], new Set());
        names.get(m[1]).add(rel);
      }
    }
  };
  walk(SRC);
  return names;
}

function testCensus() {
  console.log('\n=== Test 1: census — contract vs emit sites ===');
  const maps = contractFromSource();
  const contract = new Set(Object.values(maps).flatMap((s) => [...s]));
  const sites = emitSites();

  // Byte-stream plumbing, not GMP events: transport connections (typed by
  // GMPConnection in transport/transport.ts), the injected VirtualSocket
  // stream, and the bridge's ws/net 'connection' hand-off.
  const plumbing = new Set(['data']);
  const plumbingFiles = new Set(['transport/tcp-transport.ts', 'transport/memory-transport.ts', 'gmp-bridge.ts']);

  const unknown = [...sites.entries()]
    .filter(([name, files]) => !contract.has(name) && !plumbing.has(name) && ![...files].every((f) => plumbingFiles.has(f)))
    .map(([name, files]) => `${name} (${[...files].join(', ')})`);
  assert(unknown.length === 0, `every emitted event is in the contract${unknown.length ? ' — missing: ' + unknown.join('; ') : ''}`);

  const phantom = [...contract].filter((name) => !sites.has(name));
  assert(phantom.length === 0, `every contract event has an emit site${phantom.length ? ' — none for: ' + phantom.join(', ') : ''}`);
  console.log(`    (${Object.keys(maps).length} event maps, ${contract.size} distinct event names, ${sites.size} emitted names)`);
  return maps;
}

// ── validators ─────────────────────────────────────────

const isHex = (s, len) => typeof s === 'string' && /^[0-9a-f]*$/.test(s) && (!len || s.length === len);
const isBuf = (b, len) => Buffer.isBuffer(b) && (!len || b.length === len);
const isInt = (n) => Number.isInteger(n);
const isDiagnosis = (d) => d && typeof d.reason === 'string' && isInt(d.peersConnected);

const NODE = {
  connection: ([i]) => typeof i.connId === 'string' && i.link instanceof GMPLink && isBuf(i.peerNodeId, 64) && ['incoming', 'outgoing'].includes(i.type),
  message: ([i]) => typeof i.connId === 'string' && typeof i.msg === 'string',
  close: ([i]) => typeof i.connId === 'string',
  error: ([i]) => typeof i.connId === 'string' && i.err instanceof Error,
  'clock-skew-detected': ([i]) => isInt(i.delta) && i.link instanceof GMPLink && isBuf(i.remoteNodeId, 64),
  'rate-limited': ([i]) => (i.type === 'forward' && (i.sourceNodeId === null || i.sourceNodeId instanceof Uint8Array))
    || (['binding', 'standard'].includes(i.type) && (typeof i.ip === 'string' || i.ip === undefined)),
  'no-route': ([i]) => isHex(i.finalDestinationNodeId, 64),
  'ttl-expired': ([i]) => isHex(i.finalDestinationNodeId, 64) && isInt(i.hopCount),
  forwarded: ([i]) => isHex(i.sourceNodeId, 64) && isHex(i.finalDestinationNodeId, 64) && isInt(i.hopCount),
  'routing-degraded': ([i]) => isInt(i.droppedInLast5M) && isInt(i.totalForwarded),
  'bootstrap-complete': (a) => a.length === 1 && isInt(a[0]),
  'bootstrap-failed': (a) => a.length === 2 && isInt(a[0]) && isDiagnosis(a[1]),
  'key-rotated': ([i]) => isHex(i.oldNodeId, 128) && isHex(i.newNodeId, 128),
};

const LINK = {
  connected: ([i]) => isBuf(i.peerNodeId, 64),
  classified: ([i]) => i.role === 'peer' || i.role === 'hop',
  message: ([t]) => typeof t === 'string',
  'binding-response': (a) => a.length === 1,
  'clock-skew-detected': ([i]) => isInt(i.delta) && isBuf(i.remoteNodeId, 64),
  error: ([e]) => e instanceof Error,
  close: (a) => a.length === 0,
};

const MANAGER = {
  'external-address': ([i]) => typeof i.address === 'string' && isInt(i.port),
  'peer-connected': ([i]) => isHex(i.nodeId, 128) && (typeof i.address === 'string' || i.address === null) && (isInt(i.port) || i.port === null),
  'peer-disconnected': ([i]) => isHex(i.nodeId, 128),
  message: ([i]) => isHex(i.fromNodeId, 128) && typeof i.payload === 'string',
  'bootstrap-complete': ([i]) => isInt(i.peersConnected),
  'bootstrap-failed': ([i]) => isInt(i.peersConnected) && (i.diagnosis === null || isDiagnosis(i.diagnosis)),
  'routing-degraded': ([i]) => isInt(i.droppedInLast5M) && isInt(i.totalForwarded),
};

/** Record every emit on an emitter; validate against `spec` at the end. */
function recorder(label, spec) {
  const seen = [];
  return {
    label,
    spec,
    seen,
    attach(emitter) {
      const original = emitter.emit.bind(emitter);
      emitter.emit = (name, ...args) => {
        seen.push([name, args]);
        return original(name, ...args);
      };
      return emitter;
    },
  };
}

function checkRecorder(rec, { exempt = [] } = {}) {
  const bad = rec.seen.filter(([name, args]) => !rec.spec[name] || !rec.spec[name](args));
  assert(bad.length === 0, `${rec.label}: all ${rec.seen.length} payloads match the contract${bad.length ? ' — bad: ' + bad.map(([n, a]) => `${n} ${JSON.stringify(a, (k, v) => (k === 'link' ? '[link]' : v)).slice(0, 120)}`).join('; ') : ''}`);
  const names = new Set(rec.seen.map(([n]) => n));
  const missing = Object.keys(rec.spec).filter((n) => !names.has(n) && !exempt.includes(n));
  assert(missing.length === 0, `${rec.label}: every contract event observed (${names.size})${missing.length ? ' — not seen: ' + missing.join(', ') : ''}`);
}

// ── 2. node and link flows ────────────────────────────

async function testNodeAndLinkEvents() {
  console.log('\n=== Test 2: GMPNode / GMPLink payloads from real flows ===');
  const nodeRec = recorder('GMPNode', NODE);
  const linkRec = recorder('GMPLink', LINK);
  const network = new MemoryNetwork();

  // Links emit 'connected' and 'clock-skew-detected' during the handshake,
  // before the node announces them, so record at the prototype.
  const linkEmit = GMPLink.prototype.emit;
  GMPLink.prototype.emit = function (name, ...args) {
    linkRec.seen.push([name, args]);
    return linkEmit.call(this, name, ...args);
  };

  const mk = (seed, cfg = {}, opts = {}) => {
    const node = createGMPNode({
      config: { ...DEFAULTS, GMP_TIMESTAMP_WINDOW_MS: 600000, ...cfg },
      dataDir: dataDir(), port: 0, transport: new MemoryTransport(network), ...opts,
    });
    nodeRec.attach(node);
    node.on('error', () => {});
    return node;
  };
  const A = mk('a'); const B = mk('b'); const C = mk('c');
  await A.loadIdentity('event contract node a');
  await B.loadIdentity('event contract node b');
  await C.loadIdentity('event contract node c');
  await A.listen(); await B.listen(); await C.listen();

  // connection / connected / message, both directions
  const ab = await A.dial('memory', B.port);
  await B.dial('memory', C.port);
  await delay(100);
  const ba = [...B.connections.values()].find((l) => l.remoteNodeId && Buffer.from(l.remoteNodeId).equals(Buffer.from(A.identity.nodeId)));
  await ab.link.send('hello');
  await ba.send('hello back');

  // binding-response
  const binding = new Promise((r) => ab.link.once('binding-response', r));
  ab.link.sendBindingRequest();
  const info = await Promise.race([binding, delay(500)]);
  assert(isBindingResponse(info), `a genuine binding-response validates (${JSON.stringify(info)})`);
  assert(!isBindingResponse({ address: 'x', port: 70000 }) && !isBindingResponse('10.0.0.1:1') && !isBindingResponse({ address: '', port: 1 }),
    'malformed binding responses are rejected, not cast');

  // forwarded / ttl-expired / no-route (forwarder) through B
  const routed = (dest, hops) => {
    const p = Buffer.alloc(66 + 1);
    p[0] = 0x01;
    Buffer.from(A.identity.nodeId).copy(p, 1, 0, 32);
    Buffer.from(dest).copy(p, 33, 0, 32);
    p[65] = hops;
    return p;
  };
  B.routingTable.addRoute(C.identity.nodeIdHex, C.identity.nodeIdHex, 1);
  B.forwarder.processIncoming(routed(C.identity.nodeId, 5), ba);
  B.forwarder.processIncoming(routed(C.identity.nodeId, 1), ba);
  B.forwarder.processIncoming(routed(Buffer.alloc(32, 0xee), 5), ba);

  // no-route from VirtualSocket
  try { await A.dialVirtual('ab'.repeat(64)); } catch { /* expected */ }
  const noRoutes = nodeRec.seen.filter(([n]) => n === 'no-route');
  assert(noRoutes.length >= 2 && noRoutes.every(([, [i]]) => isHex(i.finalDestinationNodeId, 64)),
    `no-route carries 64-char hex from both emit sites (${noRoutes.length} seen)`);

  // routing-degraded: the no-routes above feed the health monitor
  A.healthMonitor.runHealthCheck();

  // clock-skew-detected: D's clock runs 6 minutes fast; the 10-minute window accepts it
  const D = mk('d');
  await D.loadIdentity('event contract node d skewed');
  D.now = () => Date.now() + 6 * 60 * 1000;
  await D.dial('memory', A.port);
  await delay(100);

  // key-rotated: A rotates, B (a neighbour) verifies and emits
  const successor = await deriveIdentityFromSeedPhrase('event contract node a successor');
  A.rotateKey(successor);
  await delay(200);

  // bootstrap-complete: B has peers >= minPeers 1
  B.bootstrap.minPeers = 1;
  B.bootstrap.disableBootstrap = false;
  await B.bootstrap.start();

  // bootstrap-failed: E has no peers, tiny stage timeouts, an empty public list
  const peersFile = path.join(tmp, 'no-public-peers.json');
  fs.writeFileSync(peersFile, '[]');
  const E = mk('e', { GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 50, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 50 }, { disableBootstrap: false, publicPeersPath: peersFile });
  await E.loadIdentity('event contract node e');
  await E.bootstrap.start();

  // error: a malformed frame on a raw connection to C
  const raw = await network.connect(C.port);
  raw.write(encodeFrame(0x7f, Buffer.alloc(4)));
  await delay(50);

  // rate-limited (forward): B allows no forwards at all
  B.forwardRateLimitMax = 0;
  B.forwarder.processIncoming(routed(C.identity.nodeId, 5), ba);

  // rate-limited (binding): a public peer allowing two connections per address
  const P = mk('p', {}, { isPublicPeer: true });
  await P.loadIdentity('event contract public peer');
  await P.listen();
  for (let i = 0; i < 3; i++) { try { await network.connect(P.port); } catch { /* refused */ } }
  await delay(50);

  // close
  C.close();
  await delay(100);

  checkRecorder(nodeRec);
  checkRecorder(linkRec);
  const limited = nodeRec.seen.filter(([n]) => n === 'rate-limited').map(([, [i]]) => i.type);
  assert(limited.includes('forward') && limited.includes('binding'), `both rate-limited shapes observed (${[...new Set(limited)].join(', ')})`);

  for (const n of [A, B, D, E, P]) n.close();
  GMPLink.prototype.emit = linkEmit;
}

// ── 3. manager flows ──────────────────────────────────

async function testManagerEvents() {
  console.log('\n=== Test 3: GMPNodeManager payloads from real flows ===');
  const rec = recorder('GMPNodeManager', MANAGER);
  const network = new MemoryNetwork();
  const metricsPort = 46000 + Math.floor(Math.random() * 1000);
  const mk = (seed, extra = {}) => rec.attach(new GMPNodeManager({
    seedPhrase: seed, dataDir: dataDir(), GMP_PORT: 0, GMP_METRICS_PORT: metricsPort,
    transport: new MemoryTransport(network), ...extra,
  }));
  const m1 = mk('event contract manager one', { GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 50, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 50, GMP_MIN_PEERS: 1 });
  const m2 = mk('event contract manager two');
  await m1.start();
  await m2.start();

  await m2.node.dial('memory', m1.node.port);
  await delay(100);
  await m2.sendDirect(m1.getNodeId(), 'hi manager');
  await delay(100);

  m1.node.bootstrap.disableBootstrap = false;
  await m1.node.bootstrap.start();          // 1 peer >= minPeers 1: complete
  m1.node.bootstrap.minPeers = 5;
  await m1.node.bootstrap.start();          // 1 peer < 5, no public peers: failed

  try { await m1.node.dialVirtual('cd'.repeat(64)); } catch { /* no route */ }
  m1.node.healthMonitor.runHealthCheck();   // routing-degraded

  await m2.stop();
  await delay(100);
  await m1.stop();

  checkRecorder(rec, { exempt: ['external-address'] });
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S4 — Event Contract Test                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testCensus();
    await testNodeAndLinkEvents();
    await testManagerEvents();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
