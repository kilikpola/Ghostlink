import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { holePunchConnect } from '../dist/hole-punch.js';
import net from 'net';

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

async function testFastPathDirectConnection() {
  console.log('\n=== Test 1: Fast Path Direct Connection ===');

  const nodeA = createGMPNode({ port: 49700 });
  const nodeB = createGMPNode({ port: 49701 });

  await nodeA.loadIdentity('hole punch fast path node A');
  await nodeB.loadIdentity('hole punch fast path node B');

  await nodeA.listen();
  console.log('  Node A listening on port 49700');

  const startTime = Date.now();
  const result = await holePunchConnect({
    node: nodeB,
    peerNodeId: Buffer.from(nodeA.identity.nodeId).toString('hex'),
    previouslyKnownAddress: { address: '127.0.0.1', port: 49700 },
    peerObservedAddress: { address: '127.0.0.1', port: 49700 },
    attemptTimestamp: Date.now() + 5000, // Coordinated attempt is 5s away, but fast path should bypass this
    timeoutMs: 2000,
  });

  const duration = Date.now() - startTime;
  console.log(`  Connection succeeded in ${duration}ms`);

  assert(result !== null, 'Established link successfully via fast path');
  assert(duration < 1000, 'Fast path bypassed coordinated countdown wait');

  result.link.destroy();
  nodeA.close();
  nodeB.close();
}

async function testCoordinatedSimultaneousOpen() {
  console.log('\n=== Test 2: Coordinated Simultaneous Open (Hole Punching) ===');

  const nodeA = createGMPNode({ port: 49702 });
  const nodeB = createGMPNode({ port: 49703 });

  await nodeA.loadIdentity('hole punch open node A');
  await nodeB.loadIdentity('hole punch open node B');

  await nodeA.listen();
  console.log('  Node A listening on port 49702');

  const attemptDelay = 1000;
  const attemptTimestamp = Date.now() + attemptDelay;
  const startTime = Date.now();

  const result = await holePunchConnect({
    node: nodeB,
    peerNodeId: Buffer.from(nodeA.identity.nodeId).toString('hex'),
    peerObservedAddress: { address: '127.0.0.1', port: 49702 },
    attemptTimestamp,
    timeoutMs: 3000,
  });

  const duration = Date.now() - startTime;
  console.log(`  Hole punch succeeded. Total time: ${duration}ms (attempt wait was ${attemptDelay}ms)`);

  assert(result !== null, 'Hole punch succeeded and returned link');
  assert(duration >= attemptDelay, 'Hole punch execution waited for coordinated timestamp');

  result.link.destroy();
  nodeA.close();
  nodeB.close();
}

async function testHolePunchFallbackOnFailure() {
  console.log('\n=== Test 3: Fallback trigger when hole punching fails ===');

  const nodeB = createGMPNode({ port: 49704 });
  await nodeB.loadIdentity('hole punch fallback client');

  const startTime = Date.now();
  let errorCaught = null;

  try {
    // Attempt connection to a port that is NOT listening (should fail)
    await holePunchConnect({
      node: nodeB,
      peerNodeId: 'some_random_peer_node_id_hex',
      peerObservedAddress: { address: '127.0.0.1', port: 49705 },
      attemptTimestamp: Date.now(),
      retryIntervalMs: 100,
      timeoutMs: 1000, // Short timeout
    });
  } catch (err) {
    errorCaught = err;
    console.log(`  Caught expected error: ${err.message}`);
  }

  const duration = Date.now() - startTime;
  console.log(`  Failed in ${duration}ms`);

  assert(errorCaught !== null, 'Hole punching failed as expected');
  assertContains(
    errorCaught.message,
    'Falling back to QR/paste signaling or the optional relay',
    'Error message correctly recommends QR/paste and relay fallback'
  );

  nodeB.close();
}

async function testHolePunchMissingAddress() {
  console.log('\n=== Test 4: Missing address validation ===');

  const nodeB = createGMPNode({ port: 49706 });
  await nodeB.loadIdentity('hole punch missing address client');

  let errorCaught = null;
  try {
    await holePunchConnect({
      node: nodeB,
      peerNodeId: 'some_random_peer_node_id_hex',
      peerObservedAddress: null, // missing observed address
      attemptTimestamp: Date.now(),
      timeoutMs: 1000,
    });
  } catch (err) {
    errorCaught = err;
    console.log(`  Caught expected error: ${err.message}`);
  }

  assert(errorCaught !== null, 'Rejects immediately if peerObservedAddress is missing');
  assertContains(
    errorCaught.message,
    "peer's observed address is missing or invalid",
    'Error message correctly identifies missing address'
  );

  nodeB.close();
}

function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodePayload(str) {
  try {
    return JSON.parse(Buffer.from(str.trim(), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('Invalid Base64 payload');
  }
}

async function testPayloadRoundTrip() {
  console.log('\n=== Test 5: Payload Encoding/Decoding Round-Trip ===');

  const payload = {
    nodeId: '99ff5fce5aefed6cc0b842bab9f70b1fb041e4cfa5ec27e06e7dd079d231c68b601cabcd3aae2ec61f82358b4671c9d2faaa7f0eaedaec13ae1fabdd988363a6',
    address: '192.0.2.55',
    port: 49501,
    natType: 'RESTRICTED_CONE',
    attemptTimestamp: Date.now() + 60000
  };

  const encoded = encodePayload(payload);
  const decoded = decodePayload(encoded);

  assertEqual(decoded.nodeId, payload.nodeId, 'NodeID survives round-trip');
  assertEqual(decoded.address, payload.address, 'Address survives round-trip');
  assertEqual(decoded.port, payload.port, 'Port survives round-trip');
  assertEqual(decoded.natType, payload.natType, 'NAT Type survives round-trip');
  assertEqual(decoded.attemptTimestamp, payload.attemptTimestamp, 'Attempt Timestamp survives round-trip');
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2b-iii — Simultaneous-Open Hole Punching Tests  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testFastPathDirectConnection();
    await testCoordinatedSimultaneousOpen();
    await testHolePunchFallbackOnFailure();
    await testHolePunchMissingAddress();
    await testPayloadRoundTrip();

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
