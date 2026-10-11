/**
 * Relay role separation
 *
 *  1. public-peers.json `roles`: absent -> ["bootstrap"]; only "bootstrap" and
 *     "relay" are valid; an entry with no valid role is dropped
 *  2. bootstrap dials only "bootstrap" hosts
 *  3. never RELAY_RESERVE on a host used with the real identity this session,
 *     by address or by NodeID (RESERVE_ON_BOOTSTRAP_HOST)
 *  4. never connect with the real identity to a host holding our live
 *     reservation (BOOTSTRAP_VIA_RELAY_HOST)
 *  5. a relay of a different, known operator is "separated"; same or unknown
 *     operator is "unseparated", reported to the manager, bridge and UI
 *  6. selectRelay prefers separated relays and never picks a used host
 *
 * Run: node test/relay-roles-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGMPNode } from '../dist/node-factory.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { loadPublicPeers } from '../dist/public-peer-list.js';
import { selectRelay, RoleSeparationError } from '../dist/relay/role-separation.js';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-roles-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];

async function makeNode(network, seed, cfg = {}, opts = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 50, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 300, ...cfg },
    dataDir: path.join(tmp, `n${n++}`),
    port: 0,
    transport: new MemoryTransport(network),
    ...opts,
  });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}

async function relayNode(network, seed) {
  const r = await makeNode(network, seed, { GMP_RELAY_ENABLED: true });
  await r.listen();
  return r;
}

function peersFile(entries) {
  const f = path.join(tmp, `peers-${n++}.json`);
  fs.writeFileSync(f, JSON.stringify(entries));
  return f;
}

async function rejection(p) {
  try { await p; return null; } catch (e) { return e; }
}

async function testSchema() {
  console.log('\n=== 1. roles in public-peers.json ===');
  const f = peersFile([
    { address: 'a.example', port: 1, nodeId: 'aa', addedAt: 0, lastVerified: 0 },
    { address: 'b.example', port: 2, nodeId: 'bb', addedAt: 0, lastVerified: 0, roles: ['relay'], operator: 'op-b' },
    { address: 'c.example', port: 3, nodeId: 'cc', addedAt: 0, lastVerified: 0, roles: ['bootstrap', 'relay'] },
    { address: 'd.example', port: 4, nodeId: 'dd', addedAt: 0, lastVerified: 0, roles: ['bogus'] },
    { address: 'e.example', port: 5, nodeId: 'ee', addedAt: 0, lastVerified: 0, roles: 'relay' },
  ]);
  const peers = loadPublicPeers(f);
  const by = Object.fromEntries(peers.map((p) => [p.address, p]));
  assert(JSON.stringify(by['a.example']?.roles) === '["bootstrap"]', 'absent roles means ["bootstrap"] (the shipped entry keeps working)');
  assert(JSON.stringify(by['b.example']?.roles) === '["relay"]' && by['b.example'].operator === 'op-b', 'relay-only entry keeps its role and operator');
  assert(JSON.stringify(by['c.example']?.roles) === '["bootstrap","relay"]', 'both roles allowed');
  assert(!by['d.example'] && !by['e.example'], 'entries with no valid role array are dropped');
  const shipped = loadPublicPeers(path.join(here, '..', 'data', 'public-peers.json'));
  assert(shipped.length >= 1 && shipped.every((p) => p.roles.includes('bootstrap')), 'the shipped list still loads as bootstrap hosts');
}

async function testBootstrapUsesBootstrapRole() {
  console.log('\n=== 2. bootstrap dials only bootstrap hosts ===');
  const network = new MemoryNetwork();
  const R = await relayNode(network, 'roles relay only host');
  const f = peersFile([{ address: 'memory', port: R.port, nodeId: R.identity.nodeIdHex, addedAt: 0, lastVerified: 0, roles: ['relay'] }]);
  const E = await makeNode(network, 'roles bootstrapping node', { GMP_MIN_PEERS: 1 }, { disableBootstrap: false, publicPeersPath: f });
  const dialled = [];
  const dial = E.dial.bind(E);
  E.dial = (address, port, o) => { dialled.push(port); return dial(address, port, o); };
  await E.bootstrap.start();
  assert(!dialled.includes(R.port) && E.connections.size === 0, 'a relay-only host is never dialled for bootstrap');
}

async function testHardRules() {
  const network = new MemoryNetwork();
  const H = await relayNode(network, 'roles host used for bootstrap');
  const R = await relayNode(network, 'roles relay host');
  const N = await makeNode(network, 'roles client node');

  console.log('\n=== 3. never reserve on a host used with the real identity ===');
  await N.dial('memory', H.port);
  const e1 = await rejection(N.reserveRelay({ address: 'memory', port: H.port }));
  assert(e1 instanceof RoleSeparationError && e1.code === 'RESERVE_ON_BOOTSTRAP_HOST', `refused by address (${e1 && e1.code})`);
  const e2 = await rejection(N.reserveRelay({ address: 'memory-alias', port: H.port }));
  assert(e2 instanceof RoleSeparationError && e2.code === 'RESERVE_ON_BOOTSTRAP_HOST', `refused by NodeID behind another address (${e2 && e2.code})`);
  assert(H.relayServer.getStats().reservationsActive === 0, 'the refused host holds no reservation');

  console.log('\n=== 4. never connect with the real identity to a reserved host ===');
  await N.reserveRelay({ address: 'memory', port: R.port });
  const e3 = await rejection(N.dial('memory', R.port));
  assert(e3 instanceof RoleSeparationError && e3.code === 'BOOTSTRAP_VIA_RELAY_HOST', `dial() refused by address (${e3 && e3.code})`);
  const e4 = await rejection(N.dial('memory-alias', R.port));
  assert(e4 instanceof RoleSeparationError && e4.code === 'BOOTSTRAP_VIA_RELAY_HOST', `dial() refused by NodeID behind another address (${e4 && e4.code})`);
  assert(![...R.connections.values()].some((l) => Buffer.from(l.remoteNodeId).equals(Buffer.from(N.identity.nodeId))),
    'no link carrying N\'s real NodeID is kept at the relay');
  // Honest limit: the alias case is caught only after the handshake, so R did
  // see N's HELLO. That exposure is not hidden: the reservation is demoted.
  assert(N.relayReservation({ address: 'memory', port: R.port }).separation === 'unseparated',
    'after the post-handshake catch, the reservation on R is demoted to unseparated (R saw the HELLO)');

  const f = peersFile([{ address: 'memory', port: R.port, nodeId: R.identity.nodeIdHex, addedAt: 0, lastVerified: 0 }]);
  N.bootstrap.publicPeersPath = f;
  N.bootstrap.minPeers = 5;
  N.bootstrap.disableBootstrap = false;
  await N.bootstrap.start();
  assert(![...R.connections.values()].some((l) => Buffer.from(l.remoteNodeId).equals(Buffer.from(N.identity.nodeId))),
    'bootstrap does not dial a host holding the live reservation');
}

/**
 * The rules apply by listed NodeID before the dial, so a listed host under
 * another hostname is refused before any byte is sent. The single-host,
 * two-role list here deliberately models an invalid configuration.
 */
async function testListedAliasBeforeDial() {
  console.log('\n=== 4b. a listed host under another hostname: refused before the dial ===');
  const network = new MemoryNetwork();
  const R = await relayNode(network, 'roles listed relay host');
  let accepted = 0;
  const accept = R._acceptConnection.bind(R);
  R._acceptConnection = (c) => { accepted++; return accept(c); };
  const id = R.identity.nodeIdHex;
  const f = peersFile([
    { address: 'relay-a.example', port: R.port, nodeId: id, addedAt: 0, lastVerified: 0, roles: ['relay'] },
    { address: 'relay-b.example', port: R.port, nodeId: id, addedAt: 0, lastVerified: 0, roles: ['bootstrap'] },
  ]);
  const N = await makeNode(network, 'roles alias client', {}, { publicPeersPath: f });
  await N.reserveRelay({ address: 'relay-a.example', port: R.port, nodeId: id });
  const hopOnly = accepted;

  const e1 = await rejection(N.dial('relay-b.example', R.port));
  assert(e1 instanceof RoleSeparationError && e1.code === 'BOOTSTRAP_VIA_RELAY_HOST' && accepted === hopOnly,
    `dial() to the other listed hostname refused before connecting (${e1 && e1.code}; connections at the host: ${accepted - hopOnly} new)`);
  const e2 = await rejection(N.dial('some-alias.example', R.port, { nodeId: id }));
  assert(e2 instanceof RoleSeparationError && accepted === hopOnly, 'a caller that knows the NodeID (cache, LAN, list) is refused before connecting too');
  N.bootstrap.minPeers = 5;
  N.bootstrap.disableBootstrap = false;
  await N.bootstrap.start();
  assert(accepted === hopOnly, `bootstrap does not dial the listed alias of the reservation host (${accepted - hopOnly} new connections)`);
  assert(N.relayReservation({ address: 'relay-a.example', port: R.port }).separation !== undefined
    && !N.exposure.hasSeen(null, id), 'the host never saw the real identity: nothing to demote');

  // Rule 1 the other way round: bootstrapped via one listed name, then asked
  // to reserve on the other.
  const M = await makeNode(network, 'roles alias client two', {}, { publicPeersPath: f });
  await M.dial('relay-b.example', R.port);
  const before = accepted;
  const e3 = await rejection(M.reserveRelay({ address: 'relay-a.example', port: R.port, nodeId: id }));
  assert(e3 instanceof RoleSeparationError && e3.code === 'RESERVE_ON_BOOTSTRAP_HOST' && accepted === before,
    `reserving on the other listed name of a host that saw the identity: refused before connecting (${e3 && e3.code})`);

  // Residual (documented): a host known by no NodeID beforehand — learned
  // through peer exchange, or typed in — is caught only after its handshake.
  const e4 = await rejection(N.dial('unlisted-alias.example', R.port));
  assert(e4 instanceof RoleSeparationError && accepted === before + 1,
    'RESIDUAL: an unlisted alias with no known NodeID is refused only after the handshake (the host saw one HELLO)');
}

async function testSeparationState() {
  console.log('\n=== 5. separation state reaches the manager, the bridge event and the UI ===');
  const network = new MemoryNetwork();
  const H = await relayNode(network, 'sep bootstrap host op a');
  const Rb = await relayNode(network, 'sep relay op b');
  const Ra = await relayNode(network, 'sep relay op a');
  const Ru = await relayNode(network, 'sep relay unknown operator');
  const f = peersFile([{ address: 'memory', port: H.port, nodeId: H.identity.nodeIdHex, addedAt: 0, lastVerified: 0, roles: ['bootstrap'], operator: 'op-a' }]);

  const manager = new GMPNodeManager({
    seedPhrase: 'sep managed callee node', dataDir: path.join(tmp, 'mgr'), GMP_PORT: 0,
    GMP_METRICS_PORT: 45500 + Math.floor(Math.random() * 400), GMP_MIN_PEERS: 1,
    GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 50, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 300,
    transport: new MemoryTransport(network),
  });
  await manager.start();
  const B = manager.node;
  B.bootstrap.publicPeersPath = f;
  B.bootstrap.disableBootstrap = false;
  await B.bootstrap.start();
  assert(B.connections.size === 1, 'callee bootstrapped through op-a\'s host');

  const sep = await B.reserveRelay({ address: 'memory', port: Rb.port, operator: 'op-b' });
  // A named operator's second role is refused, no longer shown unseparated.
  const sameErr = await rejection(B.reserveRelay({ address: 'memory', port: Ra.port, operator: 'op-a' }));
  const unknown = await B.reserveRelay({ address: 'memory', port: Ru.port });
  assert(sep.separation === 'separated', `different known operator: separated (${sep.separation})`);
  assert(sameErr instanceof RoleSeparationError && sameErr.code === 'RESERVE_ON_BOOTSTRAP_HOST' && Ra.relayServer.getStats().reservationsActive === 0,
    `same operator as the bootstrap host: refused before connecting (${sameErr && sameErr.code}) — GM-N2-6`);
  assert(unknown.separation === 'unseparated', `unknown operator: unseparated (${unknown.separation})`);

  const A = await makeNode(network, 'sep dialling node');
  const events = [];
  manager.on('peer-connected', (e) => events.push(e));
  const viaSame = await A.dialRelayed({ address: 'memory', port: Ru.port }, unknown.voucherId, B.identity.staticPubKey);
  await delay(100);
  const A2 = await makeNode(network, 'sep dialling node two');
  await A2.dialRelayed({ address: 'memory', port: Rb.port }, sep.voucherId, B.identity.staticPubKey);
  await delay(100);
  const t = Object.fromEntries(events.map((e) => [e.nodeId, e.transport]));
  assert(t[A.identity.nodeIdHex] === 'relayed-unseparated', `manager peer-connected says relayed-unseparated (${t[A.identity.nodeIdHex]})`);
  assert(t[A2.identity.nodeIdHex] === 'relayed', `and relayed for the separated relay (${t[A2.identity.nodeIdHex]})`);
  assert(t[H.identity.nodeIdHex] === undefined || t[H.identity.nodeIdHex] === 'direct', 'direct links say direct');
  const status = manager.getStatus();
  assert(status.peers.some((p) => p.nodeId === A.identity.nodeIdHex && p.transport === 'relayed-unseparated'), 'getStatus carries it too');
  assert(viaSame.link.socket.separation === 'unseparated', 'the dialler\'s side knows its circuit is unseparated too');

  const ui = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert(/relayed-unseparated/.test(ui) && /not separated/i.test(ui), 'the UI maps relayed-unseparated to its own visible string');
  await manager.stop();
}

function testSelectRelay() {
  console.log('\n=== 6. selectRelay ===');
  const peers = [
    { address: 'boot', port: 1, nodeId: 'b0', roles: ['bootstrap'], operator: 'op-a' },
    { address: 'same-op', port: 2, nodeId: 'r1', roles: ['relay'], operator: 'op-a' },
    { address: 'other-op', port: 3, nodeId: 'r2', roles: ['relay'], operator: 'op-b' },
    { address: 'boot-and-relay', port: 4, nodeId: 'r3', roles: ['bootstrap', 'relay'], operator: 'op-c' },
  ];
  const used = { hosts: new Set(['boot:1', 'b0', 'boot-and-relay:4', 'r3']), operators: new Set(['op-a', 'op-c']), unknownOperatorUsed: false };
  const pick = selectRelay(peers, used);
  assert(pick && pick.entry.address === 'other-op' && pick.separation === 'separated', `prefers a separated relay (${pick && pick.entry.address})`);
  const noOther = selectRelay(peers.filter((p) => p.address !== 'other-op'), used);
  assert(noOther === null, 'never falls back to a relay of an operator that saw the identity (GM-N2-6: refused at operator level)');
  const unnamed = selectRelay([...peers.filter((p) => p.address !== 'other-op'), { address: 'no-op', port: 5, nodeId: 'r4', roles: ['relay'] }], used);
  assert(unnamed && unnamed.entry.address === 'no-op' && unnamed.separation === 'unseparated', 'falls back to a relay of unknown operator, marked unseparated');
  const none = selectRelay(peers.filter((p) => !['other-op', 'same-op'].includes(p.address)), used);
  assert(none === null, 'never picks a host already used with the real identity');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N1b-1 — Relay Role Separation Test                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testSchema();
    await testBootstrapUsesBootstrapRole();
    await testHardRules();
    await testListedAliasBeforeDial();
    await testSeparationState();
    testSelectRelay();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
