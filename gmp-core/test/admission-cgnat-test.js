/**
 * Inbound admission vs CGNAT, against a production-built node's limiter with a
 * simulated clock:
 *
 *  1. 200 connections from one address over 60 s: all admitted
 *  2. 5000 from one address within 1 s: rate-limited once the bucket empties,
 *     never by a per-address head count
 *  3. another address is unaffected by (2)
 *  4. past the global cap: refused with global-cap-reached, no token spent
 *  5. IPv6: one /64 shares a bucket; another /64 does not
 *
 * Run: node test/admission-cgnat-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { admissionKey } from '../dist/rate-limiter.js';
import { requesterKey } from '../dist/topology-sample.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const { assertAbsent } = absenceAsserter(assert);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const CAP = DEFAULTS.GMP_RATE_LIMIT_MAX_GLOBAL;
const BURST = DEFAULTS.GMP_INBOUND_BURST;
const RATE = DEFAULTS.GMP_INBOUND_RATE_PER_MINUTE;
console.log(`defaults: global cap ${CAP}, per-address bucket ${BURST} refilling ${RATE}/min`);

function freshLimiter() {
  const node = createGMPNode({ transport: new MemoryTransport(new MemoryNetwork()), port: 0 });
  node.on('error', () => {});
  return { node, limiter: node.rateLimiter };
}

console.log('\n=== 1. 200 connections from one address, arriving over 60 s ===');
{
  const net = new MemoryNetwork();
  const server = createGMPNode({ transport: new MemoryTransport(net), port: 0 });
  server.on('error', () => {});
  await server.loadIdentity('admission cgnat server');
  await server.listen();
  let clock = 10_000_000;
  server.rateLimiter.clock = () => clock;
  const refused = [];
  server.on('rate-limited', (e) => refused.push(e.type));
  server.rateLimiter.on('rate-limited', (e) => refused.push(e.reason));
  // Raw connections from the one MemoryTransport address ('memory.local'):
  // admission is decided on accept, before any handshake.
  const client = new MemoryTransport(net);
  const conns = [];
  for (let i = 0; i < 200; i++) {
    clock += 300; // 200 x 300 ms = 60 s of limiter time
    conns.push(await client.dial({ host: 'memory', port: server.port }));
    await delay(1);
  }
  await delay(50);
  const admitted = server.rateLimiter.getStats().globalCount;
  assert(admissionKey('memory.local') === 'memory.local' && new Set(conns.map(() => 'memory.local')).size === 1, 'all 200 come from one address');
  assert(refused.length === 0 && admitted === 200, `all 200 admitted (${admitted} held, ${refused.length} refused${refused.length ? ': ' + [...new Set(refused)].join(', ') : ''})`);
  for (const c of conns) c.destroy?.();
  server.close();
}

console.log('\n=== 2. 5000 from one address within 1 s ===');
{
  const { node, limiter } = freshLimiter();
  let clock = 20_000_000;
  limiter.clock = () => clock;
  const reasons = {};
  limiter.on('rate-limited', (e) => { reasons[e.reason] = (reasons[e.reason] || 0) + 1; });
  let admitted = 0;
  for (let i = 0; i < 5000; i++) {
    clock += 0.2; // 5000 x 0.2 ms = 1 s
    // Closed immediately, so the global cap never binds: this measures the rate.
    if (limiter.checkConnection({ remoteAddress: '203.0.113.7' })) { admitted++; limiter.recordConnectionClosed(`c${i}`); }
  }
  const refusedN = 5000 - admitted;
  const expectedMax = BURST + Math.ceil(RATE / 60); // burst + at most 1 s of refill
  console.log(`  admitted ${admitted}, refused ${refusedN} ${JSON.stringify(reasons)}`);
  assert(admitted >= BURST && admitted <= expectedMax, `admitted the burst and ~1 s of refill (${admitted}, expected ${BURST}..${expectedMax})`);
  assert(reasons['address-rate'] === refusedN && !reasons['global-cap-reached'], 'every refusal is the address rate, none a head count');
  node.close();

  console.log('\n=== 3. another address is unaffected ===');
  const other = limiter.checkConnection({ remoteAddress: '198.51.100.9' });
  assert(other, 'a different address is admitted while the first is rate-limited');
}

console.log('\n=== 4. the global concurrent cap ===');
{
  const { node, limiter } = freshLimiter();
  let clock = 30_000_000;
  limiter.clock = () => clock;
  const reasons = {};
  limiter.on('rate-limited', (e) => { reasons[e.reason] = (reasons[e.reason] || 0) + 1; });
  let admitted = 0;
  // Many addresses, so the per-address bucket never binds.
  for (let i = 0; i < CAP + 10; i++) {
    clock += 1;
    if (limiter.checkConnection({ remoteAddress: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` })) admitted++;
  }
  assert(admitted === CAP, `exactly the cap (${CAP}) held concurrently (${admitted})`);
  assert(reasons['global-cap-reached'] === 10 && !reasons['address-rate'], `the 10 past it refused as global-cap-reached (${JSON.stringify(reasons)})`);
  // A refusal for capacity spends no token: one address at the cap, then room.
  const lone = '192.0.2.44';
  for (let i = 0; i < BURST + 5; i++) limiter.checkConnection({ remoteAddress: lone }); // all refused: cap
  limiter.recordConnectionClosed('x');
  assert(limiter.checkConnection({ remoteAddress: lone }), 'once there is room, an address refused only for capacity still has its whole bucket');
  node.close();
}

console.log('\n=== 6. running out of tokens refuses new connections — it bans nobody ===');
{
  // End to end through a node: one address opens more than the burst. The
  // over-budget connections are refused; the ones already admitted must stay,
  // and the address must not be banned (behind CGNAT that address is hundreds
  // of subscribers). Found by the M5-1c capacity run: every refusal banned the
  // IP for 24 h and destroyed every link from it.
  const net = new MemoryNetwork();
  const server = createGMPNode({ transport: new MemoryTransport(net), port: 0 });
  server.on('error', () => {});
  await server.loadIdentity('admission no-ban server');
  await server.listen();
  let clock = 40_000_000;
  server.rateLimiter.clock = () => clock;
  const client = new MemoryTransport(net);
  const conns = [];
  for (let i = 0; i < BURST + 20; i++) {
    const c = await client.dial({ host: 'memory', port: server.port });
    c.closed = false;
    c.on('close', () => { c.closed = true; });
    conns.push(c);
  }
  await delay(100);
  const admitted = conns.slice(0, BURST);
  const stillOpen = admitted.filter((c) => !c.closed).length;
  console.log(`  ${conns.length} from one address: ${stillOpen}/${BURST} admitted still open, ${conns.slice(BURST).filter((c) => c.closed).length}/20 over budget refused`);
  assert(stillOpen === BURST, `every admitted connection stays open when the address runs out of tokens (${stillOpen}/${BURST})`);
  assertAbsent({
    channel: 'reputation.isBanned',
    control: () => { server.reputation.ban(null, '198.51.100.9', 'positive control'); return server.reputation.isBanned(null, '198.51.100.9'); },
    controlMessage: 'isBanned reports an address that IS banned',
    absent: () => !server.reputation.isBanned(null, 'memory.local'),
    message: 'the address is not banned',
  });
  clock += 60_000; // a minute of refill
  const later = await client.dial({ host: 'memory', port: server.port });
  later.closed = false;
  later.on('close', () => { later.closed = true; });
  await delay(50);
  assert(!later.closed, 'once tokens refill, the same address connects again');
  for (const c of [...conns, later]) c.destroy?.();
  server.close();
}

console.log('\n=== 5. IPv6 keys by /64 ===');
{
  assert(admissionKey('2001:db8:1:2::1') === admissionKey('2001:db8:1:2:ffff::9'), 'two addresses in one /64 share a key');
  assert(admissionKey('2001:db8:1:2::1') !== admissionKey('2001:db8:1:3::1'), 'a different /64 has its own key');
  assert(admissionKey('::ffff:203.0.113.7') === '203.0.113.7', 'IPv4-mapped IPv6 keys as the IPv4 address');
  // Two mobile devices, each with its own /64 from one carrier /48: separate
  // rate buckets, but ONE membership sample (requesterKey /48).
  const devA = '2001:db8:1:2::1', devB = '2001:db8:1:3::1';
  assert(admissionKey(devA) !== admissionKey(devB), 'rate limit: two /64s in one /48 are NOT grouped');
  const req = (ip) => requesterKey({ socket: { remoteAddress: ip } });
  assert(req(devA) === req(devB), 'membership sample: two /64s in one /48 share a requester key');
  assert(req(devA) !== req('2001:db8:2:2::1'), 'membership sample: a different /48 has its own key');
  console.log(`  side by side: admissionKey ${admissionKey(devA)} | requesterKey ${req(devA)}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
