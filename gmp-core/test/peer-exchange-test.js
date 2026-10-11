/**
 * GMP Peer Exchange Test Suite — Phase 4
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const tempCachePath = path.join(__dirname, 'data', 'temp-peer-exchange-cache.json');

function cleanTempCache() {
  if (fs.existsSync(tempCachePath)) {
    try {
      fs.unlinkSync(tempCachePath);
    } catch (e) {}
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 4 — Peer Exchange Tests                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempCache();

    await testAutomaticQuery();
    await testFilterAndLimitResponses();
    await testRequestRateLimiting();
    await testCandidatePoolPopulation();

    cleanTempCache();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempCache();
    process.exit(1);
  }
}

async function testAutomaticQuery() {
  console.log('\n=== Test 1: Automatic Query on Connection ===');

  const nodeA = createGMPNode({ port: 49950, peerCachePath: tempCachePath });
  const nodeB = createGMPNode({ port: 49951, peerCachePath: tempCachePath });

  await nodeA.loadIdentity('peer exch automatic A');
  await nodeB.loadIdentity('peer exch automatic B');

  await nodeA.listen();
  await nodeB.listen();

  let peerRequestReceived = false;
  const originalHandle = nodeA.peerExchange.handlePeerRequest;
  nodeA.peerExchange.handlePeerRequest = function(link, msg) {
    peerRequestReceived = true;
    return originalHandle.call(this, link, msg);
  };

  await nodeB.dial('127.0.0.1', 49950);

  // PEER_REQUEST should be sent after 500ms
  await delay(800);

  assert(peerRequestReceived, "PEER_REQUEST was automatically sent 500ms after connection");

  nodeA.close();
  nodeB.close();
}

async function testFilterAndLimitResponses() {
  console.log('\n=== Test 2: Filter and Limit Responses ===');

  const nodeA = createGMPNode({ port: 49952, peerCachePath: tempCachePath });
  await nodeA.loadIdentity('peer exch filter A');

  // Populate cache with multiple entries (some direct within 24h, some direct old)
  const now = Date.now();
  nodeA.peerCache.cache = [
    { nodeId: '11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111', address: '127.0.0.1', port: 50001, firstSeen: now, lastSeen: now, connectionCount: 1, lastFailedAt: null, failureCount: 0 },
    { nodeId: '22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222', address: '127.0.0.1', port: 50002, firstSeen: now, lastSeen: now - 30 * 60 * 60 * 1000, connectionCount: 1, lastFailedAt: null, failureCount: 0 }, // direct but >24h old
    { nodeId: '33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333', address: '127.0.0.1', port: 50003, firstSeen: now, lastSeen: now, connectionCount: 1, lastFailedAt: null, failureCount: 0 } // direct within 24h
  ];

  // Requesting peer is node_one
  const mockLink = {
    remoteNodeId: Buffer.from('11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111', 'hex'),
    state: 'connected',
    sendPeerResponse(peers) {
      this.sentPeers = peers;
    }
  };

  nodeA.peerExchange.handlePeerRequest(mockLink, { maxPeers: 10 });
  
  assert(mockLink.sentPeers !== undefined, "Response was sent");
  assertEqual(mockLink.sentPeers.length, 1, "Only 1 eligible peer returned (node_one excluded, node_two excluded as older than 24h)");
  assertEqual(mockLink.sentPeers[0].nodeId, '33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333', "Returned peer matches node_three");

  nodeA.close();
}

async function testRequestRateLimiting() {
  console.log('\n=== Test 3: Request Rate Limiting ===');

  const nodeA = createGMPNode({ port: 49954, peerCachePath: tempCachePath });
  await nodeA.loadIdentity('peer exch limit A');

  let responseCount = 0;
  const mockLink = {
    remoteNodeId: Buffer.from('11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111', 'hex'),
    state: 'connected',
    sendPeerResponse(peers) {
      responseCount++;
    }
  };

  // Send first request
  nodeA.peerExchange.handlePeerRequest(mockLink, { maxPeers: 10 });
  assertEqual(responseCount, 1, "First request accepted and answered");

  // Send second request immediately
  nodeA.peerExchange.handlePeerRequest(mockLink, { maxPeers: 10 });
  assertEqual(responseCount, 1, "Second request within 60s ignored");

  nodeA.close();
}

async function testCandidatePoolPopulation() {
  console.log('\n=== Test 4: Candidate Pool Population ===');

  const nodeA = createGMPNode({ port: 49956, peerCachePath: tempCachePath });
  await nodeA.loadIdentity('peer exch cand A');

  const mockLink = {
    remoteNodeId: Buffer.from('11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111', 'hex'),
    state: 'connected'
  };

  const responseMsg = {
    peers: [
      { nodeId: '22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222', address: '127.0.0.1', port: 50002, lastSeen: Date.now() },
      { nodeId: '33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333', address: '127.0.0.1', port: 50003, lastSeen: Date.now() }
    ]
  };

  assertEqual(nodeA.peerExchange.candidatePool.size, 0, "Candidate pool initially empty");
  
  nodeA.peerExchange.handlePeerResponse(mockLink, responseMsg);

  assertEqual(nodeA.peerExchange.candidatePool.size, 2, "Unconnected peers from response added to candidate pool");
  assert(nodeA.peerExchange.candidatePool.has('22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222'), "Pool contains node_two");

  // A peer controls the size of its response; the pool must stay bounded.
  for (let r = 0; r < 60; r++) {
    const peers = [];
    for (let i = 0; i < 1000; i++) {
      peers.push({ nodeId: `${r}-${i}`.padStart(128, 'f'), address: '10.0.0.1', port: 49500, lastSeen: Date.now() });
    }
    nodeA.peerExchange.handlePeerResponse(mockLink, { peers });
  }
  assert(nodeA.peerExchange.candidatePool.size <= 500, `Candidate pool stays bounded under oversized responses (size ${nodeA.peerExchange.candidatePool.size})`);

  nodeA.close();
}

runTests();
