/**
 * A connecting stranger cannot enumerate membership. A hub holds N peers; a
 * stranger connects, then reconnects with fresh identities from one address,
 * and the test counts every distinct NodeID learned via topology announces and
 * peer exchange, plus the hub's signatures per join.
 *
 * Bound: per address key and epoch, at most SAMPLE NodeIDs per channel; no
 * inbound client's NodeID in peer exchange; signing bounded by the cache.
 *
 * Run: node test/membership-disclosure-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createGMPNode } from '../dist/node-factory.js';
import { PeerSampler } from '../dist/topology-sample.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const N = Number(process.env.DISCLOSURE_PEERS || 30);
const SAMPLE = DEFAULTS.GMP_TOPOLOGY_SAMPLE_SIZE ?? 8;
// Realistic enough that the hub is not drowned by its own re-announce
// (at 400 ms and 30 peers the pre-fix hub could not serve the stranger at all).
const REANNOUNCE_MS = 5000;
const network = new MemoryNetwork();
const cfg = { ...DEFAULTS, GMP_LAN_DISCOVERY: false, GMP_REANNOUNCE_INTERVAL_MS: REANNOUNCE_MS };

// Each node its own data dir, as each is its own process in production: one
// shared peer-cache.json across 37 identities made every load fail to
// authenticate and buried the hub in re-derivations.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-disclosure-'));
async function mk(seed, extra = {}) {
  const n = createGMPNode({ config: cfg, port: 0, transport: new MemoryTransport(network), disableBootstrap: true, dataDir: path.join(tmp, seed.replace(/\W+/g, '-')), ...extra });
  n.on('error', () => {});
  await n.loadIdentity(seed);
  return n;
}

const hub = await mk('disclosure hub');
await hub.listen();
let signatures = 0;
{
  const tm = hub.topologyManager;
  for (const name of ['signOwnAnnounce', '_signEdge']) {
    if (typeof tm[name] === 'function') {
      const orig = tm[name].bind(tm);
      tm[name] = (...a) => { signatures++; return orig(...a); };
    }
  }
}

console.log(`\n=== ${N} peers join the hub ===`);
const members = new Set();
const peers = [];
for (let i = 0; i < N; i++) {
  const p = await mk(`disclosure member ${i}`);
  await p.dial('memory', hub.port);
  members.add(p.identity.nodeIdHex);
  peers.push(p);
}
// Let the hub finish its join work first: this measures disclosure, not a
// backlog (before M5-1 the hub needed seconds to work through ~N^2 signatures).
await delay(Number(process.env.DISCLOSURE_SETTLE_MS || 8000));
const perJoin = signatures / N;
console.log(`  hub signatures during ${N} joins: ${signatures} (${perJoin.toFixed(1)} per join)`);
assert(signatures <= 2 * N, `signing is not per recipient: ${signatures} signatures for ${N} joins (was ~N^2/2 = ${(N * (N - 1)) / 2})`);

/** What a stranger learns in one visit: NodeIDs of members, by channel. */
async function visit(tag) {
  const s = await mk(`disclosure stranger ${tag}`);
  const { link } = await s.dial('memory', hub.port);
  await delay(3000); // join-time announces and PX (sent 500 ms after connect)
  const viaTopology = new Set();
  for (const [announcer, edges] of s.topologyManager.lsdb) {
    for (const id of [announcer, ...edges.keys()]) if (members.has(id)) viaTopology.add(id);
  }
  const viaPx = new Set([...s.peerExchange.candidatePool.keys()].filter((id) => members.has(id)));
  const reached = link.state === 'connected';
  if (process.env.DISCLOSURE_DEBUG) console.log(`    [debug] hub connections ${[...hub.connections.values()].filter((l) => l.state === "connected").length}, hub links ${hub.links.size}, members still connected ${peers.filter((p) => [...p.links.values()].some((l) => l.state === "connected")).length}; lsdb ${s.topologyManager.lsdb.size} announcers, hub edges ${s.topologyManager.lsdb.get(hub.identity.nodeIdHex)?.size}, pool ${s.peerExchange.candidatePool.size}, link ${link.state}`);
  link.destroy();
  s.close();
  await delay(50);
  return { viaTopology, viaPx, reached };
}

console.log('\n=== one stranger, one connection ===');
const first = await visit('first');
console.log(`  learned ${first.viaTopology.size}/${N} member NodeIDs via topology, ${first.viaPx.size}/${N} via peer exchange`);
assert(first.reached, 'the stranger\'s connection stayed up for the whole visit (the hub was not too busy to serve it)');
assert(first.viaTopology.size <= SAMPLE, `topology gives a stranger at most ${SAMPLE} members (${first.viaTopology.size})`);
assert(first.viaPx.size === 0, `peer exchange gives a stranger no inbound client at all (${first.viaPx.size})`);

console.log('\n=== the same address reconnects 5 times with fresh identities ===');
const union = new Set([...first.viaTopology, ...first.viaPx]);
for (let i = 0; i < 5; i++) {
  const v = await visit(`again ${i}`);
  for (const id of [...v.viaTopology, ...v.viaPx]) union.add(id);
}
console.log(`  union after 6 visits: ${union.size}/${N}`);
assert(union.size <= SAMPLE, `reconnecting from one address learns nothing new within an epoch (union ${union.size} <= ${SAMPLE})`);

console.log('\n=== naming a destination confirms only what the asker already knows ===');
{
  const s = await mk('disclosure prober');
  await s.dial('memory', hub.port);
  await delay(300);
  const tm = s.topologyManager;
  // First, within the per-link budget (burst 10): a member the asker was told
  // about is found; NodeIDs it merely guesses are not.
  const known = [...members][0];
  assert(await tm.queryRoute(known, 2000), 'a query for a NodeID the asker already has is answered (that is the point)');
  let found = 0;
  for (let i = 0; i < 8; i++) {
    const guess = crypto.randomBytes(64).toString('hex');
    if (await tm.queryRoute(guess, 600)) found++;
  }
  assert(found === 0, `8 queries for guessed NodeIDs found nothing (${found})`);
  // Budget: the hub answers at most 10 at once from one link, then 30/min.
  const before = hub.topologyManager.stats.queriesAnswered;
  const burst = [];
  for (let i = 0; i < 40; i++) burst.push(tm.queryRoute(crypto.randomBytes(64).toString('hex'), 400));
  await Promise.all(burst);
  const answered = hub.topologyManager.stats.queriesAnswered - before;
  assert(answered <= 12, `a burst of 40 queries on one link is cut to the budget (${answered} answered)`);
  s.close();
}

console.log('\n=== the bound over time and across addresses (sampler, N=540, sample 8) ===');
{
  const members540 = Array.from({ length: 540 }, (_, i) => crypto.createHash('sha512').update(`m${i}`).digest('hex'));
  let now = 0;
  const sampler = new PeerSampler(crypto.randomBytes(32), () => 24 * 3600 * 1000, () => now);
  const one = new Set(sampler.pick('203.0.113.7', members540, (x) => x, 8));
  const again = new Set(sampler.pick('203.0.113.7', members540, (x) => x, 8));
  assert(one.size === 8 && [...one].every((x) => again.has(x)), 'one address, one epoch: the same 8, however often it asks');
  // One address across epochs: days until it has seen everyone.
  const seen = new Set();
  let days = 0;
  while (seen.size < members540.length && days < 5000) {
    now = days * 24 * 3600 * 1000;
    for (const x of sampler.pick('203.0.113.7', members540, (y) => y, 8)) seen.add(x);
    days++;
  }
  console.log(`  one address: ${days} daily epochs to see all 540 (coupon collector: ~(N/8)·ln N = ${Math.round((540 / 8) * Math.log(540))})`);
  assert(days >= 540 / 8, `one address cannot see all 540 in fewer than N/8 = 68 epochs (${days} daily epochs here; median over secrets ~466)`);
  // Many addresses in one epoch. The guarantee is per key: at most 8 new
  // NodeIDs each. It is NOT a defence against an attacker with many
  // addresses: coverage grows ~8 per key until it saturates (an IPv6 /48 is
  // 65,536 /64s). Asserted: the per-key bound; reported: the curve.
  now = 0;
  const seen2 = new Set();
  let keys = 0;
  const curve = [];
  let perKeyOk = true;
  while (seen2.size < members540.length && keys < 10000) {
    const before = seen2.size;
    for (const x of sampler.pick(`198.51.${keys >> 8}.${keys & 255}`, members540, (y) => y, 8)) seen2.add(x);
    if (seen2.size - before > 8) perKeyOk = false;
    keys++;
    if ([10, 50, 100, 200].includes(keys)) curve.push(`${keys} keys: ${seen2.size}`);
  }
  console.log(`  one epoch, many addresses: ${curve.join(', ')}; all 540 after ${keys} keys`);
  assert(perKeyOk, 'no address key ever adds more than 8 NodeIDs');
}

for (const p of peers) p.close();
hub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
