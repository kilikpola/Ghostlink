/**
 * GMP Bootstrap Test Suite — Phase 4
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

const tempCachePath = path.join(__dirname, 'data', 'temp-bootstrap-cache.json');
const tempPublicPeersPath = path.join(__dirname, 'data', 'temp-public-peers.json');

function cleanTempFiles() {
  if (fs.existsSync(tempCachePath)) {
    try { fs.unlinkSync(tempCachePath); } catch (e) {}
  }
  if (fs.existsSync(tempPublicPeersPath)) {
    try { fs.unlinkSync(tempPublicPeersPath); } catch (e) {}
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 4 — Bootstrap Sequence Tests                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    await testStage1CacheConnection();
    await testStage2PublicPeers();
    await testStage3FailureFallback();
    await testDisconnectionTriggeredRebootstrap();
    await testExponentialBackoffValues();

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

async function testStage1CacheConnection() {
  console.log('\n=== Test 1: Stage 1 Cache Connection ===');

  const nodeA = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true });

  await nodeA.loadIdentity('bootstrap S1 A');
  await nodeB.loadIdentity('bootstrap S1 B');

  await nodeA.listen();
  await nodeB.listen();

  // Populate cache on nodeB with nodeA's details
  nodeB.peerCache.recordSuccess(nodeA.identity.nodeIdHex, '127.0.0.1', nodeA.port);

  // Re-enable and trigger bootstrap on B. We set minPeers=1 so 1 connection is sufficient.
  nodeB.bootstrap.disableBootstrap = false;
  nodeB.bootstrap.minPeers = 1;
  nodeB.bootstrap.stage1TimeoutMs = 1000;
  nodeB.bootstrap.stage2TimeoutMs = 1000;

  assertEqual(nodeB.bootstrapStatus.stage, 'failed', "Initial stage is failed (idle)");

  // Start bootstrap
  nodeB.bootstrap.start();
  
  // Wait a short time for dial to complete
  await delay(500);

  assertEqual(nodeB.bootstrapStatus.stage, 'sufficient', "Stage transitions to sufficient on successful cached peer connection");
  assertEqual(nodeB.bootstrapStatus.peersConnected, 1, "Connected peer count is 1");
  assert(nodeB.bootstrapStatus.sufficient, "Bootstrap is sufficient");

  nodeA.close();
  nodeB.close();
}

async function testStage2PublicPeers() {
  console.log('\n=== Test 2: Stage 2 Public Peers ===');

  const nodePublic = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true });
  const nodeClient = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true, publicPeersPath: tempPublicPeersPath });

  await nodePublic.loadIdentity('bootstrap S2 Public');
  await nodeClient.loadIdentity('bootstrap S2 Client');

  await nodePublic.listen();
  await nodeClient.listen();

  // Write temporary public-peers.json
  const publicList = [
    {
      address: '127.0.0.1',
      port: nodePublic.port,
      nodeId: nodePublic.identity.nodeIdHex,
      addedAt: Date.now(),
      lastVerified: Date.now()
    }
  ];
  fs.writeFileSync(tempPublicPeersPath, JSON.stringify(publicList, null, 2), 'utf8');

  // Configure short timeouts on nodeClient bootstrap to transition quickly
  nodeClient.bootstrap.disableBootstrap = false;
  nodeClient.bootstrap.minPeers = 1;
  nodeClient.bootstrap.stage1TimeoutMs = 200; // Stage 1 exits in 200ms (no candidates in cache)
  nodeClient.bootstrap.stage2TimeoutMs = 3000; // Give handshake time to complete

  nodeClient.bootstrap.start();
  
  // Wait 3.5 seconds for Stage 1 to timeout, transition to Stage 2, dial public peer, and complete handshake
  await delay(3500);

  assertEqual(nodeClient.bootstrapStatus.stage, 'sufficient', "Stage transitions to sufficient after public peer connection");

  nodePublic.close();
  nodeClient.close();
}

async function testStage3FailureFallback() {
  console.log('\n=== Test 3: Stage 3 Failure Fallback ===');

  const nodeClient = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true, publicPeersPath: tempPublicPeersPath });
  await nodeClient.loadIdentity('bootstrap S3 Client');
  await nodeClient.listen();

  // Create empty public peers file so Stage 2 fails as well
  fs.writeFileSync(tempPublicPeersPath, '[]', 'utf8');

  nodeClient.bootstrap.disableBootstrap = false;
  nodeClient.bootstrap.minPeers = 1;
  nodeClient.bootstrap.stage1TimeoutMs = 100;
  nodeClient.bootstrap.stage2TimeoutMs = 100;

  let failedEmitted = false;
  let failedCount = null;
  nodeClient.bootstrap.on('bootstrap-failed', (count) => {
    failedEmitted = true;
    failedCount = count;
  });

  nodeClient.bootstrap.start();
  
  // Wait for both stages to timeout
  await delay(500);

  assertEqual(nodeClient.bootstrapStatus.stage, 'failed', "Stage remains failed after failure fallback");
  assertEqual(failedEmitted, true, "'bootstrap-failed' event was emitted");
  assertEqual(failedCount, 0, "Current connection count in event is 0");

  nodeClient.close();
}

async function testDisconnectionTriggeredRebootstrap() {
  console.log('\n=== Test 4: Disconnection-Triggered Rebootstrap ===');

  const nodeClient = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true });
  await nodeClient.loadIdentity('bootstrap S4 Client');
  await nodeClient.listen();

  nodeClient.bootstrap.disableBootstrap = false;
  nodeClient.bootstrap.minPeers = 4; // minPeers/2 = 2

  // We mock 1 active direct connection
  const mockLink = { state: 'connected', isVirtual: false };
  nodeClient.connections.set('mock-conn', mockLink);

  // Emit close event on node (simulating link disconnect)
  nodeClient.emit('close', { connId: 'mock-conn' });

  // Re-bootstrap should be scheduled after 30s delay
  assert(nodeClient.bootstrap.rebootstrapTimer !== null, "Rebootstrap timer scheduled");

  nodeClient.close();
}

async function testExponentialBackoffValues() {
  console.log('\n=== Test 5: Exponential Backoff Values ===');

  const nodeClient = createGMPNode({ port: 0, peerCachePath: tempCachePath, disableBootstrap: true, publicPeersPath: tempPublicPeersPath });
  await nodeClient.loadIdentity('bootstrap S5 Client');
  await nodeClient.listen();

  fs.writeFileSync(tempPublicPeersPath, '[]', 'utf8');

  nodeClient.bootstrap.disableBootstrap = false;
  nodeClient.bootstrap.minPeers = 2;
  nodeClient.bootstrap.stage1TimeoutMs = 50;
  nodeClient.bootstrap.stage2TimeoutMs = 50;

  // Run 1st failed bootstrap
  await nodeClient.bootstrap.start();
  assertEqual(nodeClient.bootstrap.failureCount, 1, "First failure recorded");
  
  // Clear rebootstrap timer and trigger 2nd failed bootstrap
  clearTimeout(nodeClient.bootstrap.rebootstrapTimer);
  nodeClient.bootstrap.rebootstrapTimer = null;
  nodeClient.bootstrap.isBootstrapping = false;
  
  await nodeClient.bootstrap.start();
  assertEqual(nodeClient.bootstrap.failureCount, 2, "Second failure recorded");

  nodeClient.close();
}

runTests();
