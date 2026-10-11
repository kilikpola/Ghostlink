/**
 * GMP Clock Hardening Test Suite — Phase 5
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

const tempCacheAPath = path.join(__dirname, 'data', 'temp-clock-cache-A.json');
const tempCacheBPath = path.join(__dirname, 'data', 'temp-clock-cache-B.json');

function cleanTempFiles() {
  for (const f of [tempCacheAPath, tempCacheBPath]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 5 — Clock Hardening Tests                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    await testClockSkewDetection();
    await delay(300);

    await testTimestampOutsideWindowRejected();
    await delay(300);

    await testTimestampWithinWindowAccepted();
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

async function testClockSkewDetection() {
  console.log('\n=== Test 1: Clock Skew > 5 Minutes triggers event, connection completes ===');
  cleanTempFiles();

  // Set timestampWindowMs to 10 minutes so 6 minutes skew is allowed but triggers the warning event
  const nodeA = createGMPNode({ port: 49910, peerCachePath: tempCacheAPath, disableBootstrap: true, timestampWindowMs: 10 * 60 * 1000 });
  const nodeB = createGMPNode({ port: 49911, peerCachePath: tempCacheBPath, disableBootstrap: true, timestampWindowMs: 10 * 60 * 1000 });

  await nodeA.loadIdentity('clock A');
  await nodeB.loadIdentity('clock B');

  await nodeA.listen();
  await nodeB.listen();

  let skewEventReceived = false;
  let skewDelta = 0;
  nodeB.on('clock-skew-detected', (data) => {
    skewEventReceived = true;
    skewDelta = data.delta;
  });

  // Skew Node A's clock forward by 6 minutes (360,000 ms) during dialing
  nodeA.now = () => Date.now() + (6 * 60 * 1000 + 10000); // 6m 10s skew

  let link;
  try {
    const res = await nodeA.dial('127.0.0.1', 49911);
    link = res.link;
  } catch (e) {
    console.error('Dial failed:', e);
  }

  await delay(300);

  assertEqual(link && link.state, 'connected', "Connection successfully established despite skew");
  assertEqual(skewEventReceived, true, "'clock-skew-detected' event was emitted on Node B");
  assert(skewDelta > 6 * 60 * 1000, "Emitted skew delta reflects correct magnitude");

  nodeA.close();
  nodeB.close();
}

async function testTimestampOutsideWindowRejected() {
  console.log('\n=== Test 2: Timestamp Outside 2-minute Window Rejected ===');
  cleanTempFiles();

  // Enforce default 2-minute window (120,000 ms)
  const nodeA = createGMPNode({ port: 49922, peerCachePath: tempCacheAPath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 49923, peerCachePath: tempCacheBPath, disableBootstrap: true });

  await nodeA.loadIdentity('clock A 2');
  await nodeB.loadIdentity('clock B 2');

  await nodeA.listen();
  await nodeB.listen();

  // Skew Node A's clock by 3 minutes (180,000 ms)
  nodeA.now = () => Date.now() + (3 * 60 * 1000);

  let dialFailed = false;
  try {
    await nodeA.dial('127.0.0.1', 49923);
  } catch (e) {
    dialFailed = true;
  }

  await delay(300);

  assertEqual(dialFailed, true, "Connection was rejected due to timestamp outside 2-minute window");

  nodeA.close();
  nodeB.close();
}

async function testTimestampWithinWindowAccepted() {
  console.log('\n=== Test 3: Timestamp Within 2-minute Window Accepted ===');
  cleanTempFiles();

  const nodeA = createGMPNode({ port: 49924, peerCachePath: tempCacheAPath, disableBootstrap: true });
  const nodeB = createGMPNode({ port: 49925, peerCachePath: tempCacheBPath, disableBootstrap: true });

  await nodeA.loadIdentity('clock A 3');
  await nodeB.loadIdentity('clock B 3');

  await nodeA.listen();
  await nodeB.listen();

  // Skew Node A's clock by 1 minute (60,000 ms), which is within 2 minutes
  nodeA.now = () => Date.now() + (60 * 1000);

  let link;
  try {
    const res = await nodeA.dial('127.0.0.1', 49925);
    link = res.link;
  } catch (e) {
    console.error('Dial failed:', e);
  }

  await delay(300);

  assertEqual(link && link.state, 'connected', "Connection accepted because timestamp is within 2 minutes");

  nodeA.close();
  nodeB.close();
}

runTests();
