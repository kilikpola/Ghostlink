/**
 * GMP Concurrent Claim Tests: the at-most-once check is repeated under the
 * lock, so two processes claiming one session key cannot both succeed.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { fork } from 'child_process';
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'helpers', 'race-child.mjs');
const SEED = 'race seed';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-race-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

function raceFor(stateFile, fingerprint, n) {
  const startAt = Date.now() + 400;   // long enough for every child to be loaded and waiting
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const child = fork(CHILD, [stateFile, SEED, fingerprint, String(startAt)], { stdio: 'ignore' });
    let reported = null;
    child.on('message', (m) => { reported = m; });
    child.on('error', reject);
    child.on('exit', () => resolve(reported ?? { valid: false, reason: 'no report' }));
  })));
}

async function testTwoProcessesOneKey() {
  console.log('\n=== Test 1: Two processes claiming one session key — exactly one wins ===');
  const stateFile = freshFile();

  const results = await raceFor(stateFile, 'ff'.repeat(16), 2);
  const winners = results.filter(r => r.valid);

  assertEqual(winners.length, 1, 'Exactly one process was told its claim succeeded');
  assert(
    results.some(r => !r.valid && /already used|concurrently/i.test(r.reason || '')),
    'The loser is told the key was already used, not that the write failed'
  );

  const verifier = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(
    verifier.claimSessionKey(Buffer.alloc(64, 4), 'ff'.repeat(16)).valid,
    false,
    'The fingerprint is claimed on disk afterwards'
  );
  verifier.close();
  dropDir();
}

async function testEightProcessesOneKey() {
  console.log('\n=== Test 2: Eight processes, one session key — still exactly one ===');
  const stateFile = freshFile();

  const results = await raceFor(stateFile, 'ee'.repeat(16), 8);
  const winners = results.filter(r => r.valid);

  assertEqual(winners.length, 1, `Exactly one of eight succeeded (got ${winners.length})`);
  assertEqual(results.length - winners.length, 7, 'The other seven were refused');
  dropDir();
}

async function testDistinctKeysAllSucceed() {
  console.log('\n=== Test 3: Distinct session keys are not affected ===');
  const stateFile = freshFile();

  const startAt = Date.now() + 400;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    const child = fork(CHILD, [stateFile, SEED, `distinct-${i}`.padEnd(32, '0'), String(startAt)], { stdio: 'ignore' });
    let reported = null;
    child.on('message', (m) => { reported = m; });
    child.on('exit', () => resolve(reported ?? { valid: false }));
  })));

  assertEqual(results.filter(r => r.valid).length, 6, 'All six distinct claims succeeded');

  const verifier = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(verifier.claimCount, 6, 'All six are on disk');
  verifier.close();
  dropDir();
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Concurrent Claim Tests                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testTwoProcessesOneKey();
    await testEightProcessesOneKey();
    await testDistinctKeysAllSucceed();
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
