/**
 * HELLO / handshake timeouts on the production construction path:
 *
 *  1. silent inbound sockets are closed after GMP_HELLO_TIMEOUT_MS
 *  2. an honest peer still completes a handshake
 *
 * Run with: node test/handshake-timeout-default-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import net from 'net';

import { GMPNodeManager } from '../dist/gmp-node-manager.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const HELLO_TIMEOUT_MS = 600;

function manager(seed) {
  return new GMPNodeManager({
    seedPhrase: seed,
    GMP_PORT: 0,
    GMP_LAN_DISCOVERY: false,
    GMP_METRICS_ENABLED: false,
    GMP_HELLO_TIMEOUT_MS: HELLO_TIMEOUT_MS,
    GMP_HANDSHAKE_TIMEOUT_MS: HELLO_TIMEOUT_MS,
    disableBootstrap: true,
  });
}

const server = manager('handshake timeout default server');
await server.start();
const node = server.node;
const port = node.port;

console.log('\n=== 1. silent inbound sockets are closed after the HELLO timeout ===');
{
  const N = 30;
  const socks = [];
  for (let i = 0; i < N; i++) {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.isClosed = false;
    s.on('close', () => { s.isClosed = true; });
    socks.push(s);
  }
  await delay(200);
  const openEarly = socks.filter((s) => !s.isClosed).length;
  assert(openEarly === N, `all ${N} silent sockets were admitted (no admission cap by default; ${openEarly} open)`);
  await delay(HELLO_TIMEOUT_MS * 3);
  const stillOpen = socks.filter((s) => !s.isClosed).length;
  console.log(`  after ${(HELLO_TIMEOUT_MS * 3 + 200) / 1000}s silent: ${stillOpen}/${N} sockets still open, node.links=${node.links.size}`);
  assert(stillOpen === 0, `every silent socket was closed by the HELLO timeout (${stillOpen} still open)`);
  assert(node.links.size === 0, `no half-open link left behind (${node.links.size})`);
  socks.forEach((s) => s.destroy());
}

console.log('\n=== 2. an honest peer still connects ===');
{
  const client = manager('handshake timeout default client');
  await client.start();
  let err = null;
  try { await client.node.dial('127.0.0.1', port); } catch (e) { err = e; }
  assert(!err, `honest dial completes the handshake${err ? ` (${err.message})` : ''}`);
  await delay(HELLO_TIMEOUT_MS * 2);
  const live = [...node.links.values()].filter((l) => l.state === 'connected').length;
  assert(live === 1, `the established link outlives the HELLO/handshake timeouts (${live} connected)`);
  await client.stop();
}

await server.stop();
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
