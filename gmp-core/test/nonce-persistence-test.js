/**
 * GMP Nonce Persistence Test
 *
 * 1. Create a nonce store, add some entries
 * 2. Simulate process restart by creating a new instance pointing at same file
 * 3. Confirm entries are loaded correctly
 * 4. Test pruning of old entries with the 90-day default and a 30-day override
 * 5. Test session key uniqueness check behavior
 *
 * Run: node test/nonce-persistence-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_STATE_FILE = '/tmp/gmp-nonce-test-state.json';
const TEST_SEED = 'test seed for nonce persistence';

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
    console.error(`  ✗ ${message}`);
  }
}

async function cleanup() {
  try {
    if (fs.existsSync(TEST_STATE_FILE)) {
      fs.unlinkSync(TEST_STATE_FILE);
    }
  } catch (e) {}
}

async function testBasicPersistence() {
  console.log('\n=== Test 1: Basic Persistence ===');

  await cleanup();

  const store1 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store1.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x41);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x42);

  const result1 = store1.checkAndUpdate(fakePeerId, fakeSessionKey, 5, 10);
  assertEqual(result1.allowed, true, 'First connection allowed');

  store1.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store2.load();

  const entry = store2.getEntry(fakePeerId, fakeSessionKey);
  assert(entry !== null, 'Entry persisted across restart');
  assertEqual(entry.sendHighWater, 5, 'Send high water persisted');
  assertEqual(entry.recvHighWater, 10, 'Recv high water persisted');

  store2.close();
  await cleanup();
}

async function testNonceOverlapRejection() {
  console.log('\n=== Test 2: Nonce Overlap Rejection ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x51);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x52);

  const result1 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 100, 200);
  assertEqual(result1.allowed, true, 'First connection with nonces 100/200 allowed');

  const result2 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 50, 150);
  assertEqual(result2.allowed, false, 'Second connection with overlapping nonces rejected');
  assertContains(result2.reason, 'send nonce', 'Rejection reason mentions send nonce');

  const result3 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 100, 150);
  assertEqual(result3.allowed, false, 'Second connection with equal send nonce rejected');

  const result4 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 50, 200);
  assertEqual(result4.allowed, false, 'Second connection with equal recv nonce rejected');

  const result5 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 150, 300);
  assertEqual(result5.allowed, true, 'Connection with higher nonces (150/300) allowed');

  store.close();
  await cleanup();
}

async function testPruningOverride() {
  console.log('\n=== Test 3a: Pruning Override Option (e.g. 30 days) ===');

  await cleanup();

  // Create store with 30-day override
  const store = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED, pruneAgeMs: 30 * 24 * 60 * 60 * 1000 });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x61);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x62);

  store.checkAndUpdate(fakePeerId, fakeSessionKey, 1, 1);

  const entry = store.state.entries[Object.keys(store.state.entries)[0]];
  const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days old
  entry.lastActivity = oldTimestamp;
  entry.firstSeen = oldTimestamp;

  store.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED, pruneAgeMs: 30 * 24 * 60 * 60 * 1000 });
  await store2.load();

  const entryAfterPrune = store2.getEntry(fakePeerId, fakeSessionKey);
  assert(entryAfterPrune === null, 'Entries > 30 days are pruned when override is set to 30 days');

  store2.close();
  await cleanup();
}

async function testPruningDefault90Days() {
  console.log('\n=== Test 3b: Pruning Default (90 days) ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  assertEqual(store.pruneAgeMs, 90 * 24 * 60 * 60 * 1000, "Default prune age is 90 days");

  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x61);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x62);

  store.checkAndUpdate(fakePeerId, fakeSessionKey, 1, 1);

  const entry = store.state.entries[Object.keys(store.state.entries)[0]];
  const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days old (should NOT be pruned)
  entry.lastActivity = oldTimestamp;
  entry.firstSeen = oldTimestamp;

  store.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store2.load();

  const entryAfter31Days = store2.getEntry(fakePeerId, fakeSessionKey);
  assert(entryAfter31Days !== null, 'Entries at 31 days are NOT pruned under 90-day default');

  store2.close();

  // Simulate 91 days on a fresh file: merges keep the later lastActivity, so
  // an entry's age must be set when it is first written.
  await cleanup();

  const aged = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  aged.checkAndUpdate(fakePeerId, fakeSessionKey, 1, 1);
  const agedEntry = aged.state.entries[Object.keys(aged.state.entries)[0]];
  const veryOldTimestamp = Date.now() - (91 * 24 * 60 * 60 * 1000); // 91 days old
  agedEntry.lastActivity = veryOldTimestamp;
  agedEntry.firstSeen = veryOldTimestamp;
  aged.close();

  const store3 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store3.load();

  const entryAfter91Days = store3.getEntry(fakePeerId, fakeSessionKey);
  assert(entryAfter91Days === null, 'Entries > 90 days ARE pruned under 90-day default');

  store3.close();
  await cleanup();
}

async function testMultiplePeers() {
  console.log('\n=== Test 4: Multiple Peer Entries ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store.load();

  const peer1Id = new Uint8Array(64);
  peer1Id.fill(0x71);
  const peer1Key = new Uint8Array(32);
  peer1Key.fill(0x72);

  const peer2Id = new Uint8Array(64);
  peer2Id.fill(0x81);
  const peer2Key = new Uint8Array(32);
  peer2Key.fill(0x82);

  const peer3Id = new Uint8Array(64);
  peer3Id.fill(0x91);
  const peer3Key = new Uint8Array(32);
  peer3Key.fill(0x92);

  store.checkAndUpdate(peer1Id, peer1Key, 10, 20);
  store.checkAndUpdate(peer2Id, peer2Key, 30, 40);
  store.checkAndUpdate(peer3Id, peer3Key, 50, 60);

  store.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store2.load();

  const keys = Object.keys(store2.state.entries);
  assertEqual(keys.length, 3, 'All three peer entries persisted');

  const entry1 = store2.getEntry(peer1Id, peer1Key);
  assertEqual(entry1.sendHighWater, 10, 'Peer 1 send high water correct');
  assertEqual(entry1.recvHighWater, 20, 'Peer 1 recv high water correct');

  const entry2 = store2.getEntry(peer2Id, peer2Key);
  assertEqual(entry2.sendHighWater, 30, 'Peer 2 send high water correct');
  assertEqual(entry2.recvHighWater, 40, 'Peer 2 recv high water correct');

  const entry3 = store2.getEntry(peer3Id, peer3Key);
  assertEqual(entry3.sendHighWater, 50, 'Peer 3 send high water correct');
  assertEqual(entry3.recvHighWater, 60, 'Peer 3 recv high water correct');

  store2.close();
  await cleanup();
}

async function testUpdateCounters() {
  console.log('\n=== Test 5: Update Counters ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0xA1);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0xA2);

  store.updateCounters(fakePeerId, fakeSessionKey, 5, 10);
  store.updateCounters(fakePeerId, fakeSessionKey, 8, 12);
  store.updateCounters(fakePeerId, fakeSessionKey, 3, 7);

  const entry = store.getEntry(fakePeerId, fakeSessionKey);
  assertEqual(entry.sendHighWater, 8, 'Send high water updated correctly (max 8)');
  assertEqual(entry.recvHighWater, 12, 'Recv high water updated correctly (max 12)');

  store.close();
  await cleanup();
}

/**
 * Two ways the directional marks could quietly stop protecting anything.
 * Both were live regressions when the marks were first added.
 */
async function testMarkInvariants() {
  console.log('\n=== Test 6: High-Water Invariants ===');
  await cleanup();

  const peerId = new Uint8Array(64);
  peerId.fill(0xB1);
  const sessionKey = new Uint8Array(32);
  sessionKey.fill(0xB2);

  // A legacy state file carries highWaterMark alone; build that shape directly.
  const legacy = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  legacy.state.entries[legacy._getKey(peerId, 'legacy-fingerprint')] = {
    highWaterMark: 100,
    lastActivity: Date.now(),
  };
  const migrated = legacy.getEntry(peerId, 'legacy-fingerprint');
  assertEqual(migrated.sendHighWater, undefined, 'A legacy entry has no directional send mark');

  // And the new behaviour: checkNonce keeps both marks in step.
  const stepped = new NonceStore({ stateFile: TEST_STATE_FILE + '.stepped', seedPhrase: TEST_SEED });
  stepped.checkNonce(peerId, 'stepped-fingerprint', 100);
  const steppedEntry = stepped.getEntry(peerId, 'stepped-fingerprint');
  assertEqual(steppedEntry.sendHighWater, 100, 'checkNonce raises the send mark with the aggregate');
  assertEqual(steppedEntry.recvHighWater, 100, 'checkNonce raises the recv mark with the aggregate');
  assertEqual(
    stepped.checkAndUpdate(peerId, 'stepped-fingerprint', 100, 100).allowed,
    false,
    'checkAndUpdate cannot re-accept a nonce checkNonce already took'
  );
  stepped.close();
  fs.rmSync(TEST_STATE_FILE + '.stepped', { force: true });

  const replay = legacy.checkAndUpdate(peerId, 'legacy-fingerprint', 1, 1);
  assertEqual(replay.allowed, false, 'Reconnect at 1/1 rejected against a legacy mark of 100');

  const ahead = legacy.checkAndUpdate(peerId, 'legacy-fingerprint', 101, 101);
  assertEqual(ahead.allowed, true, 'Reconnect above the legacy mark still allowed');
  legacy.close();

  await cleanup();

  // The aggregate mark must cover the send counter too, because checkNonce
  // reads it on its own.
  const agg = new NonceStore({ stateFile: TEST_STATE_FILE, seedPhrase: TEST_SEED });
  agg.checkAndUpdate(peerId, sessionKey, 10, 10);
  agg.checkAndUpdate(peerId, sessionKey, 150, 101);
  const entry = agg.getEntry(peerId, sessionKey);
  assertEqual(entry.highWaterMark, 150, 'Aggregate mark follows the higher of the two counters');

  const below = agg.checkNonce(peerId, agg._fingerprint(sessionKey), 120);
  assertEqual(below.valid, false, 'checkNonce rejects a nonce below the accepted send counter');
  agg.close();

  await cleanup();
}

/** GMPNode must actually construct its NonceStore. */
async function testNodeWiring() {
  console.log('\n=== Test 7: GMPNode Wiring ===');
  const { createGMPNode } = await import('../dist/node-factory.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-wiring-'));

  const node = createGMPNode({
    port: 49943,
    peerCachePath: path.join(dir, 'peers.json'),
    nonceStorePath: path.join(dir, 'nonce.json'),
    disableBootstrap: true,
    seedPhrase: 'wiring check seed',
  });

  assert(!!node.nonceStore, 'GMPNode constructs a NonceStore by default');
  assertEqual(typeof node.nonceStore.claimSessionKey, 'function', 'The store exposes claimSessionKey');
  assertEqual(typeof node.nonceStore.updateCounters, 'function', 'The store exposes updateCounters, which link.js calls');

  await node.loadIdentity('wiring check seed');

  const peer = new Uint8Array(64);
  peer.fill(0xC3);
  assertEqual(node.nonceStore.claimSessionKey(peer, 'wiring-fp').valid, true, 'A fresh session key is claimable');
  assertEqual(node.nonceStore.claimSessionKey(peer, 'wiring-fp').valid, false, 'The same session key cannot be claimed twice');

  node.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2a / 5 — Nonce Persistence & Pruning Test       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testBasicPersistence();
    await testNonceOverlapRejection();
    await testPruningOverride();
    await testPruningDefault90Days();
    await testMultiplePeers();
    await testUpdateCounters();
    await testMarkInvariants();
    await testNodeWiring();

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