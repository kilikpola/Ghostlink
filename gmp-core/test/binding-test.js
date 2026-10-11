import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { RateLimiter } from '../dist/rate-limiter.js';
import { queryPublicAddress } from '../dist/public-peer-list.js';
import net from 'net';
import crypto from 'crypto';

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

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testBasicBindingExchange() {
  console.log('\n=== Test 1: Basic Binding Query over localhost ===');

  const nodeA = createGMPNode({ port: 49600, isPublicPeer: true });
  const nodeB = createGMPNode({ port: 49601 });

  await nodeA.loadIdentity('binding test seed public peer');
  await nodeB.loadIdentity('binding test seed client');

  await nodeA.listen();
  console.log('  Public Peer listening on port 49600');

  let bindingResponseReceived = null;

  nodeB.on('connection', ({ link }) => {
    link.on('binding-response', (info) => {
      console.log(`  Client received binding response: ${JSON.stringify(info)}`);
      bindingResponseReceived = info;
    });

    link.sendBindingRequest();
  });

  const { link: clientLink } = await nodeB.dial('127.0.0.1', 49600);
  await delay(500);

  assert(bindingResponseReceived !== null, 'Received BINDING_RESPONSE');
  assert(
    bindingResponseReceived.address === '127.0.0.1' ||
    bindingResponseReceived.address === '::ffff:127.0.0.1' ||
    bindingResponseReceived.address === '::1',
    `Observed address is localhost (got ${bindingResponseReceived.address})`
  );
  assert(bindingResponseReceived.port > 0, 'Observed port is valid');

  clientLink.destroy();
  nodeA.close();
  nodeB.close();
}

async function testPublicPeerQueryConsensus() {
  console.log('\n=== Test 2: queryPublicAddress with Consensus ===');

  const nodeA = createGMPNode({ port: 49602, isPublicPeer: true });
  const nodeB = createGMPNode({ port: 49603 });

  await nodeA.loadIdentity('consensus test public peer');
  await nodeB.loadIdentity('consensus test client');

  await nodeA.listen();

  const peerList = [
    { address: '127.0.0.1', port: 49602 }
  ];

  const result = await queryPublicAddress(nodeB, peerList);
  console.log(`  Consensus public address result: ${JSON.stringify(result)}`);

  assert(result !== null, 'Consensus query returned a result');
  assert(
    result.address === '127.0.0.1' ||
    result.address === '::ffff:127.0.0.1' ||
    result.address === '::1',
    `Consensus address is localhost (got ${result.address})`
  );
  assert(result.port > 0, 'Consensus port is valid');

  nodeA.close();
  nodeB.close();
}

async function testStrictRateLimitingForBinding() {
  console.log('\n=== Test 3: Stricter rate limit on unestablished peers ===');

  const bindingRateLimiter = new RateLimiter({
    ratePerMinute: 2,
    burst: 2,
    maxGlobal: 20,
  });

  const nodeA = createGMPNode({
    port: 49604,
    isPublicPeer: true,
    bindingRateLimiter,
  });

  await nodeA.loadIdentity('rate limit public peer');
  await nodeA.listen();

  let rateLimitEmitted = false;
  nodeA.on('rate-limited', ({ ip, type }) => {
    console.log(`  Rate limited: type=${type} ip=${ip}`);
    rateLimitEmitted = true;
  });

  // Open 2 connections from localhost
  const socket1 = new net.Socket();
  await new Promise(resolve => socket1.connect(49604, '127.0.0.1', resolve));
  console.log('  Connection 1 opened');

  const socket2 = new net.Socket();
  await new Promise(resolve => socket2.connect(49604, '127.0.0.1', resolve));
  console.log('  Connection 2 opened');

  // Third connection should be rejected by the binding rate limiter (bucket of 2)
  const socket3Closed = new Promise((resolve) => {
    const socket3 = new net.Socket();
    socket3.connect(49604, '127.0.0.1', () => {
      socket3.destroy();
    });
    socket3.on('close', resolve);
  });
  await socket3Closed;
  console.log('  Connection 3 closed immediately (rate limited)');

  await delay(200);
  assert(rateLimitEmitted, 'Rate-limited event was emitted by the node');

  socket1.destroy();
  socket2.destroy();
  nodeA.close();
}

async function testEstablishedPeerExemption() {
  console.log('\n=== Test 4: Established Peer Exemption ===');

  const bindingLimiter = new RateLimiter({
    ratePerMinute: 1,
    burst: 1, // Only 1 unestablished connection allowed per IP!
    maxGlobal: 10,
  });

  const normalLimiter = new RateLimiter({
    ratePerMinute: 10,
    burst: 10, // Normal peers can have more connections
    maxGlobal: 100,
  });

  // Node B loads its identity properly: dialling needs the ephemeral source
  // loadIdentity builds, so a hand-assigned identity is refused.
  const nodeB = createGMPNode({ port: 49606, rateLimiter: normalLimiter });
  const nodeBIdentity = await nodeB.loadIdentity('exemption test node B identity');
  const peerNodeIdHex = Buffer.from(nodeBIdentity.nodeId).toString('hex');

  const nodeA = createGMPNode({
    port: 49605,
    isPublicPeer: true,
    establishedPeers: new Set([peerNodeIdHex]),
    bindingRateLimiter: bindingLimiter,
    rateLimiter: normalLimiter,
  });

  await nodeA.loadIdentity('exemption test public peer');
  await nodeA.listen();


  // Let Node B connect. Node B is established, so it should be exempted once handshake is complete
  const { link: linkB } = await nodeB.dial('127.0.0.1', 49605);
  console.log('  Node B successfully connected and handshaked');

  await delay(200);

  // Since Node B is exempted, the binding limiter's active IP count for localhost should go back down,
  // allowing another connection (like an unestablished socket) to connect.
  const socket = new net.Socket();
  const socketConnected = new Promise((resolve, reject) => {
    socket.connect(49605, '127.0.0.1', resolve);
    socket.on('error', reject);
  });

  await socketConnected;
  console.log('  New unestablished socket successfully connected (exemption worked)');

  socket.destroy();
  linkB.destroy();
  nodeA.close();
  nodeB.close();
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2b-i — Binding Protocol & Public Peer Tests     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testBasicBindingExchange();
    await testPublicPeerQueryConsensus();
    await testStrictRateLimitingForBinding();
    await testEstablishedPeerExemption();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error('\nTest suite error:', err);
    console.error(err.stack);
    // Count the throw as a failure. Without this a suite that crashed
    // mid-run still exited 0, so a broken API read as a pass.
    testsFailed++;
  }

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
