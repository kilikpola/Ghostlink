/**
 * GMP Two-Node Test Harness
 *
 * 1. Basic connection: two nodes, A listens on 49500, B dials A
 * 2. Handshake completes, both sides report correct peer NodeID
 * 3. DATA messages both directions (encryption works)
 * 3a. NodeID Mismatch Rejection (forged identity rejected)
 * 3b. Timestamp-Based Replay Protection (stale HELLO rejected)
 * 4. Forged signature rejection
 * 5. Multiple simultaneous connections
 * 6. Keepalive (PING/PONG)
 * 7. Session key uniqueness check
 * 8. Rate limiting
 *
 * Run: node test/two-node-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { SessionKeyLRUSet } from '../dist/link.js';
import { createGMPNode } from '../dist/node-factory.js';
import { signMessage } from '../dist/identity.js';
import { RateLimiter } from '../dist/rate-limiter.js';
import net from 'net';
import crypto from 'crypto';

const TEST_SEED_A = 'ghost mesh protocol test seed phrase node a';
const TEST_SEED_B = 'ghost mesh protocol test seed phrase node b';

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

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

function assertContains(haystack, needle, message) {
  testsRun++;
  if (haystack.includes(needle)) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message} (expected to contain: ${needle})`);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testBasicConnection() {
  console.log('\n=== Test 1: Basic Connection and Handshake ===');

  const nodeA = createGMPNode({ port: 49500 });
  const nodeB = createGMPNode({ port: 49501 });

  const identityA = await nodeA.loadIdentity(TEST_SEED_A);
  const identityB = await nodeB.loadIdentity(TEST_SEED_B);

  console.log(`  Node A NodeID: ${Buffer.from(identityA.nodeId).toString('hex').slice(0, 32)}...`);
  console.log(`  Node B NodeID: ${Buffer.from(identityB.nodeId).toString('hex').slice(0, 32)}...`);

  await nodeA.listen();
  console.log('  Node A listening on port 49500');

  let connectedEventA = null;
  let connectedEventB = null;
  let peerNodeIdA = null;
  let peerNodeIdB = null;

  nodeA.on('connection', ({ connId, link, peerNodeId, type }) => {
    console.log(`  Node A: ${type} connection, peer NodeID: ${Buffer.from(peerNodeId).toString('hex').slice(0, 32)}...`);
    connectedEventA = { connId, link, peerNodeId, type };
    peerNodeIdA = peerNodeId;
  });

  nodeB.on('connection', ({ connId, link, peerNodeId, type }) => {
    console.log(`  Node B: ${type} connection, peer NodeID: ${Buffer.from(peerNodeId).toString('hex').slice(0, 32)}...`);
    connectedEventB = { connId, link, peerNodeId, type };
    peerNodeIdB = peerNodeId;
  });

  const dialPromise = nodeB.dial('127.0.0.1', 49500);
  const result = await dialPromise;
  console.log(`  Node B dial result: connId=${result.connId}`);

  await delay(500);

  assert(connectedEventA !== null, 'Node A received connection event');
  assert(connectedEventB !== null, 'Node B connection succeeded');
  assertEqual(connectedEventB.type, 'outgoing', 'Node B is outgoing connection');
  assertEqual(connectedEventA.type, 'incoming', 'Node A received incoming connection');

  assert(peerNodeIdA !== null, 'Node A knows peer NodeID');
  assert(peerNodeIdB !== null, 'Node B knows peer NodeID');

  const nodeIdAFromB = Buffer.from(peerNodeIdB).toString('hex');
  const nodeIdAExpected = Buffer.from(identityA.nodeId).toString('hex');
  assertEqual(nodeIdAFromB, nodeIdAExpected, 'Node B sees Node A\'s correct NodeID');

  const nodeIdBFromA = Buffer.from(peerNodeIdA).toString('hex');
  const nodeIdBExpected = Buffer.from(identityB.nodeId).toString('hex');
  assertEqual(nodeIdBFromA, nodeIdBExpected, 'Node A sees Node B\'s correct NodeID');

  return { nodeA, nodeB, linkA: connectedEventA?.link, linkB: connectedEventB?.link };
}

async function testDataMessaging(linkA, linkB) {
  console.log('\n=== Test 2: DATA Message Encryption ===');

  let msgReceivedByA = null;
  let msgReceivedByB = null;

  linkA.on('message', (msg) => {
    console.log(`  Link A received: "${msg}"`);
    msgReceivedByA = msg;
  });

  linkB.on('message', (msg) => {
    console.log(`  Link B received: "${msg}"`);
    msgReceivedByB = msg;
  });

  const testMsgAtoB = 'Hello from Node A!';
  await linkB.send(testMsgAtoB);
  console.log(`  Link B sent: "${testMsgAtoB}"`);
  await delay(200);

  assert(msgReceivedByA === testMsgAtoB, 'Link A received correct message from Link B');

  const testMsgBtoA = 'Response from Node B!';
  await linkA.send(testMsgBtoA);
  console.log(`  Link A sent: "${testMsgBtoA}"`);
  await delay(200);

  assert(msgReceivedByB === testMsgBtoA, 'Link B received correct message from Link A');

  return { linkA, linkB };
}

async function testNodeIdMismatch() {
  console.log('\n=== Test 3a: NodeID Mismatch Rejection ===');

  const nodeServer = createGMPNode({ port: 49502 });
  await nodeServer.loadIdentity('nodeid mismatch test server');

  let errorMessage = null;

  nodeServer.on('error', ({ connId, err }) => {
    console.log(`  Server: error on ${connId}: ${err.message}`);
    errorMessage = err.message;
  });

  await nodeServer.listen();
  console.log('  Server listening on port 49502');

  await new Promise((resolve) => {
    const fakeSocket = new net.Socket();
    fakeSocket.connect(49502, '127.0.0.1', () => {
      console.log('  Sending HELLO with random garbage (invalid NodeID)...');
      const fakeHelloPayload = Buffer.alloc(265);
      crypto.randomFillSync(fakeHelloPayload);
      fakeHelloPayload[0] = 0x01; // valid version
      fakeHelloPayload.writeBigUInt64BE(BigInt(Date.now()), 161);

      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(265, 0);
      const fakeFrame = Buffer.concat([lenBuf, Buffer.from([0x01]), fakeHelloPayload]);

      fakeSocket.write(fakeFrame);
    });
    fakeSocket.on('close', resolve);
    setTimeout(resolve, 2000);
  });

  await delay(200);
  assert(errorMessage !== null, 'Error was emitted for NodeID mismatch');
  assertContains(errorMessage, 'NodeID does not match SHA-512', 'Error specifically mentions NodeID mismatch');

  nodeServer.close();
  return true;
}

async function testTimestampReplay() {
  console.log('\n=== Test 3b: Timestamp-Based Replay Protection ===');

  const nodeServer = createGMPNode({ port: 49511 });
  const nodeClient = createGMPNode({ port: 49512 });

  await nodeServer.loadIdentity('timestamp replay server');
  // The stale HELLO must come from someone else: a HELLO carrying the
  // server's own NodeID is refused earlier, as a reflection.
  const clientIdentity = await nodeClient.loadIdentity('timestamp replay client');

  let errorMessage = null;

  nodeServer.on('error', ({ connId, err }) => {
    console.log(`  Server: error on ${connId}: ${err.message}`);
    errorMessage = err.message;
  });

  await nodeServer.listen();
  console.log('  Server listening on port 49511');

  await new Promise(async (resolve) => {
    const fakeSocket = new net.Socket();
    fakeSocket.connect(49511, '127.0.0.1', async () => {
      console.log('  Sending HELLO with stale timestamp (>10 minutes ago)...');

      const oldTimestamp = Date.now() - (10 * 60 * 1000);
      const fakeHelloPayload = Buffer.alloc(265);

      fakeHelloPayload[0] = 0x01; // valid version
      fakeHelloPayload.set(Buffer.from(clientIdentity.nodeId), 1);
      fakeHelloPayload.set(Buffer.from(clientIdentity.staticPubKey), 65);
      fakeHelloPayload.set(Buffer.from(clientIdentity.signingPubKey), 97);
      fakeHelloPayload.set(Buffer.from(crypto.randomBytes(32)), 129);
      fakeHelloPayload.writeBigUInt64BE(BigInt(oldTimestamp), 161);
      fakeHelloPayload.set(crypto.randomBytes(32), 169);

      const signedPortion = fakeHelloPayload.slice(0, 201);
      const signature = signMessage(
        new Uint8Array(clientIdentity.signingPrivKey),
        new Uint8Array(signedPortion)
      );
      fakeHelloPayload.set(Buffer.from(signature), 201);

      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(265, 0);
      const fakeFrame = Buffer.concat([lenBuf, Buffer.from([0x01]), fakeHelloPayload]);

      fakeSocket.write(fakeFrame);
    });
    fakeSocket.on('close', resolve);
    setTimeout(resolve, 2000);
  });

  await delay(200);
  assert(errorMessage !== null, 'Error was emitted for stale timestamp');
  assertContains(errorMessage, 'timestamp out of range', 'Error specifically mentions timestamp rejection');

  nodeServer.close();
  nodeClient.close();
  return true;
}

async function testForgedSignature() {
  console.log('\n=== Test 4: Forged Signature Rejection ===');

  const nodeServer = createGMPNode({ port: 49503 });
  const tempNode = createGMPNode();

  await nodeServer.loadIdentity('forged sig test server');
  const tempIdentity = await tempNode.loadIdentity('forged sig test temp client');

  await nodeServer.listen();

  let connectionError = null;
  nodeServer.on('error', ({ connId, err }) => {
    console.log(`  Server: connection error: ${err.message}`);
    connectionError = err;
  });

  await new Promise(async (resolve) => {
    const fakeSocket = new net.Socket();

    fakeSocket.connect(49503, '127.0.0.1', async () => {
      console.log('  Sending HELLO with valid NodeID but forged signature...');

      const fakeHelloPayload = Buffer.alloc(265);
      fakeHelloPayload[0] = 0x01; // valid version
      // Fill correct NodeID matching the temporary client's staticPubkey
      fakeHelloPayload.set(Buffer.from(tempIdentity.nodeId), 1);
      fakeHelloPayload.set(Buffer.from(tempIdentity.staticPubKey), 65);
      fakeHelloPayload.set(Buffer.from(tempIdentity.signingPubKey), 97);
      fakeHelloPayload.set(Buffer.from(crypto.randomBytes(32)), 129); // ephemeral pubkey
      fakeHelloPayload.writeBigUInt64BE(BigInt(Date.now()), 161);
      fakeHelloPayload.set(crypto.randomBytes(32), 169); // nonce
      // Forge signature (invalid signature bytes)
      fakeHelloPayload.set(crypto.randomBytes(64), 201);

      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(265, 0);
      const fakeFrame = Buffer.concat([lenBuf, Buffer.from([0x01]), fakeHelloPayload]);

      fakeSocket.write(fakeFrame);
    });

    fakeSocket.on('close', resolve);
    setTimeout(resolve, 2000);
  });

  await delay(500);

  assert(connectionError !== null, 'Error was emitted for forged signature');
  if (connectionError) {
    assertContains(connectionError.message, 'signature verification failed', 'Error specifically mentions signature verification failure');
  }

  nodeServer.close();
  tempNode.close();
  return true;
}

async function testMultipleConnections() {
  console.log('\n=== Test 5: Multiple Simultaneous Connections ===');

  const nodeServer = createGMPNode({ port: 49505 });
  const nodeClient1 = createGMPNode({ port: 49506 });
  const nodeClient2 = createGMPNode({ port: 49507 });

  await nodeServer.loadIdentity('multi server seed');
  await nodeClient1.loadIdentity('multi client1 seed');
  await nodeClient2.loadIdentity('multi client2 seed');

  await nodeServer.listen();
  console.log('  Server listening on 49505');

  const connections = [];
  const messages = [];

  nodeServer.on('connection', ({ link, peerNodeId }) => {
    console.log(`  Server: new connection from ${Buffer.from(peerNodeId).toString('hex').slice(0, 16)}...`);
    connections.push(link);
    link.on('message', (msg) => {
      console.log(`  Server received: "${msg}"`);
      messages.push(msg);
    });
  });

  const link1Promise = nodeClient1.dial('127.0.0.1', 49505);
  const link2Promise = nodeClient2.dial('127.0.0.1', 49505);

  const result1 = await link1Promise;
  const result2 = await link2Promise;
  console.log(`  Client1 connected: ${result1.connId}`);
  console.log(`  Client2 connected: ${result2.connId}`);

  await delay(200);
  assertEqual(connections.length, 2, 'Server has 2 connections');

  await result1.link.send('Message from client 1');
  await result2.link.send('Message from client 2');
  await delay(200);

  assertEqual(messages.length, 2, 'Server received 2 messages');

  nodeServer.close();
  nodeClient1.close();
  nodeClient2.close();

  return true;
}

async function testKeepalive() {
  console.log('\n=== Test 6: Keepalive (PING/PONG) ===');

  const nodeA = createGMPNode({ port: 49508, pingIntervalMs: 100, pongTimeoutMs: 50 });
  const nodeB = createGMPNode({ port: 49509, pingIntervalMs: 100, pongTimeoutMs: 50 });

  await nodeA.loadIdentity('keepalive seed a');
  await nodeB.loadIdentity('keepalive seed b');

  await nodeA.listen();

  let linkA = null;
  let linkB = null;

  nodeA.on('connection', ({ link }) => {
    linkA = link;
  });

  const result = await nodeB.dial('127.0.0.1', 49508);
  linkB = result.link;

  // Wait 500ms to allow multiple PING/PONG cycles to occur
  await delay(500);

  assert(linkA !== null, 'Link A established');
  assert(linkB !== null, 'Link B established');
  assertEqual(linkA.state, 'connected', 'Link A remains connected after PING/PONG cycles');
  assertEqual(linkB.state, 'connected', 'Link B remains connected after PING/PONG cycles');

  nodeA.close();
  nodeB.close();

  return true;
}

async function testSessionKeyUniqueness() {
  console.log('\n=== Test 7: Session Key Uniqueness (LRU) ===');

  const lru = new SessionKeyLRUSet(3);

  const key1 = Buffer.alloc(32).fill(0x11);
  const key2 = Buffer.alloc(32).fill(0x22);
  const key3 = Buffer.alloc(32).fill(0x33);
  const key4 = Buffer.alloc(32).fill(0x44);

  assert(lru.add(key1) === true, 'First key added successfully');
  assert(lru.add(key2) === true, 'Second key added successfully');
  assert(lru.add(key3) === true, 'Third key added successfully');
  assert(lru.has(key1) === true, 'Key1 is in LRU');
  assert(lru.has(key2) === true, 'Key2 is in LRU');
  assert(lru.has(key3) === true, 'Key3 is in LRU');

  assert(lru.add(key4) === true, 'Fourth key added (LRU evicted oldest)');
  assert(lru.has(key1) === false, 'Key1 was evicted from LRU');
  assert(lru.has(key4) === true, 'Key4 is in LRU');

  assert(lru.add(key2) === false, 'Duplicate key2 is rejected');

  assertEqual(lru.size(), 3, 'LRU size is 3 (max)');

  lru.clear();
  assertEqual(lru.size(), 0, 'LRU cleared');

  return true;
}

async function testRateLimiting() {
  console.log('\n=== Test 8: Rate Limiting Integration ===');

  const rateLimiter = new RateLimiter({
    ratePerMinute: 2,
    burst: 2,
    maxGlobal: 100,
  });

  const nodeServer = createGMPNode({
    port: 49513,
    rateLimiter,
  });

  await nodeServer.loadIdentity('rate limit integration test');

  let rateLimitedEmitted = false;
  nodeServer.on('rate-limited', ({ ip }) => {
    console.log(`  Rate limited event: ${ip}`);
    rateLimitedEmitted = true;
  });

  await nodeServer.listen();
  console.log('  Server listening on 49513');

  const socket1 = new net.Socket();
  await new Promise((resolve) => {
    socket1.connect(49513, '127.0.0.1', resolve);
  });
  console.log('  Connection 1 accepted');

  const socket2 = new net.Socket();
  await new Promise((resolve) => {
    socket2.connect(49513, '127.0.0.1', resolve);
  });
  console.log('  Connection 2 accepted');

  const socket3Closed = new Promise((resolve) => {
    const socket3 = new net.Socket();
    socket3.connect(49513, '127.0.0.1', () => {
      socket3.destroy();
    });
    socket3.on('close', resolve);
  });
  await socket3Closed;
  console.log('  Connection 3 closed immediately (rate limited)');

  await delay(200);

  assertEqual(rateLimitedEmitted, true, 'Rate-limited event was emitted');

  socket1.destroy();
  socket2.destroy();
  nodeServer.close();
  rateLimiter.close();

  return true;
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 1+2a — Two-Node Integration Test                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    const result1 = await testBasicConnection();
    const { nodeA, nodeB, linkA, linkB } = result1;

    if (linkA && linkB) {
      await testDataMessaging(linkA, linkB);
    } else {
      console.log('  ⚠ Skipping DATA test - connection failed');
    }

    await testNodeIdMismatch();
    await testTimestampReplay();
    await testForgedSignature();
    await testMultipleConnections();
    await testKeepalive();
    await testSessionKeyUniqueness();
    await testRateLimiting();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (linkA) linkA.destroy();
    if (linkB) linkB.destroy();
    nodeA.close();
    nodeB.close();

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