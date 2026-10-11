/**
 * GMP Peer Reputation Test Suite — Phase 5
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

const tempCacheAPath = path.join(__dirname, 'data', 'temp-rep-cache-A.json');
const tempCacheBPath = path.join(__dirname, 'data', 'temp-rep-cache-B.json');
const tempCacheCPath = path.join(__dirname, 'data', 'temp-rep-cache-C.json');

function cleanTempFiles() {
  for (const f of [tempCacheAPath, tempCacheBPath, tempCacheCPath]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 5 — Peer Reputation Tests                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    await testScoreDecayAndRecovery();
    await delay(300);

    await testLinkTeardownOnBan();
    await delay(300);

    await testBanListBlocking();
    await delay(300);

    await testRelayingForBannedNodeDropped();
    await delay(300);

    cleanTempFiles();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╗');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempFiles();
    process.exit(1);
  }
}

async function testScoreDecayAndRecovery() {
  console.log('\n=== Test 1: Score Decay and Recovery ===');

  const nodeA = createGMPNode({ port: 49960, peerCachePath: tempCacheAPath, disableBootstrap: true });
  await nodeA.loadIdentity('rep A');

  const peerIdHex = 'a'.repeat(64);

  // Initial score is 100
  assertEqual(nodeA.reputation.getScore(peerIdHex), 100, "Initial reputation score is 100");

  // Suspicious action: -10
  nodeA.reputation.penalize(peerIdHex, 10, 'Suspicious test action');
  assertEqual(nodeA.reputation.getScore(peerIdHex), 90, "Score decays to 90 after suspicious action");

  // Recovery: recovers +1
  nodeA.reputation.recoverScores();
  assertEqual(nodeA.reputation.getScore(peerIdHex), 91, "Score recovers to 91 after recoverScores");

  nodeA.close();
}

async function testLinkTeardownOnBan() {
  console.log('\n=== Test 2: Active Link Teardown on Ban ===');
  cleanTempFiles();

  const nodeA = createGMPNode({ port: 49962, peerCachePath: tempCacheAPath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 49963, peerCachePath: tempCacheBPath, disableBootstrap: true });

  await nodeA.loadIdentity('rep A 2');
  await nodeB.loadIdentity('rep B 2');

  await nodeA.listen();
  await nodeB.listen();

  // Connect A and B
  const { link } = await nodeA.dial('127.0.0.1', 49963);
  await delay(200);

  assertEqual(link.state, 'connected', "Nodes connected successfully");

  // Penalize B on A with banned action (-100 points)
  nodeA.reputation.penalize(nodeB.identity.nodeIdHex, 100, 'Direct ban test');
  await delay(200);

  // Link state should be closed
  assertEqual(link.state, 'closed', "Link was torn down after peer B was banned");

  nodeA.close();
  nodeB.close();
}

async function testBanListBlocking() {
  console.log('\n=== Test 3: Ban List Blocking (Incoming & Outgoing) ===');
  cleanTempFiles();

  const nodeA = createGMPNode({ port: 49964, peerCachePath: tempCacheAPath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 49965, peerCachePath: tempCacheBPath, disableBootstrap: true });

  await nodeA.loadIdentity('rep A 3');
  await nodeB.loadIdentity('rep B 3');

  await nodeA.listen();
  await nodeB.listen();

  // Ban Node B's IP and NodeID on Node A
  nodeA.reputation.ban(nodeB.identity.nodeIdHex, '127.0.0.1', 'Banned prior to dialing');

  // Outgoing dial from A to B should throw error immediately
  let dialError = null;
  try {
    await nodeA.dial('127.0.0.1', 49965);
  } catch (e) {
    dialError = e;
  }
  assert(dialError !== null, "Outgoing dial to banned IP throws error");

  // Incoming dial from B to A should connect socket but get immediately closed at TCP listen or HELLO handler
  let bDialSuccess = true;
  try {
    await nodeB.dial('127.0.0.1', 49964);
  } catch (e) {
    bDialSuccess = false;
  }
  await delay(200);

  assertEqual(bDialSuccess, false, "Incoming dial from banned peer was rejected");

  nodeA.close();
  nodeB.close();
}

async function testRelayingForBannedNodeDropped() {
  console.log('\n=== Test 4: Relaying Packets from/to Banned NodeIDs is Dropped ===');
  cleanTempFiles();

  // Topology: A - B - C
  const nodeA = createGMPNode({ port: 49966, peerCachePath: tempCacheAPath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 49967, peerCachePath: tempCacheBPath, disableBootstrap: true });
  const nodeC = createGMPNode({ port: 49968, peerCachePath: tempCacheCPath, disableBootstrap: true });

  await nodeA.loadIdentity('rep A 4');
  await nodeB.loadIdentity('rep B 4');
  await nodeC.loadIdentity('rep C 4');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  // Connect A to B, B to C
  await nodeA.dial('127.0.0.1', 49967);
  await nodeB.dial('127.0.0.1', 49968);
  await delay(300);

  // Set up route on A to C via B
  nodeA.routingTable.addRoute(nodeC.identity.nodeId, nodeB.identity.nodeId, 1);

  // Ban Node C on Node B (the relay)
  nodeB.reputation.ban(nodeC.identity.nodeIdHex, '127.0.0.1', 'Ban C on B');

  // Attempt to dial virtual connection A -> C (will route through B)
  let virtualDialFailed = false;
  try {
    const virtualSocket = await nodeA.dialVirtual(nodeC.identity.nodeId);
    await delay(300);
  } catch (e) {
    virtualDialFailed = true;
  }

  await delay(300);
  assertEqual(virtualDialFailed, true, "Virtual dial through relay B was dropped because target C is banned on B");

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

runTests();
