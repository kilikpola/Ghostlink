/**
 * Blast radius of protective controls (task D1; subscriber table in
 * docs/subscriber-table.md). CHARACTERIZATION tests: each asserts what the code
 * does where a control reaches beyond the offending link or contact; a fix
 * flips the marked assertion. Every open one is a bug-family-4 candidate, not
 * an endorsement. Each has a control showing the channel is live.
 *
 *  F1-F3 were fixed in D2 and their marked assertions flipped ("D2 (flipped)"):
 *  F1 A penalty on one mesh-routed (virtual) link closes that link and refuses
 *     that NodeID; the node's other virtual links survive. Virtual links have
 *     no address (they used to claim 127.0.0.1 and an IP ban on it destroyed
 *     every one), and relay/storage rate keys use their proven NodeID.
 *  F2 The forwarding rate limit (500 transit packets / 60 s per incoming link)
 *     closes the offender's link and refuses its NodeID for 24 h. Nobody else
 *     behind the same address (memory transport: all links share
 *     'memory.local', as behind one CGNAT) is disconnected or refused.
 *  F3 The forwarder's routing-loop check compared a 64-hex prefix with the
 *     128-hex NodeID and never fired; it now drops a packet carrying our own
 *     source, penalizing nobody.
 *  F4 Storage at bucketCount = 1: another sender's deposits evict an honest
 *     user's mailbox blob (oldest first), and nothing tells that blob's sender.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await delay(20); return pred(); };

const { createGMPNode } = await import('../dist/node-factory.js');
const { DEFAULTS } = await import('../dist/config-defaults.js');
const { MemoryNetwork, MemoryTransport } = await import('../dist/transport/memory-transport.js');
const { BlobStore } = await import('../dist/storage/blob-store.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-blast-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
async function node(network, label, cfg = {}) {
  const x = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false, ...cfg }, dataDir: path.join(tmp, `${++n}-${label}`), port: 0, transport: new MemoryTransport(network), disableBootstrap: true });
  x.on('error', () => {});
  await x.loadIdentity(`d1 blast radius ${label} ${n}`);
  await x.listen();
  nodes.push(x);
  return x;
}
const hexOf = (x) => x.identity.nodeIdHex;
const linkTo = (from, to) => from.getLinkByNodeId(hexOf(to));
const virtualTo = (from, to) => from.virtualConnections.get(hexOf(to).slice(0, 64)) || null;

// ── F1 ────────────────────────────────────────────────────────────────────
console.log('\n=== F1: a penalty on ONE mesh-routed link and the node\'s other mesh-routed links ===');
{
  const net = new MemoryNetwork();
  const hub = await node(net, 'hub'), a = await node(net, 'alice'), b = await node(net, 'bob'), c = await node(net, 'carol');
  for (const x of [a, b, c]) await x.dial('memory', hub.port);
  await delay(300);
  for (const t of [b, c]) { await a.topologyManager.queryRoute(hexOf(t)); await a.dialVirtual(Buffer.from(hexOf(t), 'hex')); }
  await waitFor(() => virtualTo(a, b)?.state === 'connected' && virtualTo(a, c)?.state === 'connected');
  const vb = virtualTo(a, b), vc = virtualTo(a, c);
  ok(vb?.state === 'connected' && vc?.state === 'connected', 'control: alice has two mesh-routed links (to bob and to carol)');
  ok(vb.socket.remoteAddress === null && vc.socket.remoteAddress === null,
    `D2 (flipped): a mesh-routed link reports no network address (bob ${vb.socket.remoteAddress}, carol ${vc.socket.remoteAddress}); it used to claim 127.0.0.1`);
  const rp = await import('../dist/relay/relay-protocol.js');
  ok(typeof rp.rateKey === 'function' && rp.rateKey(vb) === `node:${hexOf(b)}` && rp.rateKey(vc) === `node:${hexOf(c)}`,
    'D2 (flipped): relay/storage rate keys for mesh-routed links are their proven NodeIDs, not one shared placeholder bucket');
  ok(typeof rp.rateKey === 'function' && rp.rateKey(linkTo(hub, a)) === rp.subnetKey(linkTo(hub, a).socket.remoteAddress),
    'D2: rateKey still keys a link that has an address by its subnet (unchanged for direct links)');
  // Bob's link reaches score 0 (the same entry ten post-connect decryption failures, or the forwarding limit, use).
  vb._penalizeBanned('D1 test: bob misbehaves');
  await delay(100);
  ok(vb.state === 'closed', 'bob\'s link is closed (the intended effect)');
  ok(a.reputation.isBanned(hexOf(b)), 'control: bob\'s NodeID is refused (time-boxed)');
  const ipBans = a.reputation.bannedIps;
  ok(!ipBans || ipBans.size === 0, `D2 (flipped): the ban records no address (address bans: ${ipBans ? JSON.stringify([...ipBans.keys()]) : 'none kept'})`);
  ok(vc.state === 'connected', `D2 (flipped): carol's unrelated session survives (state ${vc.state})`);
  for (const x of [hub, a, b, c]) x.close();
}

// ── F2 ────────────────────────────────────────────────────────────────────
console.log('\n=== F2: the forwarding limit bans the offender — and only the offender ===');
{
  const net = new MemoryNetwork();
  const hub = await node(net, 'public-peer'), mallory = await node(net, 'mallory'), alice = await node(net, 'alice-cgnat'), dest = await node(net, 'dest');
  for (const x of [mallory, alice, dest]) await x.dial('memory', hub.port);
  await delay(300);
  const hm = linkTo(hub, mallory), ha = linkTo(hub, alice);
  ok(hm?.socket.remoteAddress === 'memory.local' && ha?.socket.remoteAddress === 'memory.local' && ha.state === 'connected',
    'control: mallory and alice reach the public peer from the same address (memory.local, as behind one CGNAT)');
  const ml = linkTo(mallory, hub);
  const limit = DEFAULTS.GMP_FORWARD_RATE_LIMIT_PER_SOURCE;
  for (let i = 0; i <= limit; i++) ml.sendRoutedDATA(hexOf(dest), 16, Buffer.from(`transit ${i}`), mallory.identity.nodeId.slice(0, 32));
  await waitFor(() => hub.reputation.isBanned(hexOf(mallory)), 3000);
  await delay(200);
  ok(hub.reputation.isBanned(hexOf(mallory)), `mallory, after ${limit + 1} transit packets in the window, is banned on the public peer (the intended effect)`);
  ok(hm.state === 'closed', `mallory's link is closed (${hm.state})`);
  const ipBans = hub.reputation.bannedIps;
  ok(!ipBans || ipBans.size === 0, `D2 (flipped): her address is not banned (address bans: ${ipBans ? JSON.stringify([...ipBans.keys()]) : 'none kept'})`);
  ok(ha.state === 'connected' && !!linkTo(alice, hub), `D2 (flipped): alice — same address, did nothing — keeps her link to the public peer (${ha.state})`);
  const alice2 = await node(net, 'alice2-cgnat');
  let again = null;
  try { await alice2.dial('memory', hub.port); again = 'connected'; } catch (e) { again = e.message; }
  await delay(200);
  ok(!!linkTo(hub, alice2) && linkTo(hub, alice2).state === 'connected', `D2 (flipped): a new user behind the same address connects (${again})`);
  let back = null;
  try { await mallory.dial('memory', hub.port); back = 'dial resolved'; } catch (e) { back = e.message; }
  await delay(200);
  ok(!linkTo(hub, mallory), `control: mallory's NodeID is refused when she reconnects from the same address (${back === 'dial resolved' ? 'dial resolved, then refused in the handshake' : back})`);
  for (const x of [hub, mallory, alice, alice2, dest]) x.close();
}

// ── F3 ────────────────────────────────────────────────────────────────────
console.log('\n=== F3: the routing-loop check ===');
{
  const net = new MemoryNetwork();
  const hub = await node(net, 'hub-loop'), a = await node(net, 'a-loop'), b = await node(net, 'b-loop');
  for (const x of [a, b]) await x.dial('memory', hub.port);
  await delay(300);
  const forwarded = [];
  hub.on('forwarded', (f) => forwarded.push(f.sourceNodeId));
  const results = [];
  const realProcess = hub.forwarder.processIncoming.bind(hub.forwarder);
  hub.forwarder.processIncoming = (pt, l) => { const r = realProcess(pt, l); results.push(r && r.error); return r; };
  const before = hub.reputation.getScore(hexOf(a));
  ok(hub.identity.nodeIdHex.length === 128 && hub.identity.nodeId.slice(0, 32).length === 32, 'control: the routed source field is a 32-byte prefix, the NodeID 64 bytes');
  linkTo(a, hub).sendRoutedDATA(hexOf(b), 16, Buffer.from('ordinary'), a.identity.nodeId.slice(0, 32));
  await waitFor(() => forwarded.length === 1, 1000);
  ok(forwarded.length === 1 && forwarded[0] === hexOf(a).slice(0, 64), 'control: an ordinary transit packet from alice to bob is forwarded');
  // A routed packet that claims the hub itself as its source, handed to the hub by alice towards bob.
  linkTo(a, hub).sendRoutedDATA(hexOf(b), 16, Buffer.from('looped'), hub.identity.nodeId.slice(0, 32));
  await waitFor(() => results.length === 2, 1000);
  await delay(100);
  ok(results[1] === 'routing-loop' && forwarded.length === 1,
    `D2 (flipped): a packet carrying the hub's own source is recognised as a loop and dropped (result ${results[1]}, forwarded ${forwarded.length - 1})`);
  ok(hub.reputation.getScore(hexOf(a)) === before && linkTo(hub, a)?.state === 'connected',
    `the neighbour that handed it back is not penalized (score ${hub.reputation.getScore(hexOf(a))}, link ${linkTo(hub, a)?.state}): the source field is unauthenticated`);
  for (const x of [hub, a, b]) x.close();
}

// ── F4 ────────────────────────────────────────────────────────────────────
console.log('\n=== F4: storage, one bucket — another sender\'s deposits evict an honest blob ===');
{
  const store = new BlobStore({ dir: path.join(tmp, 'blobs'), maxBlobsPerBucket: 4, maxBytesPerBucket: 1 << 20 });
  const honest = store.put(0, Buffer.from('alice → bob: sealed mailbox message'));
  const flood = [];
  for (let i = 0; i < 3; i++) flood.push(store.put(0, Buffer.from(`mallory junk ${i}`)));
  ok(store.list(0).some((m) => m.blobId === honest.blobId) && flood.every((f) => f.evicted.length === 0), 'control: below the cap nothing is evicted; the honest blob is listed');
  const fourth = store.put(0, Buffer.from('mallory junk 3'));
  ok(fourth.evicted.includes(honest.blobId) && !store.list(0).some((m) => m.blobId === honest.blobId),
    'CURRENT BEHAVIOUR (designed at bucketCount = 1, N2c): mallory\'s next deposit evicts alice\'s blob (oldest first) — blast radius: other users\' stored mail');
  ok(Array.isArray(fourth.evicted), 'the eviction is reported only in the depositor\'s own put() result (the sender-side consequence — no receipt, expiry at TTL — is read from store-forward.ts, not exercised here)');
}

for (const x of nodes) { try { x.close(); } catch { /* closed */ } }
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
