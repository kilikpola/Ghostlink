/**
 * GMP Peer Cache Merge-On-Load Tests: peers recorded before the encryption key
 * arrives survive setEncryptionKey().
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { PeerCache } from '../dist/peer-cache.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let testsRun = 0, testsPassed = 0, testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); }
  else { testsFailed++; console.error(`  ✗ ${message}`); }
}
function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) { testsPassed++; console.log(`  ✓ ${message}`); }
  else { testsFailed++; console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`); }
}

const SEED = 'peer cache merge seed';
const cachePath = path.join(__dirname, 'data', 'temp-merge-peer-cache.json');
const keyFor = (seed) => crypto.pbkdf2Sync(seed, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');

const idA = 'a'.repeat(128);
const idB = 'b'.repeat(128);

function clean() {
  for (const p of [cachePath, `${cachePath}.tmp`]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* absent */ }
  }
}
const find = (cache, id) => cache.cache.find(e => e.nodeId === id);
// Missing entries must fail an assertion, not throw and abort the run.
const fieldOf = (cache, id, field) => (find(cache, id) ?? {})[field];

function testPreKeyPeersSurviveSetEncryptionKey() {
  console.log('\n=== Test 1: Peers recorded before the key is set survive ===');
  clean();

  const cache = new PeerCache({ filePath: cachePath });
  cache.recordSuccess(idA, '10.0.0.1', 5001);
  assertEqual(cache.cache.length, 1, 'Peer A recorded with no key set');

  cache.setEncryptionKey(keyFor(SEED));

  assert(find(cache, idA) !== undefined, 'Peer A is still present after setEncryptionKey');
  assertEqual(fieldOf(cache, idA, 'address'), '10.0.0.1', 'Its address survived');
  cache.close();
  clean();
}

function testMergeUnionsMemoryAndDisk() {
  console.log('\n=== Test 2: In-memory and on-disk peers are unioned ===');
  clean();

  const seeded = new PeerCache({ filePath: cachePath, seedPhrase: SEED });
  seeded.recordSuccess(idB, '10.0.0.2', 5002);
  seeded.close();

  const cache = new PeerCache({ filePath: cachePath });
  cache.recordSuccess(idA, '10.0.0.1', 5001);
  cache.setEncryptionKey(keyFor(SEED));

  assertEqual(cache.cache.length, 2, 'Both peers are present');
  assert(find(cache, idA) !== undefined, 'Peer A survived from memory');
  assert(find(cache, idB) !== undefined, 'Peer B survived from disk');
  cache.close();
  clean();
}

function testConflictResolution() {
  console.log('\n=== Test 3: Conflicting records take the conservative field ===');
  clean();

  const now = Date.now();
  // Build the on-disk record with its age already set. save() now re-reads and
  // merges under the lock, and the merge takes the LATER lastSeen — so a record
  // cannot be aged backwards once a newer timestamp has reached disk. Writing a
  // fresh record straight out is how a genuinely old entry comes to exist.
  const seeded = new PeerCache({ filePath: cachePath, seedPhrase: SEED });
  seeded.cache.push({
    nodeId: idA,
    address: '10.0.0.9',
    port: 9999,
    firstSeen: now - 900_000,     // the earlier first contact
    lastSeen: now - 60_000,       // the older sighting
    connectionCount: 3,
    failureCount: 7,              // the higher failure tally
    lastFailedAt: now - 60_000,
  });
  seeded.save();
  seeded.close();

  const cache = new PeerCache({ filePath: cachePath });
  cache.recordSuccess(idA, '10.0.0.1', 5001);
  const inMemory = cache.cache[0];
  inMemory.lastSeen = now;              // newer sighting
  inMemory.firstSeen = now - 300_000;
  inMemory.connectionCount = 11;        // the higher success tally
  inMemory.failureCount = 2;
  inMemory.lastFailedAt = now - 120_000;

  cache.setEncryptionKey(keyFor(SEED));
  assertEqual(cache.cache.length, 1, 'The two records collapsed into one');
  assertEqual(fieldOf(cache, idA, 'lastSeen'), now, 'lastSeen is the later of the two');
  assertEqual(fieldOf(cache, idA, 'firstSeen'), now - 900_000, 'firstSeen is the earlier of the two');
  assertEqual(fieldOf(cache, idA, 'connectionCount'), 11, 'connectionCount is the higher of the two');
  assertEqual(fieldOf(cache, idA, 'failureCount'), 7, 'failureCount is the higher of the two');
  assertEqual(fieldOf(cache, idA, 'address'), '10.0.0.1', 'Address comes from the more recent sighting');
  assertEqual(fieldOf(cache, idA, 'port'), 5001, 'Port comes from the more recent sighting');
  assertEqual(fieldOf(cache, idA, 'lastFailedAt'), now - 60_000, 'lastFailedAt is the most recent failure');
  cache.close();
  clean();
}

function testSetEncryptionKeyNullDoesNotErase() {
  console.log('\n=== Test 4: setEncryptionKey(null) does not erase the cache ===');
  clean();

  const cache = new PeerCache({ filePath: cachePath, seedPhrase: SEED });
  cache.recordSuccess(idA, '10.0.0.1', 5001);
  cache.recordSuccess(idB, '10.0.0.2', 5002);
  assertEqual(cache.cache.length, 2, 'Two peers recorded');

  cache.setEncryptionKey(null);

  assertEqual(cache.cache.length, 2, 'Both peers survive the key being removed');
  cache.close();
  clean();
}

function testMergedCacheIsPersisted() {
  console.log('\n=== Test 5: The merged cache reaches disk ===');
  clean();

  const cache = new PeerCache({ filePath: cachePath });
  cache.recordSuccess(idA, '10.0.0.1', 5001);
  cache.setEncryptionKey(keyFor(SEED));
  // No close(): the write must already have happened.

  const reopened = new PeerCache({ filePath: cachePath, seedPhrase: SEED });
  assert(find(reopened, idA) !== undefined, 'A separate instance loads the merged peer');
  reopened.close();
  clean();
}

function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Peer Cache Merge-On-Load Tests                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testPreKeyPeersSurviveSetEncryptionKey();
    testMergeUnionsMemoryAndDisk();
    testConflictResolution();
    testSetEncryptionKeyNullDoesNotErase();
    testMergedCacheIsPersisted();
  } catch (err) {
    console.error('\nTest suite error:', err);
    clean();
    process.exit(1);
  }
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
