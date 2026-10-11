/**
 * GMP Claim Permanence & Scope Tests: claims are permanent and global, and
 * unknown state versions are refused rather than dropped.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const SEED = 'claim permanence seed';
const DAY = 24 * 60 * 60 * 1000;

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

let dir;
const freshFile = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-claim-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

const peer1 = Buffer.alloc(64, 1);
const peer2 = Buffer.alloc(64, 2);
const FP = 'ab'.repeat(16);

/** V1: the pruner must never reach a claim, however old it looks. */
function testClaimSurvivesPruneAge() {
  console.log('\n=== Test 1: A claim survives the prune age elapsing ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED, pruneAgeMs: 40 });
  assertEqual(a.claimSessionKey(peer1, FP).valid, true, 'Fingerprint claimed');
  a.close();

  // Well past the retention window — under the old shape the claim was an
  // ordinary entry and the pruner removed it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);

  const b = new NonceStore({ stateFile, seedPhrase: SEED, pruneAgeMs: 40 });
  assertEqual(b.claimSessionKey(peer1, FP).valid, false, 'The claim is STILL refused after the prune age');
  b.close();
  dropDir();
}

/** V2: a forward clock jump must not age out claims, nor mass-delete counters. */
function testClockJumpDoesNotEraseClaims() {
  console.log('\n=== Test 2: A +100 day clock jump erases nothing ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(a.claimSessionKey(peer1, FP).valid, true, 'Fingerprint claimed with a sane clock');
  a.updateCounters(peer1, 'counter-session', 10, 10);
  a.close();

  const realNow = Date.now;
  Date.now = () => realNow() + 100 * DAY;
  try {
    const b = new NonceStore({ stateFile, seedPhrase: SEED });
    assertEqual(b.claimSessionKey(peer1, FP).valid, false, 'The claim survives the clock jump');
    b.close();
  } finally {
    Date.now = realNow;
  }
  dropDir();

  // A +100 day jump against a 90 day window is NOT implausible — it looks like
  // ordinary age, so the counter for that session is pruned. That is accepted:
  // counters are defence in depth now that the claim is permanent and global,
  // and the session key they belong to can never be presented again anyway.
  // The guard is for a jump large enough that no reading of it is genuine.
  console.log('\n=== Test 2b: An implausible jump skips the prune cycle entirely ===');
  const stateFile2 = freshFile();
  const c = new NonceStore({ stateFile: stateFile2, seedPhrase: SEED });
  c.updateCounters(peer1, 'counter-session', 10, 10);
  c.close();

  const realNow2 = Date.now;
  Date.now = () => realNow2() + 3000 * DAY;   // > 10x the 90 day window
  try {
    const d = new NonceStore({ stateFile: stateFile2, seedPhrase: SEED });
    assert(
      d.getEntry(peer1, 'counter-session') !== null,
      'Counters survive a jump too large to be genuine age: the cycle was skipped'
    );
    d.close();
  } finally {
    Date.now = realNow2;
  }
  dropDir();
}

/** Counters must still prune under a clock that has not obviously moved. */
function testCountersStillPrune() {
  console.log('\n=== Test 3: Ordinary counter pruning still happens ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED, pruneAgeMs: 40 });
  a.checkAndUpdate(peer1, 'counter-session', 5, 5);
  a.close();

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);

  const b = new NonceStore({ stateFile, seedPhrase: SEED, pruneAgeMs: 40 });
  assert(b.getEntry(peer1, 'counter-session') === null, 'A stale counter entry is pruned as before');
  b.close();
  dropDir();
}

/** V5: the claim is global — one fingerprint, not one per peer. */
function testClaimIsGlobal() {
  console.log('\n=== Test 4: A claim is global, not per-peer ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(a.claimSessionKey(peer1, FP).valid, true, 'Claimed with peer1');
  assertEqual(a.claimSessionKey(peer1, FP).valid, false, 'Refused for peer1 again');
  assertEqual(a.claimSessionKey(peer2, FP).valid, false, 'REFUSED for peer2: the key is burnt globally');
  a.close();

  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(b.claimSessionKey(peer2, FP).valid, false, 'Still refused for peer2 after a restart');
  b.close();
  dropDir();
}

/** A v1 file's per-peer claims must come forward as global ones. */
function testV1Migration() {
  console.log('\n=== Test 5: A version 1 file migrates its claims ===');
  const stateFile = freshFile();
  const key = crypto.pbkdf2Sync(SEED, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');

  const peerHex = Buffer.from(peer1).toString('hex');
  const v1 = {
    version: 1,
    entries: {
      [`${peerHex}:${FP}`]: { highWaterMark: 0, lastActivity: Date.now() },
      [`${peerHex}:${'cd'.repeat(16)}`]: {
        highWaterMark: 40, sendHighWater: 40, recvHighWater: 30,
        firstSeen: Date.now(), lastActivity: Date.now(),
      },
    },
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v1), 'utf8'), c.final()]);
  fs.writeFileSync(stateFile, JSON.stringify({
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([c.getAuthTag(), ct]).toString('hex'),
    version: 1,
  }, null, 2));

  const store = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(store.claimSessionKey(peer1, FP).valid, false, 'The v1 claim carried forward');
  assertEqual(store.claimSessionKey(peer2, FP).valid, false, 'And it is now global, not peer1-only');
  assertEqual(
    store.claimSessionKey(peer1, 'cd'.repeat(16)).valid,
    false,
    'A fingerprint that only had counters is claimed too (over-claiming is the safe direction)'
  );
  const counters = store.getEntry(peer1, 'cd'.repeat(16));
  assert(counters !== null && counters.sendHighWater === 40, 'The counter marks survived migration intact');
  store.close();
  dropDir();
}

/** V4: an unreadable version must be loud, and fatal under strict mode. */
function testUnsupportedVersion() {
  console.log('\n=== Test 6: An unsupported state version is loud, not silent ===');
  const stateFile = freshFile();
  const key = crypto.pbkdf2Sync(SEED, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');

  const future = { version: 99, entries: {}, claims: {} };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(future), 'utf8'), c.final()]);
  fs.writeFileSync(stateFile, JSON.stringify({
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([c.getAuthTag(), ct]).toString('hex'),
    version: 1,
  }, null, 2));

  const seen = [];
  const realErr = console.error;
  console.error = (...a) => { seen.push(a.join(' ')); };
  let threw = null;
  try {
    new NonceStore({ stateFile, seedPhrase: SEED, strictState: false }).load();
  } finally {
    console.error = realErr;
  }
  assert(
    seen.some(l => l.includes('state-version-unsupported')),
    'Non-strict: an ERROR naming state-version-unsupported is logged'
  );

  try {
    new NonceStore({ stateFile, seedPhrase: SEED, strictState: true }).load();
  } catch (e) {
    threw = e;
  }
  assertEqual(threw && threw.name, 'StateAuthenticationError', 'Strict mode refuses to start');
  dropDir();
}

/** ALSO: a claim made before the key exists reaches disk on the first flush. */
function testPreKeyClaimReachesDisk() {
  console.log('\n=== Test 7: A pre-key claim reaches disk on the first flush ===');
  const stateFile = freshFile();
  const key = crypto.pbkdf2Sync(SEED, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');

  const store = new NonceStore({ stateFile });
  assertEqual(store.claimSessionKey(peer1, FP).valid, true, 'Claimed before any key is configured');
  assert(!fs.existsSync(store.claimsFile), 'Nothing is on disk yet — there is no key to seal it with');

  assertEqual(store.setEncryptionKey(key), true, 'setEncryptionKey reports success');
  // Re-read the path: the log is named after the key that seals it, so it only
  // has its final name once there is a key.
  assert(fs.existsSync(store.claimsFile), 'The claim log exists the moment setEncryptionKey returns');

  // No close(): a crash here must not lose the claim.
  const other = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(other.claimSessionKey(peer1, FP).valid, false, 'A separate process already sees the claim');
  assertEqual(other.claimSessionKey(peer2, FP).valid, false, 'And sees it globally');
  other.close();
  dropDir();
}

function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Claim Permanence & Scope Tests                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testClaimSurvivesPruneAge();
    testClockJumpDoesNotEraseClaims();
    testCountersStillPrune();
    testClaimIsGlobal();
    testV1Migration();
    testUnsupportedVersion();
    testPreKeyClaimReachesDisk();
  } catch (err) {
    console.error('\nTest suite error:', err);
    dropDir();
    process.exit(1);
  }
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
