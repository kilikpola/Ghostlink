/**
 * GMP Key Rotation Test Suite — Phase 5
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
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

const tempCacheAPath = path.join(__dirname, 'data', 'temp-rot-cache-A.json');
const tempCacheBPath = path.join(__dirname, 'data', 'temp-rot-cache-B.json');
const tempCacheCPath = path.join(__dirname, 'data', 'temp-rot-cache-C.json');

function cleanTempFiles() {
  for (const f of [tempCacheAPath, tempCacheBPath, tempCacheCPath]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 5 — Key Rotation Tests                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    await testBasicRotation();
    await delay(200);
    
    await testRotationFlood();
    await delay(200);

    await testInvalidSignatureRejected();
    await delay(200);

    await testUnknownPeerRotationRejected();
    await delay(200);

    await testPostRotationConnections();
    await delay(200);

    cleanTempFiles();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempFiles();
    process.exit(1);
  }
}

async function testBasicRotation() {
  console.log('\n=== Test 1: Basic Rotation ===');
  cleanTempFiles();

  const nodeA = createGMPNode({ port: 0, peerCachePath: tempCacheAPath, disableBootstrap: true, seedPhrase: 'rotation A seed' });
  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'rotation B seed' });

  await nodeA.loadIdentity('rotation A seed');
  await nodeB.loadIdentity('rotation B seed');

  await nodeA.listen();
  await nodeB.listen();

  // Connect A and B
  const { link: linkAB } = await nodeA.dial('127.0.0.1', nodeB.port);
  await delay(200);

  const successorIdentity = await deriveIdentityFromSeedPhrase('rotation A seed successor');

  // Rotate Node A key
  const cert = nodeA.rotateKey(successorIdentity);
  await delay(200);

  // Check that B received rotation certificate and updated A's NodeID in its peer cache
  const cachedEntry = nodeB.peerCache.cache.find(e => e.nodeId === successorIdentity.nodeIdHex);
  assert(cachedEntry !== undefined, "Connected peer B updated peer cache with new NodeID");
  assertEqual(cachedEntry.signingPubKey, successorIdentity.signingPubKeyHex, "Signing public key matches successor");
  // The NodeID peers were told to use must be the one A actually presents now.
  assertEqual(nodeA.identity.nodeIdHex, cert.newNodeId, "Rotated node operates under the NodeID its certificate announced");

  nodeA.close();
  nodeB.close();

  // newNodeId is signed: a cert whose newNodeId was rewritten after signing is
  // refused, so a relay cannot redirect the old identity somewhere else.
  const nodeC = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'rotation C seed' });
  await nodeC.loadIdentity('rotation C seed');
  const oldA = await deriveIdentityFromSeedPhrase('rotation A seed');
  nodeC.peerCache.recordSuccess(oldA.nodeIdHex, '127.0.0.1', nodeA.port, oldA.signingPubKeyHex);
  const redirected = { ...cert, newNodeId: 'f'.repeat(128) };
  nodeC.keyRotationManager.handleReceivedRotation({ cert: redirected, sequenceNumber: 99, ttl: 16 }, null);
  assert(nodeC.peerCache.cache.find(e => e.nodeId === 'f'.repeat(128)) === undefined,
    "A certificate with newNodeId altered after signing is rejected");
  nodeC.close();
}

async function testRotationFlood() {
  console.log('\n=== Test 2: Rotation Flood Only to Direct Neighbours (M6-1a) ===');
  cleanTempFiles();

  // Topology: A - B - C
  const nodeA = createGMPNode({ port: 0, peerCachePath: tempCacheAPath, disableBootstrap: true, seedPhrase: 'rot flood A' });
  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'rot flood B' });
  const nodeC = createGMPNode({ port: 0, peerCachePath: tempCacheCPath, disableBootstrap: true, seedPhrase: 'rot flood C' });

  await nodeA.loadIdentity('rot flood A');
  await nodeB.loadIdentity('rot flood B');
  await nodeC.loadIdentity('rot flood C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  // Connect A-B, B-C
  await nodeA.dial('127.0.0.1', nodeB.port);
  await nodeB.dial('127.0.0.1', nodeC.port);
  await delay(300);

  const oldNodeIdA = nodeA.identity.nodeIdHex;

  // Seed B and C's caches with Node A's old identity so they know/trust it
  nodeB.peerCache.recordSuccess(
    oldNodeIdA,
    '127.0.0.1',
    nodeA.port,
    nodeA.identity.signingPubKeyHex
  );
  nodeC.peerCache.recordSuccess(
    oldNodeIdA,
    '127.0.0.1',
    nodeA.port,
    nodeA.identity.signingPubKeyHex
  );

  const successor = await deriveIdentityFromSeedPhrase('rot flood A successor');
  nodeA.rotateKey(successor);

  await delay(500);

  // Direct neighbour B should receive and process the rotation
  const entryOnB = nodeB.peerCache.cache.find(e => e.nodeId === successor.nodeIdHex);
  assert(entryOnB !== undefined, "Direct neighbour B received rotation certificate and updated cache");
  assertEqual(entryOnB.signingPubKey, successor.signingPubKeyHex, "B's cache has correct signing key");

  // Indirect peer C (2 hops away) should NOT receive the rotation via flood
  const entryOnC = nodeC.peerCache.cache.find(e => e.nodeId === successor.nodeIdHex);
  assert(entryOnC === undefined, "Indirect peer C did NOT receive rotation via flood (M6-1a)");

  // On-demand - when C presents stale key to B, B should send rotation cert
  // Simulate C trying to connect to A via B (using stale key)
  // C's peer cache still has old NodeIdA; when it dials through B, B should send rotation
  // For this test, directly invoke handleReceivedRotation on B for a message from C
  // but since we're testing the flood behavior, we verify C's cache is unchanged

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

async function testInvalidSignatureRejected() {
  console.log('\n=== Test 3: Invalid Signature Rejected ===');
  cleanTempFiles();

  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'rot invalid B' });
  await nodeB.loadIdentity('rot invalid B');

  // Seed nodeB cache with fake Node A info
  const fakeOldNodeId = 'a'.repeat(128);
  const fakeOldSigningPubKey = 'b'.repeat(64);
  nodeB.peerCache.recordSuccess(fakeOldNodeId, '127.0.0.1', 49955, fakeOldSigningPubKey);

  // Construct tampered rotation certificate
  const cert = {
    oldNodeId: fakeOldNodeId,
    newPublicKey: 'c'.repeat(64),
    newNodeId: 'd'.repeat(128),
    rotationTimestamp: Date.now(),
    signature: 'e'.repeat(128) // Invalid signature
  };

  // Directly pass to key rotation manager
  nodeB.keyRotationManager.handleReceivedRotation({ cert, sequenceNumber: 1, ttl: 16 }, null);

  // NodeID should NOT have been replaced
  const oldEntry = nodeB.peerCache.cache.find(e => e.nodeId === fakeOldNodeId);
  assert(oldEntry !== undefined, "Old NodeID entry remains in cache");
  const newEntry = nodeB.peerCache.cache.find(e => e.nodeId === cert.newNodeId);
  assert(newEntry === undefined, "New NodeID entry not added due to invalid signature");

  nodeB.close();
}

async function testUnknownPeerRotationRejected() {
  console.log('\n=== Test 4: Unknown Peer Rotation Rejected ===');
  cleanTempFiles();

  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'rot unknown B' });
  await nodeB.loadIdentity('rot unknown B');

  // cert for an unknown old NodeID (not in cache)
  const cert = {
    oldNodeId: '1'.repeat(128),
    newPublicKey: '2'.repeat(64),
    newNodeId: '3'.repeat(128),
    rotationTimestamp: Date.now(),
    signature: '4'.repeat(128)
  };

  nodeB.keyRotationManager.handleReceivedRotation({ cert, sequenceNumber: 1, ttl: 16 }, null);

  // New NodeID should NOT be in cache
  const newEntry = nodeB.peerCache.cache.find(e => e.nodeId === cert.newNodeId);
  assert(newEntry === undefined, "Unknown peer rotation certificate ignored");

  nodeB.close();
}

async function testPostRotationConnections() {
  console.log('\n=== Test 5: Post-Rotation Connections ===');
  cleanTempFiles();

  const nodeA = createGMPNode({ port: 0, peerCachePath: tempCacheAPath, disableBootstrap: true, seedPhrase: 'post-rot A' });
  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCacheBPath, disableBootstrap: true, seedPhrase: 'post-rot B' });

  await nodeA.loadIdentity('post-rot A');
  await nodeB.loadIdentity('post-rot B');

  await nodeA.listen();
  await nodeB.listen();

  // Rotate A
  const oldNodeIdA = nodeA.identity.nodeIdHex;
  const successor = await deriveIdentityFromSeedPhrase('post-rot A successor');
  nodeA.rotateKey(successor);

  // Attempt to connect from rotated A to B. Should succeed using the new NodeID.
  const { link } = await nodeA.dial('127.0.0.1', nodeB.port);
  await delay(200);

  assertEqual(link.state, 'connected', "Handshake succeeded using rotated identity");
  assertEqual(Buffer.from(link.remoteNodeId).toString('hex'), nodeB.identity.nodeIdHex, "Connected to correct peer B");

  nodeA.close();
  nodeB.close();
}

runTests();
