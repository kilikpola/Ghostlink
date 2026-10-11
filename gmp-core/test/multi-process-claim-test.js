/**
 * GMP Multi-Process Claim Tests: real forked processes sharing a data
 * directory must not erase each other's session-key claims.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { fork } from 'child_process';
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'helpers', 'claim-child.mjs');
const SEED = 'multi process seed';

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

const peer = Buffer.alloc(64, 9);
/** The key-scoped claim log path (mirrors ClaimLog.scopedPath). */
function claimsPathFor(stateFile, seed) {
  const key = crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const id = crypto.createHash('sha256').update('gmp-claim-log-id').update(key).digest('hex').slice(0, 16);
  return `${stateFile}.claims.${id}.log`;
}
const claimsOf = (stateFile) => claimsPathFor(stateFile, SEED);
const lockOf = (stateFile) => `${claimsOf(stateFile)}.lock`;
let dir;
const freshDir = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-mpc-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

function claimInChild(stateFile, fingerprint, holdMs = 0) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [stateFile, SEED, fingerprint, String(holdMs)], { stdio: 'ignore' });
    let reported = null;
    child.on('message', (m) => { reported = m; });
    child.on('error', reject);
    child.on('exit', (code) => resolve(reported ?? { fingerprint, valid: code === 0 }));
  });
}

async function testConcurrentClaimsBothSurvive() {
  console.log('\n=== Test 1: Concurrent claims from two processes both survive ===');
  const stateFile = freshDir();

  // Both children load before either writes; the hold makes the overlap
  // deterministic.
  const [a, b] = await Promise.all([
    claimInChild(stateFile, 'aa'.repeat(16), 150),
    claimInChild(stateFile, 'bb'.repeat(16), 150),
  ]);

  assertEqual(a.valid, true, 'Process A was told its claim succeeded');
  assertEqual(b.valid, true, 'Process B was told its claim succeeded');

  // A third process reads what actually survived.
  const verifier = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(
    verifier.claimSessionKey(peer, 'aa'.repeat(16)).valid,
    false,
    "A's claim survived: the fingerprint is still refused"
  );
  assertEqual(
    verifier.claimSessionKey(peer, 'bb'.repeat(16)).valid,
    false,
    "B's claim survived: the fingerprint is still refused"
  );
  verifier.close();
  dropDir();
}

async function testManyConcurrentClaims() {
  console.log('\n=== Test 2: Eight concurrent processes lose nothing ===');
  const stateFile = freshDir();

  const fingerprints = Array.from({ length: 8 }, (_, i) => String(i).repeat(32));
  const results = await Promise.all(fingerprints.map(fp => claimInChild(stateFile, fp, 120)));

  assertEqual(results.filter(r => r.valid).length, 8, 'All eight processes were told their claim succeeded');

  const verifier = new NonceStore({ stateFile, seedPhrase: SEED });
  const survived = fingerprints.filter(fp => verifier.claimSessionKey(peer, fp).valid === false);
  assertEqual(survived.length, 8, 'All eight claims are on disk afterwards');
  verifier.close();
  dropDir();
}

function testStaleLockIsBroken() {
  console.log('\n=== Test 3: A lock left by a dead process is broken, not waited on ===');
  const stateFile = freshDir();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  // pid 2^22 is above the default pid_max, so it cannot be live; the timestamp
  // puts it well past the stale threshold.
  fs.writeFileSync(lockOf(stateFile), JSON.stringify({
    pid: 4194303,
    hostname: os.hostname(),
    acquiredAt: Date.now() - 120_000,
  }));

  const store = new NonceStore({ stateFile, seedPhrase: SEED, lockTimeoutMs: 2000 });
  const started = Date.now();
  const claim = store.claimSessionKey(peer, 'cc'.repeat(16));
  const elapsed = Date.now() - started;

  assertEqual(claim.valid, true, 'The claim succeeds despite the abandoned lock');
  assert(elapsed < 1500, `It did not wait out the timeout (${elapsed}ms)`);
  assert(!fs.existsSync(lockOf(stateFile)), 'The lock file was released afterwards');
  store.close();
  dropDir();
}

function testLiveLockFailsClosed() {
  console.log('\n=== Test 4: A lock held by a live process makes the claim fail closed ===');
  const stateFile = freshDir();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  // Our own pid: alive by definition, and freshly stamped, so never stale.
  fs.writeFileSync(lockOf(stateFile), JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: Date.now(),
  }));

  const store = new NonceStore({ stateFile, seedPhrase: SEED, lockTimeoutMs: 150 });
  const claim = store.claimSessionKey(peer, 'dd'.repeat(16));

  assertEqual(claim.valid, false, 'The claim is REFUSED rather than written unsynchronised');
  assert(
    (claim.reason || '').includes('could not be persisted'),
    'The refusal names the persistence failure'
  );
  store.close();
  dropDir();
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Multi-Process Claim Tests                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testConcurrentClaimsBothSurvive();
    await testManyConcurrentClaims();
    testStaleLockIsBroken();
    testLiveLockFailsClosed();
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
