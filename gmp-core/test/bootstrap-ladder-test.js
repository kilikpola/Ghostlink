/**
 * Bootstrap ladder: 1 peer cache, 2 LAN, 3 public-peers.json, 4 peer-exchange
 * pool, 5 manual entry.
 *
 *  1. success via each rung, timed; the first success cancels other dials
 *  2. LAN dials only known NodeIDs unless any LAN peer is explicitly allowed
 *  3. public rung: shuffled across runs, at most 3 dials in flight
 *  4. worst case (every host accepts TCP and never answers) reaches step 5 in
 *     under 8 s
 *  5. unreachable public peers are demoted with backoff, never removed, and
 *     still tried when all are demoted
 *
 * Run: node test/bootstrap-ladder-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { loadPublicPeers } from '../dist/public-peer-list.js';
import { TcpTransport } from '../dist/transport/tcp-transport.js';
import { fileURLToPath } from 'url';

let testsPassed = 0;
let testsFailed = 0;
function assert(condition, message) {
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); } else { testsFailed++; console.error(`  ✗ ${message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-ladder-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
const timings = {};

async function makeNode(network, seed, cfg = {}, opts = {}) {
  const node = createGMPNode({ config: { ...DEFAULTS, GMP_MIN_PEERS: 1, ...cfg }, dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new MemoryTransport(network), ...opts });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}

async function peer(network, seed) {
  const p = await makeNode(network, seed);
  await p.listen();
  return p;
}

/** Accepts TCP and never says a word: the slowest way to fail. */
async function blackhole(network) {
  const l = await new MemoryTransport(network).listen({ port: 0 }, () => {});
  return { port: l.port, nodeId: crypto.randomBytes(64).toString('hex') };
}

function peersFile(entries) {
  const f = path.join(tmp, `peers-${n++}.json`);
  fs.writeFileSync(f, JSON.stringify(entries.map((e) => ({ address: 'memory', addedAt: 0, lastVerified: 0, roles: ['bootstrap'], ...e }))));
  return f;
}

/** Run one ladder; resolve with outcome, rung and elapsed ms. */
async function ladder(node) {
  node.bootstrap.disableBootstrap = false;
  const t0 = Date.now();
  const done = new Promise((resolve) => {
    node.bootstrap.once('bootstrap-complete', (c) => resolve({ ok: true, count: c }));
    node.bootstrap.once('bootstrap-failed', (c, d) => resolve({ ok: false, count: c, diagnosis: d }));
  });
  await node.bootstrap.start();
  const r = await done;
  return { ...r, rung: node.bootstrap.lastRun?.rung ?? null, ms: Date.now() - t0 };
}

function lanStub(entries) {
  return { getNodeIds: () => entries.map((e) => e.nodeId), getPeer: (id) => entries.find((e) => e.nodeId === id) || null, on() {}, off() {}, close() {} };
}

async function testRungs() {
  console.log('\n=== 1. success via each rung (first success wins) ===');
  const network = new MemoryNetwork();
  const good = await peer(network, 'ladder good peer');

  // Rung 1: cache holds the good peer and two black holes.
  const c = await makeNode(network, 'ladder rung cache');
  const bh1 = await blackhole(network);
  const bh2 = await blackhole(network);
  // Seen least recently, so dialled last: the black holes are in flight when it wins.
  c.peerCache.recordSuccess(good.identity.nodeIdHex, 'memory', good.port);
  c.peerCache.recordSuccess(bh1.nodeId, 'memory', bh1.port);
  c.peerCache.recordSuccess(bh2.nodeId, 'memory', bh2.port);
  // Backdate AFTER the last recordSuccess: each one saves, and save() merges
  // the file back in keeping the newer lastSeen, so a backdate made before
  // them was silently undone. The order then hung on whether the three
  // records fell in the same millisecond — it failed on GitLab's runner
  // (good dialled second, 1 cancelled), passed here.
  c.peerCache.cache.find((e) => e.nodeId === good.identity.nodeIdHex).lastSeen -= 60000;
  // Every dial the ladder starts, in order, with when (the ladder calls node.dial).
  const dials = [];
  const dial0 = c.dial.bind(c);
  const t0 = Date.now();
  c.dial = (address, port, o) => { dials.push({ port, at: Date.now() - t0 }); return dial0(address, port, o); };
  const r1 = await ladder(c);
  timings.cache = r1.ms;
  assert(r1.ok && r1.rung === 'cache', `rung 1 (peer cache): connected in ${r1.ms} ms`);
  await new Promise((r) => setTimeout(r, 50));
  const name = (p) => (p === good.port ? 'good' : p === bh1.port ? 'bh1' : p === bh2.port ? 'bh2' : `?${p}`);
  const order = dials.map((d) => `${name(d.port)}@${d.at}ms`).join(', ');
  // Two separate properties, so a failure says which one broke (a single
  // "cancelled >= 2" could not tell a wrong dial order from a missed cancel).
  // 1. Order: the cache rung dials the most recently seen first, so the good
  //    peer (seen a minute earlier) comes after both black holes.
  assert(dials.length >= 1 && name(dials[dials.length - 1].port) === 'good' && dials.length === 3,
    `cache candidates are dialled most-recently-seen first: both black holes, then the good peer (${order})`);
  // 2. Cancellation: every other dial started before the win is cancelled, and
  //    only the winning link is kept. Control: at least one other dial was in
  //    flight, else there was nothing to cancel.
  const inFlight = dials.filter((d) => d.port !== good.port).length;
  assert(inFlight >= 1 && c.bootstrap.lastRun.cancelled === inFlight && c.connections.size === 1,
    `every other dial in flight at the win was cancelled (${c.bootstrap.lastRun.cancelled} cancelled of ${inFlight} in flight, ${c.connections.size} link kept; ${order})`);

  // Rung 2: the cache knows the peer at a stale address; LAN sees it at the right one.
  const l = await makeNode(network, 'ladder rung lan');
  const stale = await blackhole(network);
  l.peerCache.recordSuccess(good.identity.nodeIdHex, 'memory', stale.port);
  l.lanDiscovery = lanStub([{ nodeId: good.identity.nodeIdHex, address: 'memory', port: good.port }]);
  l.bootstrap.stage1TimeoutMs = 300;
  const r2 = await ladder(l);
  timings.lan = r2.ms;
  assert(r2.ok && r2.rung === 'lan', `rung 2 (LAN, known peer at its current address): connected in ${r2.ms} ms`);

  // Rung 3: nothing cached, no LAN, the public list has two black holes and the good peer.
  const p = await makeNode(network, 'ladder rung public');
  const b1 = await blackhole(network);
  const b2 = await blackhole(network);
  p.bootstrap.publicPeersPath = peersFile([{ port: b1.port, nodeId: b1.nodeId }, { port: good.port, nodeId: good.identity.nodeIdHex }, { port: b2.port, nodeId: b2.nodeId }]);
  const r3 = await ladder(p);
  timings.public = r3.ms;
  assert(r3.ok && r3.rung === 'public', `rung 3 (public-peers.json): connected in ${r3.ms} ms`);

  // Rung 4: only the peer-exchange pool (learned in an earlier session) has it.
  const x = await makeNode(network, 'ladder rung px');
  x.bootstrap.publicPeersPath = peersFile([]);
  x.peerExchange.candidatePool.set(good.identity.nodeIdHex, { nodeId: good.identity.nodeIdHex, address: 'memory', port: good.port, lastSeen: Date.now() });
  const r4 = await ladder(x);
  timings.peerExchange = r4.ms;
  assert(r4.ok && r4.rung === 'peer-exchange', `rung 4 (peer exchange): connected in ${r4.ms} ms`);
}

async function testLanStrangers() {
  console.log('\n=== 2. LAN: known peers only, unless allowed ===');
  const network = new MemoryNetwork();
  const stranger = await peer(network, 'ladder lan stranger');
  const a = await makeNode(network, 'ladder lan cautious');
  a.bootstrap.publicPeersPath = peersFile([]);
  a.lanDiscovery = lanStub([{ nodeId: stranger.identity.nodeIdHex, address: 'memory', port: stranger.port }]);
  const r = await ladder(a);
  assert(!r.ok && stranger.connections.size === 0, 'a LAN peer this node never met is not dialled (no stranger gets a connection)');
  const b = await makeNode(network, 'ladder lan open', { GMP_LAN_BOOTSTRAP_ANY: true });
  b.bootstrap.publicPeersPath = peersFile([]);
  b.lanDiscovery = lanStub([{ nodeId: stranger.identity.nodeIdHex, address: 'memory', port: stranger.port }]);
  const r2 = await ladder(b);
  assert(r2.ok && r2.rung === 'lan', 'with GMP_LAN_BOOTSTRAP_ANY=true it is');
}

async function testPublicShape() {
  console.log('\n=== 3. public rung: shuffled, 3 in flight ===');
  const network = new MemoryNetwork();
  const holes = [];
  for (let i = 0; i < 6; i++) holes.push(await blackhole(network));
  const f = peersFile(holes.map((h) => ({ port: h.port, nodeId: h.nodeId })));
  const firsts = new Set();
  let maxInFlight = 0;
  for (let i = 0; i < 4; i++) {
    const node = await makeNode(network, `ladder shape ${i}`, { GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 400, GMP_BOOTSTRAP_DIAL_TIMEOUT_MS: 150 });
    node.bootstrap.publicPeersPath = f;
    const order = [];
    let inFlight = 0;
    const dial = node.dial.bind(node);
    node.dial = (addr, port, o) => {
      order.push(port);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const p = dial(addr, port, o);
      p.then(() => { inFlight--; }, () => { inFlight--; });
      return p;
    };
    await ladder(node);
    firsts.add(order.slice(0, 3).join(','));
  }
  assert(firsts.size > 1, `order is shuffled per run (${firsts.size} different first waves in 4 runs)`);
  assert(maxInFlight > 0 && maxInFlight <= 3, `never more than 3 public dials in flight (max ${maxInFlight})`);
}

async function testWorstCase() {
  console.log('\n=== 4. worst case to step 5 ===');
  const network = new MemoryNetwork();
  const w = await makeNode(network, 'ladder worst case');
  for (let i = 0; i < 5; i++) { const h = await blackhole(network); w.peerCache.recordSuccess(h.nodeId, 'memory', h.port); }
  const lanHole = await blackhole(network);
  w.peerCache.recordSuccess(lanHole.nodeId, 'memory', (await blackhole(network)).port);
  w.lanDiscovery = lanStub([{ nodeId: lanHole.nodeId, address: 'memory', port: lanHole.port }]);
  const pub = [];
  for (let i = 0; i < 6; i++) { const h = await blackhole(network); pub.push({ port: h.port, nodeId: h.nodeId }); }
  w.bootstrap.publicPeersPath = peersFile(pub);
  for (let i = 0; i < 2; i++) { const h = await blackhole(network); w.peerExchange.candidatePool.set(h.nodeId, { nodeId: h.nodeId, address: 'memory', port: h.port, lastSeen: Date.now() }); }
  const r = await ladder(w);
  timings.worstCase = r.ms;
  assert(!r.ok && r.rung === 'manual', `all four rungs exhausted; step 5 (QR / paste) reached in ${r.ms} ms`);
  assert(r.ms < 8000, `worst case under 8 s including every timeout (${r.ms} ms; budgets cache ${DEFAULTS.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS} + LAN ${DEFAULTS.GMP_BOOTSTRAP_LAN_TIMEOUT_MS} + public ${DEFAULTS.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS} + peer exchange ${DEFAULTS.GMP_BOOTSTRAP_PX_TIMEOUT_MS} ms)`);
  return { w, pub };
}

async function testDemotion({ w, pub }) {
  console.log('\n=== 5. demotion with backoff, never removal ===');
  const health = w.bootstrap.publicPeerHealth;
  const demoted = pub.filter((p) => health.isDemoted(p.nodeId));
  assert(demoted.length > 0 && demoted.every((p) => health.get(p.nodeId).failures === 1), `unreachable public peers demoted after one failed run (${demoted.length})`);
  const first = health.get(demoted[0].nodeId).nextTryAt - Date.now();
  health.recordFailure(demoted[0].nodeId);
  const second = health.get(demoted[0].nodeId).nextTryAt - Date.now();
  assert(second > first * 1.8, `backoff doubles (${Math.round(first / 1000)} s -> ${Math.round(second / 1000)} s)`);
  const listed = JSON.parse(fs.readFileSync(w.bootstrap.publicPeersPath, 'utf8'));
  assert(listed.length === pub.length, 'nothing removed from the shipped list');

  // Every black hole demoted, one healthy newcomer: only the newcomer is dialled.
  // (Within one run, three dead hosts shuffled to the front hold all three
  // slots for the whole 4 s budget and a live fourth is not reached; demotion
  // is what gets it reached on the next run.)
  for (const p of pub) if (!health.isDemoted(p.nodeId)) health.recordFailure(p.nodeId);
  const network = w.transport.network;
  const good = await peer(network, 'ladder demotion good');
  w.bootstrap.publicPeersPath = peersFile([...pub, { port: good.port, nodeId: good.identity.nodeIdHex }]);
  const order = [];
  const dial = w.dial.bind(w);
  w.dial = (a, p, o) => { order.push(p); return dial(a, p, o); };
  w.peerCache.cache = [];
  w.lanDiscovery = null;
  w.peerExchange.candidatePool.clear();
  const r = await ladder(w);
  const demotedPorts = new Set(pub.map((p) => p.port));
  assert(r.ok && order.includes(good.port) && !order.some((p) => demotedPorts.has(p)),
    `while undemoted hosts remain, demoted ones are skipped (dialled ${order.length}, none demoted) and the reachable one wins`);
  w.connections.forEach((l) => l.destroy());
  await new Promise((res) => setTimeout(res, 30));
  w.bootstrap.publicPeersPath = peersFile(pub);
  order.length = 0;
  w.bootstrap.stage2TimeoutMs = 300;
  await ladder(w);
  assert(order.length > 0, `every entry demoted: they are still tried (${order.length} dials), never skipped outright`);
}

/**
 * A live host must not wait behind three dead ones. With the
 * public list holding three black holes and one live host, shuffled, every
 * run reaches the live one inside the public rung's budget.
 */
async function testNoStarvation() {
  console.log('\n=== 8. no starvation behind dead hosts ===');
  const network = new MemoryNetwork();
  const live = await peer(network, 'ladder stagger live');
  const holes = [];
  for (let i = 0; i < 3; i++) holes.push(await blackhole(network));
  const f = peersFile([...holes.map((h) => ({ port: h.port, nodeId: h.nodeId })), { port: live.port, nodeId: live.identity.nodeIdHex }]);
  const runs = [];
  for (let i = 0; i < 10; i++) {
    const node = await makeNode(network, `ladder stagger ${i}`);
    node.bootstrap.publicPeersPath = f;
    const starts = [];
    const dial = node.dial.bind(node);
    node.dial = (a, p, o) => { starts.push(Date.now()); return dial(a, p, o); };
    const r = await ladder(node);
    runs.push({ ok: r.ok, ms: r.ms, gaps: starts.slice(1).map((t, k) => t - starts[k]) });
    node.close();
  }
  const worst = Math.max(...runs.map((r) => r.ms));
  assert(runs.every((r) => r.ok), `the live host was reached in all 10 runs (slowest ${worst} ms, public budget ${DEFAULTS.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS} ms)`);
  const firstGaps = runs.flatMap((r) => r.gaps.slice(0, 2));
  assert(firstGaps.length > 0 && firstGaps.every((g) => g >= 450), `dial starts are staggered ~500 ms apart (${firstGaps.slice(0, 6).join(', ')} ms)`);
}

async function testTcpAbort() {
  console.log('\n=== 7. real TCP: a black-holed connect is abandoned at the budget ===');
  // Memory transport connects instantly; TCP to an unroutable address waits
  // for the OS (minutes). The ladder must not.
  const node = createGMPNode({ config: { ...DEFAULTS, GMP_MIN_PEERS: 1, GMP_LAN_DISCOVERY: false, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 500 }, dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new TcpTransport() });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity('ladder tcp abort');
  node.bootstrap.publicPeersPath = peersFile(['10.255.255.1', '10.255.255.2', '10.255.255.3'].map((address, i) => ({ address, port: 49500, nodeId: String(i + 1).repeat(128) })));
  const r = await ladder(node);
  assert(!r.ok && r.ms < 1500, `three unroutable TCP hosts with a 500 ms public budget: step 5 after ${r.ms} ms (not the OS connect timeout)`);
}

function testShippedList() {
  console.log('\n=== 6. the shipped public-peers.json (GM-N3-1) ===');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'public-peers.json'), 'utf8'));
  const peers = loadPublicPeers(path.join(here, '..', 'data', 'public-peers.json'));
  assert(raw.every((e) => Array.isArray(e.roles) && e.roles.length > 0 && typeof e.operator === 'string'), 'every shipped entry carries roles and an operator field');
  const unconfirmed = raw.filter((e) => !e.operator).length;
  assert(peers.filter((p) => !p.operator).length === unconfirmed, `an empty operator loads as unknown (${unconfirmed} unconfirmed): it never drives a refusal, only "not separated"`);
  const rolesByOp = new Map();
  for (const p of peers) for (const r of p.roles) rolesByOp.set(p.operator, new Set([...(rolesByOp.get(p.operator) || []), r]));
  assert([...rolesByOp.values()].every((r) => r.size === 1), 'no operator holds more than one role');
  assert(raw.every((e) => /^[0-9a-f]{128}$/.test(e.nodeId)), 'every NodeID is a real 128-hex NodeID (none invented as placeholders)');
  const providers = new Set(raw.map((e) => e.provider));
  const roles = new Set(peers.flatMap((p) => p.roles));
  console.log(`    STATUS: ${raw.length}/5 entries, ${providers.size}/3 providers, roles present: ${[...roles].join(', ')} (need bootstrap, relay, storage) — N3-1 NOT met; see docs/TASKS.md`);
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N3-2 — Bootstrap Ladder Test                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testRungs();
    await testLanStrangers();
    await testPublicShape();
    const w = await testWorstCase();
    await testDemotion(w);
    await testNoStarvation();
    await testTcpAbort();
    testShippedList();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  console.log(`\n  MEASURED (in-process, memory transport): ${JSON.stringify(timings)}`);
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
