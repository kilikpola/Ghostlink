/**
 * GMP Claim Checkpoint Tests
 *
 * Every record in the claim log is sealed on its own, so replaying a large log
 * means one AES-GCM opening per claim — about 34 seconds at a million. The
 * checkpoint is a single sealed snapshot of the index at a known byte offset,
 * so a start reads that and replays only what was appended since.
 *
 * It is a cache and never the authority: these check that a checkpoint which
 * cannot be trusted is discarded in favour of the log, not believed.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const SEED = 'checkpoint seed';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-ckpt-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };
/**
 * The claim log is named after the key that seals it, so that two identities
 * sharing a data directory do not write records into one file that neither can
 * fully read. Mirrors ClaimLog._scopePathToKey; prefer `store.claimsFile` where
 * a store is in scope.
 */
function claimsPathFor(stateFile, seed) {
  const key = crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const id = crypto.createHash('sha256').update('gmp-claim-log-id').update(key).digest('hex').slice(0, 16);
  return `${stateFile}.claims.${id}.log`;
}
const claimsOf = (s) => claimsPathFor(s, SEED);
const ckptOf = (s) => `${claimsOf(s)}.ckpt`;
const peer = Buffer.alloc(64, 3);
const fp = i => crypto.createHash('sha256').update('c' + i).digest('hex').slice(0, 32);

/** Fill a log past the checkpoint threshold and confirm one gets written. */
function testCheckpointIsWritten() {
  console.log('\n=== Test 1: A checkpoint is written once the tail is long enough ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 30_000; i++) a.claimSessionKey(peer, fp(i));
  a.close();
  // close() now always leaves a current snapshot, so an orderly stop never
  // costs the next start a replay of everything since the last threshold.
  assert(fs.existsSync(ckptOf(stateFile)), 'A clean shutdown writes a checkpoint unconditionally');

  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();
  assertEqual(b.claimCount, 30_000, 'All 30,000 claims are indexed');
  assert(fs.existsSync(ckptOf(stateFile)), 'The checkpoint is still present after a reload');
  assert(
    fs.statSync(ckptOf(stateFile)).size < fs.statSync(claimsOf(stateFile)).size / 4,
    'The checkpoint is far smaller than the log it summarises'
  );
  b.close();

  // And a start from the checkpoint is materially faster than a full replay.
  const withCkpt = process.hrtime.bigint();
  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  c.load();
  const withCkptMs = Number(process.hrtime.bigint() - withCkpt) / 1e6;
  assertEqual(c.claimCount, 30_000, 'The checkpointed start sees every claim');
  c.close();

  fs.rmSync(ckptOf(stateFile));
  const without = process.hrtime.bigint();
  const d = new NonceStore({ stateFile, seedPhrase: SEED });
  d.load();
  const withoutMs = Number(process.hrtime.bigint() - without) / 1e6;
  d.close();

  console.log(`      full replay ${withoutMs.toFixed(0)} ms   from checkpoint ${withCkptMs.toFixed(0)} ms`);
  assert(withCkptMs < withoutMs / 2, `Starting from the checkpoint is at least twice as fast`);
  dropDir();
}

/** Claims appended after the checkpoint must still be seen. */
function testTailAfterCheckpoint() {
  console.log('\n=== Test 2: Claims appended after the checkpoint are replayed ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 30_000; i++) a.claimSessionKey(peer, fp(i));
  a.close();
  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();                       // writes the checkpoint
  assert(fs.existsSync(ckptOf(stateFile)), 'Checkpoint exists');
  b.claimSessionKey(peer, 'tail-one');
  b.claimSessionKey(peer, 'tail-two');
  b.close();

  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(c.claimSessionKey(peer, 'tail-one').valid, false, 'A claim made after the checkpoint is honoured');
  assertEqual(c.claimSessionKey(peer, 'tail-two').valid, false, 'And so is the next one');
  assertEqual(c.claimSessionKey(peer, fp(5)).valid, false, 'A claim from inside the checkpoint is honoured');
  c.close();
  dropDir();
}

/** A corrupt checkpoint must be discarded, not believed. */
function testCorruptCheckpointFallsBack() {
  console.log('\n=== Test 3: A checkpoint that will not authenticate is discarded ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 30_000; i++) a.claimSessionKey(peer, fp(i));
  a.close();
  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();
  b.close();

  const bytes = fs.readFileSync(ckptOf(stateFile));
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(ckptOf(stateFile), bytes);

  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  c.load();
  assertEqual(c.claimCount, 30_000, 'Every claim is recovered by replaying the log in full');
  assertEqual(c.claimSessionKey(peer, fp(7)).valid, false, 'And the claims are enforced');
  c.close();
  dropDir();
}

/**
 * A checkpoint covering more bytes than the log holds means the log was
 * shortened. The checkpoint is refused and the discrepancy is reported.
 */
function testCheckpointAheadOfLog() {
  console.log('\n=== Test 4: A log shorter than its checkpoint is reported ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 30_000; i++) a.claimSessionKey(peer, fp(i));
  a.close();
  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();
  b.close();

  // Cut the log in half, leaving the checkpoint describing the whole thing.
  const log = fs.readFileSync(claimsOf(stateFile));
  fs.writeFileSync(claimsOf(stateFile), log.subarray(0, Math.floor(log.length / 2)));

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  let c;
  try {
    c = new NonceStore({ stateFile, seedPhrase: SEED });
    c.load();
  } finally { console.error = realErr; }

  assert(
    seen.some(l => l.includes('claim-log-shorter-than-checkpoint')),
    'An ERROR naming claim-log-shorter-than-checkpoint is logged'
  );
  assert(c.claimCount > 0 && c.claimCount < 30_000, `Only the surviving claims are held (${c.claimCount})`);
  assertEqual(c.claimSessionKey(peer, fp(1)).valid, false, 'Claims that survived are still enforced');
  c.close();
  dropDir();
}

/**
 * The bug that made the checkpoint unsafe to build: an appending process used
 * to advance its byte offset by its own write alone, so a record another
 * process appended in between was skipped forever — and a checkpoint built on
 * that offset would claim to cover a claim it had never seen.
 */
function testConcurrentAppendIsNotSkipped() {
  console.log('\n=== Test 5: An append catches up on another process first ===');
  const stateFile = freshFile();

  const A = new NonceStore({ stateFile, seedPhrase: SEED }).load();
  const B = new NonceStore({ stateFile, seedPhrase: SEED }).load();

  assertEqual(A.claimSessionKey(peer, 'from-A').valid, true, 'A claims');
  assertEqual(B.claimSessionKey(peer, 'from-B').valid, true, 'B claims, having missed A’s write');

  // B's offset must now account for A's record as well as its own, so a
  // checkpoint B writes describes a prefix it has genuinely read.
  B.load();
  assertEqual(B.claimSessionKey(peer, 'from-A').valid, false, "B sees A's claim after catching up");
  A.close(); B.close();

  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(c.claimSessionKey(peer, 'from-A').valid, false, "A's claim survived");
  assertEqual(c.claimSessionKey(peer, 'from-B').valid, false, "B's claim survived");
  c.close();
  dropDir();
}


/**
 * FIX 3: the checkpoint must be driven by appends, not by a start discovering a
 * long tail. Checking only at load meant the checkpoint never prevented the
 * replay it exists to prevent — by the time the check ran, the whole log had
 * already been replayed.
 */
function testThresholdBoundsUncleanRestart() {
  console.log('\n=== Test 6: An unclean stop replays at most the threshold ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 60_000; i++) a.claimSessionKey(peer, fp(i));
  // No close(): stand in for SIGKILL. The deferred checkpoint has had chances
  // to fire between claims, so a current-ish snapshot should already be down.
  assert(fs.existsSync(ckptOf(stateFile)), 'A checkpoint was written during normal operation');

  const started = process.hrtime.bigint();
  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assertEqual(b.claimCount, 60_000, 'Every claim is present after the unclean stop');
  console.log(`      restart after 60,000 claims with no clean shutdown: ${ms.toFixed(0)} ms`);
  assert(ms < 1500, `Replay was bounded, not a full 60,000-record pass (${ms.toFixed(0)} ms)`);
  b.close();
  dropDir();
}

/** The checkpoint write must stay off the handshake path. */
async function testCheckpointDoesNotStallClaims() {
  console.log('\n=== Test 7: A checkpoint write does not stall claimSessionKey ===');
  const stateFile = freshFile();
  const store = new NonceStore({ stateFile, seedPhrase: SEED });

  // Yield between batches, as a node handling handshakes does. A loop that
  // never yields cannot run the deferred write at all, so it hits the ceiling
  // and pays for one checkpoint inline by design (CHECKPOINT_CEILING_RECORDS);
  // timing that loop measured the write itself — tens of ms on a fast machine,
  // ~96 ms on a busy CI runner — not whether claims stay off it.
  // The timing bound alone cannot tell "deferred" from "inline but fast": on
  // a quick machine an inline checkpoint also fits under it. So also watch the
  // checkpoint file itself — if it changes across a single synchronous
  // claimSessionKey() call, that claim wrote it. (Stat'd outside the timing.)
  const ckpt = ckptOf(stateFile);
  const ckptStamp = () => {
    const st = fs.statSync(ckpt, { throwIfNoEntry: false, bigint: true });
    return st ? `${st.ino}:${st.mtimeNs}:${st.size}` : '';
  };
  let inlineWrites = 0;
  const timings = [];
  for (let i = 0; i < 60_000; i++) {
    const before = ckptStamp();
    const t = process.hrtime.bigint();
    store.claimSessionKey(peer, fp(i));
    timings.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (ckptStamp() !== before) inlineWrites++;
    if (i % 500 === 499) await new Promise((r) => setImmediate(r));
  }
  // Written by the deferred timer during the loop, not by close() below.
  const deferredCheckpoint = fs.existsSync(ckptOf(stateFile));
  store.close();

  timings.sort((x, y) => x - y);
  const median = timings[Math.floor(timings.length / 2)];
  const worst = timings[timings.length - 1];
  const p999 = timings[Math.floor(timings.length * 0.999)];
  console.log(`      median ${median.toFixed(3)} ms   p99.9 ${p999.toFixed(2)} ms   worst ${worst.toFixed(1)} ms   over 60,000 claims`);

  assert(deferredCheckpoint, 'A checkpoint was written while claims continued');
  assertEqual(inlineWrites, 0, 'No claimSessionKey() call wrote the checkpoint itself');
  // Whether a claim wrote the checkpoint is settled structurally above. The
  // timing bound is only a sanity check that claims stay cheap. It uses the
  // 99.9th percentile, not the single worst claim: on shared CI runners one
  // GC pause or CPU-steal hiccup in 60,000 calls hit 70-96 ms and failed the
  // old max-based bound while no checkpoint was anywhere near the claim path.
  assert(p999 < 20, `Claims stay cheap: 99.9% finish under 20 ms (p99.9 ${p999.toFixed(2)} ms)`);
  dropDir();
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Claim Checkpoint Tests                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testCheckpointIsWritten();
    testTailAfterCheckpoint();
    testCorruptCheckpointFallsBack();
    testCheckpointAheadOfLog();
    testConcurrentAppendIsNotSkipped();
    testThresholdBoundsUncleanRestart();
    await testCheckpointDoesNotStallClaims();
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
