/**
 * What bucket co-occurrence gives a hostile storage host, simulated with the
 * real derivation (64 buckets, per-channel daily offsets, 2 decoy channels per
 * user, full daily fetch coverage):
 *
 *  A. Intersection on one pair A -> B, one offline message a day: users whose
 *     day-d fetch set holds A's deposit bucket, intersected over days.
 *       rotating  buckets derived from the epoch
 *       fixed     bucket = f(sharedSecret, direction)
 *
 *  B. Residual under fixed buckets, for A with 3, 10 or 50 contacts: how many
 *     users share a bucket with A's deposits, and whether A's real contacts
 *     stand out when ranked by overlap.
 *
 * Numbers go into docs/store-and-forward.md.
 *
 * Run: node test/sf-anonymity-sim-test.js
 */

import crypto from 'crypto';
import { Channel, bucketOf } from '../dist/storage/sf-crypto.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };

const BUCKETS = 64;
const CONTACTS = 12;
const DECOYS = 2;
const DAY = 86400;
const T0 = 1_790_000_000;

/** Users, each with inbound channels (from contacts) plus decoy channels. */
function network(users, contactsOf = () => CONTACTS) {
  const ids = Array.from({ length: users }, () => crypto.randomBytes(64));
  // Contacts are mutual. User 0 gets exactly contactsOf(0); everyone else
  // reaches about contactsOf(u) on average (each adds half, receives half).
  const contacts = ids.map(() => new Set());
  const want0 = Math.min(contactsOf(0), users - 1);
  while (contacts[0].size < want0) {
    const v = 1 + crypto.randomInt(users - 1);
    contacts[0].add(v); contacts[v].add(0);
  }
  for (let u = 1; u < users; u++) {
    const add = Math.min(Math.round(contactsOf(u) / 2), users - 2);
    for (let k = 0; k < add; k++) {
      const v = 1 + crypto.randomInt(users - 1);
      if (v !== u) { contacts[u].add(v); contacts[v].add(u); }
    }
  }
  // inbound[u] = channels whose recipient is u: one per contact, plus decoys.
  const inbound = ids.map((me, u) => [
    ...[...contacts[u]].map((v) => ({ from: v, ch: new Channel(crypto.randomBytes(32), me) })),
    ...Array.from({ length: DECOYS }, () => ({ from: -1, ch: new Channel(crypto.randomBytes(32), me) })),
  ]);
  return { ids, contacts, inbound };
}

function fetchSet(net, u, mode, nowS) {
  const set = new Set();
  for (const { ch } of net.inbound[u]) {
    if (mode === 'fixed') set.add(ch.bucket(BUCKETS));
    else { const e = ch.epoch(nowS); set.add(bucketOf(ch.tag(e), BUCKETS)); set.add(bucketOf(ch.tag(e - 1), BUCKETS)); }
  }
  return set;
}

function intersection(users, mode, trials, days = 7) {
  const rows = [];
  for (let t = 0; t < trials; t++) {
    const net = network(users);
    const b = 1; // an ordinary user (user 0 is reserved for the residual target)
    const ab = net.inbound[b][0].ch; // a real contact's channel into B
    let cand = null;
    const after = [];
    for (let d = 0; d < days; d++) {
      const nowS = T0 + d * DAY + 12 * 3600;
      const x = mode === 'fixed' ? ab.bucket(BUCKETS) : bucketOf(ab.tag(ab.epoch(nowS)), BUCKETS);
      const fetchers = new Set();
      for (let u = 0; u < users; u++) if (fetchSet(net, u, mode, nowS).has(x)) fetchers.add(u);
      cand = cand ? new Set([...cand].filter((u) => fetchers.has(u))) : fetchers;
      after.push(cand.size);
    }
    rows.push(after);
  }
  const mean = (d) => rows.reduce((a, r) => a + r[d], 0) / rows.length;
  return { d1: mean(0), d3: mean(2), d7: mean(days - 1), exact: rows.filter((r) => r[days - 1] === 1).length / rows.length };
}

function residual(users, targetContacts, trials) {
  const out = [];
  for (let t = 0; t < trials; t++) {
    const net = network(users, (u) => (u === 0 ? targetContacts : CONTACTS));
    const a = 0;
    // A's deposit buckets: for each contact v, the bucket of the channel A -> v.
    const deposits = new Set();
    for (const v of net.contacts[a]) {
      const ch = net.inbound[v].find((x) => x.from === a).ch;
      deposits.add(ch.bucket(BUCKETS));
    }
    const fetch = net.ids.map((_, u) => fetchSet(net, u, 'fixed', T0));
    const overlap = fetch.map((f, u) => (u === a ? -1 : [...f].filter((x) => deposits.has(x)).length));
    const touching = overlap.filter((o) => o > 0).length;
    const perEdge = [...deposits].map((x) => fetch.filter((f, u) => u !== a && f.has(x)).length);
    // Rank users by overlap; how many of A's real contacts are in the top |contacts|?
    const ranked = overlap.map((o, u) => [o, Math.random(), u]).filter(([o]) => o >= 0).sort((p, q) => q[0] - p[0] || q[1] - p[1]).map(([, , u]) => u);
    const top = new Set(ranked.slice(0, net.contacts[a].size));
    const hits = [...net.contacts[a]].filter((v) => top.has(v)).length;
    out.push({ buckets: deposits.size, touching, perEdge: perEdge.reduce((x, y) => x + y, 0) / perEdge.length, precision: hits / net.contacts[a].size, chance: net.contacts[a].size / (users - 1) });
  }
  const m = (k) => out.reduce((x, r) => x + r[k], 0) / out.length;
  return { buckets: m('buckets'), touching: m('touching'), perEdge: m('perEdge'), precision: m('precision'), chance: m('chance') };
}

console.log('A. recipient candidates for one A->B pair, one offline message a day (64 buckets)');
console.log('  buckets  | users | after 1 day | after 3 days | after 7 days | exact after 7 days');
const res = { rotating: {}, fixed: {} };
for (const mode of ['rotating', 'fixed']) {
  for (const u of [10, 100, 1000]) {
    const r = intersection(u, mode, u >= 1000 ? 5 : 20);
    res[mode][u] = r;
    console.log(`  ${mode.padEnd(8)} | ${String(u).padStart(5)} | ${r.d1.toFixed(1).padStart(11)} | ${r.d3.toFixed(1).padStart(12)} | ${r.d7.toFixed(1).padStart(12)} | ${(r.exact * 100).toFixed(0).padStart(17)}%`);
  }
}
for (const u of [100, 1000]) {
  assert(Math.abs(res.fixed[u].d7 - res.fixed[u].d1) < 1e-9, `fixed buckets, ${u} users: day 7 equals day 1 (${res.fixed[u].d7.toFixed(1)}) — repeating the observation adds nothing`);
}
assert(res.rotating[1000].d7 < res.rotating[1000].d1 / 10, 'rotating buckets still converge (the GM-N2b result reproduces)');

const avg = (() => { const net = network(1000); return net.contacts.slice(1).reduce((x, c) => x + c.size, 0) / 999; })();
console.log(`\nB. residual under fixed buckets, 1000 users (others average ${avg.toFixed(1)} contacts, + ${DECOYS} decoy channels), 64 buckets`);
console.log('  A has | A deposits into | users sharing a bucket with A | fetchers per deposit bucket | real contacts in overlap top-k | chance');
const resid = {};
for (const c of [3, 10, 50]) {
  const r = residual(1000, c, 5);
  resid[c] = r;
  console.log(`  ${String(c).padStart(5)} | ${r.buckets.toFixed(1).padStart(15)} | ${(r.touching).toFixed(0).padStart(5)} of 999 (${(r.touching / 9.99).toFixed(0)} %)${' '.repeat(9)} | ${r.perEdge.toFixed(0).padStart(27)} | ${(r.precision * 100).toFixed(1).padStart(28)} % | ${(r.chance * 100).toFixed(1)} %`);
}
assert(resid[10].touching > 500, 'at 10 contacts, most users share a bucket with the sender: overlap is near-universal');
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
