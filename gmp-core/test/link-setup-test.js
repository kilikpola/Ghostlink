/**
 * Mesh link setup root causes found in L1 (real-network-links.mjs, 20 live
 * trials), reproduced deterministically on the memory transport with fault
 * injection. Every negative has a positive control.
 *
 *  1. RC1 half-open: the initiator's key-confirm PING cannot be routed. Before:
 *     dialVirtual rejects but the link stays 'connected' for ~10 s (until PONG
 *     timeout) and a ratchet send on it is reported as sent; nothing arrives.
 *  2. RC1b a send whose frame cannot be routed (route lost on an established
 *     virtual link) is reported as sent.
 *  3. RC2 closing ONE of two links to a peer removes every route through that
 *     peer, although the other link is still up (link.js close handlers).
 *  4. RC2's trigger: external-address discovery (queryPublicAddress) dials a
 *     second, throwaway link to the public peer it is already linked to.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await delay(20); return pred(); };

const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const { MemoryNetwork, MemoryTransport } = await import('../dist/transport/memory-transport.js');
const { queryPublicAddress } = await import('../dist/public-peer-list.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-setup-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const base = { disableBootstrap: true, GMP_LAN_DISCOVERY: false, storeForward: false, GMP_METRICS_PORT: 0, GMP_PORT: 0 };
async function mesh() {
  const network = new MemoryNetwork();
  const mk = (label, extra = {}) => new GMPNodeManager({ ...base, seedPhrase: `l1 link setup ${label} ${n}`, transport: new MemoryTransport(network), dataDir: path.join(tmp, `${++n}-${label}`), ...extra });
  const hub = mk('hub'); const hs = await hub.start();
  const a = mk('alice', { ratchetCapable: true, ratchets: { memoryOnly: 'test' } }); const as = await a.start();
  const b = mk('bob', { ratchetCapable: true, ratchets: { memoryOnly: 'test' } }); const bs = await b.start();
  await a.connectToPeer('memory', hs.port); await b.connectToPeer('memory', hs.port);
  await delay(300);
  const got = { a: [], b: [] };
  a.on('ratchet-message', (x) => got.a.push(x.payload.toString())); b.on('ratchet-message', (x) => got.b.push(x.payload.toString()));
  const stop = async () => { for (const m of [a, b, hub]) await m.stop(); };
  return { hub, a, b, hs, as, bs, got, stop, network };
}
const virtualTo = (m, id) => m.node.virtualConnections.get(id.slice(0, 64)) || null;
function captureLogs() {
  const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...x) => { const s = x.join(' '); if (s.startsWith('{"ts"')) lines.push(JSON.parse(s)); else orig[k](...x); };
  return { lines, restore: () => Object.assign(console, orig) };
}

// ── 1. RC1: key-confirm PING unroutable ───────────────────────────────────
console.log('\n=== 1. RC1: the key-confirm PING cannot be routed → no usable half-open link ===');
{
  const M = await mesh();
  ok(await M.a.node.topologyManager.queryRoute(M.bs.nodeId), 'control: alice has a route to bob through the hub');
  // Fault: the route vanishes right after alice's HELLO left (the live trace: route lost between HELLO and key-confirm).
  const rt = M.a.node.routingTable;
  const real = rt.getBestRoute.bind(rt);
  let helloWrites = 0;
  rt.getBestRoute = (dest) => { if (dest === M.bs.nodeId && ++helloWrites > 1) return null; return real(dest); };
  const cap = captureLogs();
  let dialErr = null;
  try { await M.a.node.dialVirtual(Buffer.from(M.bs.nodeId, 'hex')); } catch (e) { dialErr = e.message; }
  await delay(50);
  const v = virtualTo(M.a, M.bs.nodeId);
  let sendErr = null;
  try { await M.a.ratchetSend(M.bs.nodeId, Buffer.from('into a half-open link')); } catch (e) { sendErr = e.name; }
  cap.restore();
  rt.getBestRoute = real;
  await delay(300);
  ok(dialErr !== null, `the dial fails (${dialErr})`);
  ok(!v || v.state !== 'connected', `alice keeps no 'connected' link to bob after its key-confirm PING failed (state: ${v ? v.state : 'none'})`);
  ok(sendErr === 'RatchetNotConnectedError' && M.got.b.length === 0, `a ratchet send then fails by name (${sendErr}), nothing reaches bob`);
  ok(cap.lines.some((l) => l.event === 'virtual-no-route' && l.level === 'WARN'), 'the closed virtual link is logged (virtual-no-route, WARN)');
  // Bob still holds the responder half of the failed handshake ('confirming'): RC3.
  const stale = virtualTo(M.b, M.as.nodeId);
  ok(stale && stale.state === 'confirming', `setup for RC3: bob still holds the half-done responder link (${stale ? stale.state : 'none'})`);
  // Control: same mesh, no fault. Alice's new HELLO must not be swallowed by bob's half-done link.
  const cap2 = captureLogs();
  const conn = await M.a.node.dialVirtual(Buffer.from(M.bs.nodeId, 'hex')).then(() => true, (e) => e.message);
  cap2.restore();
  ok(cap2.lines.some((l) => l.event === 'virtual-handshake-superseded'), 'RC3: bob replaced the half-done responder link for the new HELLO (virtual-handshake-superseded logged)');
  await waitFor(() => !!virtualTo(M.b, M.as.nodeId) && virtualTo(M.b, M.as.nodeId).state === 'connected');
  const r = await M.a.ratchetSend(M.bs.nodeId, Buffer.from('control')).then((x) => x, (e) => ({ error: e.name }));
  await waitFor(() => M.got.b.length === 1);
  ok(conn === true && !r.error && M.got.b[0] === 'control', `control: without the fault the virtual link carries the message (${conn === true ? 'connected' : conn})`);
  await M.stop();
}

// ── 2. RC1b: a send whose frame cannot be routed ──────────────────────────
console.log('\n=== 2. RC1b: a send whose frame cannot be routed is never reported as sent ===');
{
  const M = await mesh();
  await M.a.node.topologyManager.queryRoute(M.bs.nodeId);
  await M.a.node.dialVirtual(Buffer.from(M.bs.nodeId, 'hex'));
  await waitFor(() => virtualTo(M.b, M.as.nodeId)?.state === 'connected');
  const first = await M.a.ratchetSend(M.bs.nodeId, Buffer.from('m0')).then((x) => x, (e) => ({ error: e.name }));
  await waitFor(() => M.got.b.length === 1);
  const rt = M.a.node.routingTable; const real = rt.getBestRoute.bind(rt);
  rt.getBestRoute = (dest) => (dest === M.bs.nodeId ? null : real(dest));
  const second = await M.a.ratchetSend(M.bs.nodeId, Buffer.from('m1')).then((x) => x, (e) => ({ error: e.name }));
  const third = await M.a.ratchetSend(M.bs.nodeId, Buffer.from('m2')).then((x) => x, (e) => ({ error: e.name }));
  rt.getBestRoute = real;
  await delay(300);
  ok(!first.error && M.got.b[0] === 'm0', 'control: the established link carries m0');
  ok(second.error === 'RatchetNotConnectedError' && third.error === 'RatchetNotConnectedError' && M.got.b.length === 1,
    `once the route is gone the send fails by name (${second.error ?? 'reported as sent'}, ${third.error ?? 'reported as sent'}); nothing claimed delivered that was not`);
  ok(M.a.ratchetUnacknowledged(M.bs.nodeId).length >= 1, `the message that failed to leave stays on alice's unacknowledged list (${M.a.ratchetUnacknowledged(M.bs.nodeId).length}): not silently lost`);
  await M.stop();
}

// ── 3. RC2: closing one of two links to a peer ────────────────────────────
console.log('\n=== 3. RC2: closing ONE of two links to the hub must not drop the routes through it ===');
{
  const M = await mesh();
  ok(await M.a.node.topologyManager.queryRoute(M.bs.nodeId), 'alice has a route to bob through the hub');
  const { link: second } = await M.a.node.dial('memory', M.hs.port);
  const links = [...M.a.node.connections.values()].filter((l) => l.state === 'connected' && l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === M.hs.nodeId);
  second.destroy();
  await delay(100);
  const stillLinked = !!M.a.node.getLinkByNodeId(M.hs.nodeId);
  ok(links.length === 2 && stillLinked, `setup: two links to the hub, one closed, one still up (${links.length} → ${stillLinked ? 1 : 0})`);
  ok(!!M.a.node.routingTable.getBestRoute(M.bs.nodeId), 'the route to bob through the hub survives (it still has a live next hop)');
  const conn = await M.a.node.dialVirtual(Buffer.from(M.bs.nodeId, 'hex')).then(() => 'connected', (e) => e.message);
  ok(conn === 'connected', `and a virtual link to bob still comes up (${conn})`);
  // Control: closing the LAST link to the hub does remove them.
  for (const l of [...M.a.node.connections.values()]) if (l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === M.hs.nodeId && !l.isVirtual) l.destroy();
  await delay(100);
  ok(!M.a.node.routingTable.getBestRoute(M.bs.nodeId), 'control: closing the last link to the hub removes the routes through it');
  await M.stop();
}

// ── 4. RC2 trigger: external-address discovery dials a duplicate link ─────
console.log('\n=== 4. external-address discovery reuses the link to the public peer instead of dialling a second one ===');
{
  const M = await mesh();
  await M.a.node.topologyManager.queryRoute(M.bs.nodeId);
  const opened = [];
  M.a.node.on('connection', ({ link }) => { if (!link.isVirtual) opened.push(link); });
  const peerEntry = [{ address: 'memory', port: M.hs.port, nodeId: M.hs.nodeId, roles: ['bootstrap'] }];
  const found = await queryPublicAddress(M.a.node, peerEntry, 3000).then((x) => x, (e) => ({ error: e.message }));
  await delay(200);
  // Control: a node with NO link to the hub yet must open one for the query, and the counter sees it.
  const c = new GMPNodeManager({ ...base, seedPhrase: `l1 link setup carol ${n}`, transport: new MemoryTransport(M.network), dataDir: path.join(tmp, `${++n}-carol`) });
  await c.start();
  const cOpened = [];
  c.node.on('connection', ({ link }) => { if (!link.isVirtual) cOpened.push(link); });
  const cFound = await queryPublicAddress(c.node, peerEntry, 3000).then((x) => x, (e) => ({ error: e.message }));
  await delay(200);
  await c.stop();
  ok(!found.error && typeof found.address === 'string' && !cFound.error, `the external address is still learned (${found.error || `${found.address}:${found.port}`}; control node: ${cFound.error || 'ok'})`);
  assertAbsent({
    channel: 'a second link opened to a public peer the node is already linked to',
    controlMessage: 'a node not yet linked to the hub opens one for the same query',
    control: () => cOpened.length,
    absent: () => opened.length === 0,
    message: `alice opened none (${opened.length}); the query went over her existing link`,
  });
  ok(!!M.a.node.routingTable.getBestRoute(M.bs.nodeId), 'the route to bob is intact after discovery');
  await M.stop();
}

// ── 5. connectByNodeId asks for a route, and logs a failure ───────────────
console.log('\n=== 5. connectByNodeId asks the mesh for a route first, and logs when it cannot connect ===');
{
  const M = await mesh();
  // Deterministic: alice holds no route to bob (on the live peer she had none: R7, 10/10 'no-route').
  M.a.node.routingTable.removeRoute(M.bs.nodeId, M.hs.nodeId);
  const before = !!M.a.node.routingTable.getBestRoute(M.bs.nodeId);
  const r = await M.a.connectByNodeId(M.bs.nodeId);
  ok(!before && r.connected && r.transport === 'virtual', `with no route held, connectByNodeId still connects (route queried first): ${JSON.stringify(r)}`);
  const ghost = 'de'.repeat(64);
  const cap = captureLogs();
  const miss = await M.a.connectByNodeId(ghost);
  cap.restore();
  ok(!miss.connected && cap.lines.some((l) => l.event === 'connect-by-nodeid-failed' && l.level === 'WARN'), `an unreachable NodeID fails and is logged (${JSON.stringify(miss)}; connect-by-nodeid-failed)`);
  await M.stop();
}

// ── 6. RC4: the responder holds no route back ─────────────────────────────
console.log('\n=== 6. RC4: a responder with no route back to the initiator looks one up instead of answering into nothing ===');
{
  const M = await mesh();
  await M.a.node.topologyManager.queryRoute(M.bs.nodeId);
  // Deterministic: bob holds no route to alice (live: the failing trials' responder never learned one).
  M.b.node.routingTable.removeRoute(M.as.nodeId, M.hs.nodeId);
  ok(!M.b.node.routingTable.getBestRoute(M.as.nodeId) && !!M.a.node.routingTable.getBestRoute(M.bs.nodeId), 'setup: alice has a route to bob, bob has none back');
  const conn = await M.a.node.dialVirtual(Buffer.from(M.bs.nodeId, 'hex')).then(() => 'connected', (e) => e.message);
  await waitFor(() => virtualTo(M.b, M.as.nodeId)?.state === 'connected');
  const r = conn === 'connected' ? await M.a.ratchetSend(M.bs.nodeId, Buffer.from('reached')).then((x) => x, (e) => ({ error: e.name })) : { error: 'no link' };
  await waitFor(() => M.got.b.length === 1);
  ok(conn === 'connected' && !r.error && M.got.b[0] === 'reached', `the handshake completes and carries a message (${conn}); bob looked up the route back`);
  // Control: a real, self-certifying HELLO from a node nobody can route to: looked up, not found, dropped and logged.
  const { x25519, ed25519 } = await import('@noble/curves/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  const stat = x25519.getPublicKey(crypto.randomBytes(32)), sign = ed25519.getPublicKey(crypto.randomBytes(32));
  const ghostId = Buffer.from(sha512(stat));
  const hello = Buffer.alloc(5 + 265); hello.writeUInt32BE(265, 0); hello[4] = 0x01; hello[5] = 1;
  ghostId.copy(hello, 6); Buffer.from(stat).copy(hello, 70); Buffer.from(sign).copy(hello, 102);
  const cap = captureLogs();
  M.b.node.handleIncomingRoutedPayload(ghostId.subarray(0, 32), hello);
  await delay(3500);
  // And a HELLO whose NodeID does not match its keys is not even looked up.
  const forged = Buffer.from(hello); forged[75] ^= 1;
  M.b.node.handleIncomingRoutedPayload(ghostId.subarray(0, 32), forged);
  await delay(100);
  cap.restore();
  ok(cap.lines.some((l) => l.event === 'virtual-handshake-no-return-route' && l.level === 'WARN') && !virtualTo(M.b, ghostId.toString('hex')),
    'control: an unroutable source is looked up, not found, dropped and logged (virtual-handshake-no-return-route); no link is created');
  ok(cap.lines.some((l) => l.event === 'virtual-handshake-dropped' && /does not match its keys/.test(l.msg)), 'a HELLO whose NodeID does not match its keys is dropped before any lookup (logged)');
  await M.stop();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
