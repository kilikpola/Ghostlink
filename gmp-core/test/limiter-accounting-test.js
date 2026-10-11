/**
 * Rate limiter connection accounting:
 *
 *  1. outbound dials: the dialler's count returns to 0, not -N
 *  2. inbound: the listener's count rises by N while connected, returns to 0
 *
 * Run with: node test/limiter-accounting-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const net = new MemoryNetwork();
async function mk(seed) {
  const n = createGMPNode({ port: 0, transport: new MemoryTransport(net), disableBootstrap: true });
  n.on('error', () => {});
  await n.loadIdentity(seed);
  await n.listen();
  return n;
}

const server = await mk('limiter accounting server');
const clients = [];
for (let i = 0; i < 5; i++) clients.push(await mk(`limiter accounting client ${i}`));
const dialler = await mk('limiter accounting dialler');

console.log('\n=== 1. outbound: the dialler dials 5 peers, then all close ===');
{
  const links = [];
  for (const c of clients) links.push((await dialler.dial('memory', c.port)).link);
  await delay(100);
  const during = dialler.rateLimiter.getStats().globalCount;
  for (const l of links) l.destroy();
  await delay(200);
  const after = dialler.rateLimiter.getStats().globalCount;
  console.log(`  dialler global count: ${during} while connected, ${after} after close`);
  assert(after === 0, `outbound closes do not drive the count negative (after = ${after})`);
}

console.log('\n=== 2. inbound: 5 peers dial the server, then all close ===');
{
  const links = [];
  for (const c of clients) links.push((await c.dial('memory', server.port)).link);
  await delay(100);
  const during = server.rateLimiter.getStats().globalCount;
  for (const l of links) l.destroy();
  await delay(200);
  const after = server.rateLimiter.getStats().globalCount;
  console.log(`  server global count: ${during} while connected, ${after} after close`);
  assert(during === 5, `each inbound connection is counted (during = ${during})`);
  assert(after === 0, `and released on close (after = ${after})`);
}

for (const n of [server, dialler, ...clients]) n.close();
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
