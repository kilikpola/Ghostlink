/**
 * GMP Nonce Store Durability Tests: a claim is durable before success is
 * reported, a failed write fails closed, partial writes never damage existing
 * state, and throughput holds.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
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

const SEED = 'durability test seed phrase';
const statePath = path.join(__dirname, 'data', 'temp-durability-nonce.json');
/** The key-scoped claim log path (mirrors ClaimLog.scopedPath). */
function claimsPathFor(stateFile, seed) {
  const key = crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const id = crypto.createHash('sha256').update('gmp-claim-log-id').update(key).digest('hex').slice(0, 16);
  return `${stateFile}.claims.${id}.log`;
}
const claimsPath = claimsPathFor(statePath, SEED);
const lockPath = `${claimsPath}.lock`;
// Temp names carry the pid and random bytes so two writers cannot collide on
// one file; a test can no longer block a write by planting `<path>.tmp`.
const tempFiles = () => {
  const dir = path.dirname(statePath);
  const prefix = `${path.basename(claimsPath)}.`;
  try {
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.tmp'));
  } catch { return []; }
};

/**
 * Make every write fail by holding the store's lock, so _saveNow() times out
 * and the caller must fail closed.
 */
function blockWrites() {
  fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,            // alive, so the lock is never judged stale
    hostname: os.hostname(),
    acquiredAt: Date.now(),
  }));
}
const unblockWrites = () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* gone */ } };

// A short lock timeout keeps the blocked-write tests quick.
const IMPATIENT = { lockTimeoutMs: 150 };

function clean() {
  const dir = path.dirname(statePath);
  // Checkpoints and quarantined logs outlive the log itself, and a checkpoint
  // left behind by an earlier run points into a file that no longer exists.
  const strays = (() => {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.startsWith(path.basename(statePath)) && f !== path.basename(statePath))
        .map(f => path.join(dir, f));
    } catch { return []; }
  })();
  for (const p of [statePath, claimsPath, lockPath, ...strays, ...tempFiles().map(f => path.join(dir, f))]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* not there */ }
  }
}

const peer = Buffer.alloc(64, 7);

/**
 * A claim must be on disk before success is reported: the writing store is
 * never closed, so a fresh store can only see it if claimSessionKey wrote it.
 */
function testClaimIsDurableWithoutClose() {
  console.log('\n=== Test 1: A successful claim is durable before it returns ===');
  clean();

  const store1 = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  const claim = store1.claimSessionKey(peer, 'fingerprint-aaaa');
  assertEqual(claim.valid, true, 'First claim succeeds');

  assert(fs.existsSync(claimsPath), 'The claim log exists the moment the claim returns');

  // Deliberately no store1.close(): stand in for SIGKILL / OOM / power loss.
  const store2 = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  const replay = store2.claimSessionKey(peer, 'fingerprint-aaaa');
  assertEqual(replay.valid, false, 'A new process sees the claim and refuses the same session key');
  assert(
    (replay.reason || '').includes('already used'),
    'The refusal names session key reuse'
  );

  store2.close();
  clean();
}

/**
 * If the write cannot happen, the claim must be refused rather than reported as
 * successful. The failure is induced by holding the store's lock, so the write
 * times out — no dependence on file permissions, which root would ignore.
 */
function testPersistenceFailureRejectsTheClaim() {
  console.log('\n=== Test 2: A claim that cannot be persisted is refused ===');
  clean();

  blockWrites();

  const store = new NonceStore({ stateFile: statePath, seedPhrase: SEED, ...IMPATIENT });
  const claim = store.claimSessionKey(peer, 'fingerprint-bbbb');

  assertEqual(claim.valid, false, 'Claim is REJECTED when the state cannot be written');
  assert(
    (claim.reason || '').includes('could not be persisted'),
    'The refusal says the claim could not be persisted'
  );
  assert(!fs.existsSync(claimsPath), 'No claim record was produced');

  unblockWrites();
  clean();
}

/** A half-finished write must never damage the state already on disk. */
function testPartialWriteLeavesOriginalIntact() {
  console.log('\n=== Test 3: A partial write leaves the original state intact ===');
  clean();

  const store1 = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  assertEqual(store1.claimSessionKey(peer, 'fingerprint-cccc').valid, true, 'Baseline claim succeeds');
  store1.close();

  const goodBytes = fs.readFileSync(claimsPath);

  // (a) A crashed write leaves a temp file behind. It must be inert: nothing
  //     ever renames a temp file it did not itself create.
  const orphan = `${claimsPath}.999999.abcdef123456.tmp`;
  fs.writeFileSync(orphan, goodBytes.subarray(0, Math.floor(goodBytes.length / 3)));
  assert(
    fs.readFileSync(claimsPath).equals(goodBytes),
    'A stale truncated temp file does not touch the live claim log'
  );
  fs.rmSync(orphan, { force: true });

  // (b) The sharper case: a write that FAILS while state already exists. The
  //     live file must survive it whole — a writer that opens the target with
  //     O_TRUNC would have emptied it by this point.
  blockWrites();
  const store2 = new NonceStore({ stateFile: statePath, seedPhrase: SEED, ...IMPATIENT });
  const refused = store2.claimSessionKey(peer, 'fingerprint-dddd');
  assertEqual(refused.valid, false, 'The claim is refused while the write is failing');
  assert(
    fs.readFileSync(claimsPath).equals(goodBytes),
    'The pre-existing claim log is byte-identical after the failed write'
  );
  unblockWrites();

  // (c) And what survived is real state, not just intact bytes.
  const store3 = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  assertEqual(
    store3.claimSessionKey(peer, 'fingerprint-cccc').valid,
    false,
    'The surviving state still loads and still refuses the previously claimed key'
  );
  assertEqual(
    store3.claimSessionKey(peer, 'fingerprint-eeee').valid,
    true,
    'A different key is still claimable, so the state is not merely unreadable'
  );
  store3.close();

  assertEqual(tempFiles().length, 0, 'No temp file is left behind after a successful write');

  clean();
}

/**
 * The claim path is allowed to be slow because it runs once per handshake. The
 * per-message path is not: updateCounters() must stay batched, or every frame
 * pays for an fsync.
 */
function testUpdateCountersStaysBatched() {
  console.log('\n=== Test 4: Per-message updateCounters() does not write synchronously ===');
  clean();

  const store = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  const sessionKey = 'fingerprint-eeee';

  for (let i = 1; i <= 50; i++) {
    store.updateCounters(peer, sessionKey, i, i);
  }

  assert(
    !fs.existsSync(statePath),
    '50 counter updates wrote nothing to the state file (still inside the 1s batching window)'
  );

  const started = process.hrtime.bigint();
  for (let i = 51; i <= 5050; i++) {
    store.updateCounters(peer, sessionKey, i, i);
  }
  const perCallUs = Number(process.hrtime.bigint() - started) / 1000 / 5000;

  // An fsync per call is tens to hundreds of microseconds even on NVMe. Staying
  // far below that is what shows the writes are not happening inline.
  assert(
    perCallUs < 20,
    `updateCounters costs ${perCallUs.toFixed(2)}µs/call, well under a per-call fsync`
  );

  // And the batched write still lands, so batching is not silently dropping it.
  store.close();
  assert(fs.existsSync(statePath), 'close() flushes the batched counter updates');

  const reloaded = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  const entry = reloaded.getEntry(peer, sessionKey);
  assert(entry !== null, 'The batched entry survived the flush');
  assertEqual(entry && entry.sendHighWater, 5050, 'It carries the final counter value');
  reloaded.close();

  clean();
}


// ─────────────────────────────────────────────────────────────────────────
// Merge-on-load: a claim made before an encryption key exists must survive
// setEncryptionKey().
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

const keyFor = (seed) => crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');

function testPreKeyClaimSurvivesSetEncryptionKey() {
  console.log('\n=== Test 5: A claim made before the key is set survives setEncryptionKey ===');
  clean();

  const store = new NonceStore({ stateFile: statePath });
  assertEqual(store.claimSessionKey(peer, 'fp-A').valid, true, 'Fingerprint A is claimable with no key set');

  assertEqual(store.setEncryptionKey(keyFor(SEED)), true, 'setEncryptionKey reports success');

  assertEqual(
    store.claimSessionKey(peer, 'fp-A').valid,
    false,
    'Fingerprint A is REFUSED after the key is set (the claim was not discarded)'
  );

  store.close();
  clean();
}

function testMergeUnionsMemoryAndDisk() {
  console.log('\n=== Test 6: Pre-key claim and on-disk claim are unioned ===');
  clean();

  // Disk already holds a claim for B.
  const seeded = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  assertEqual(seeded.claimSessionKey(peer, 'fp-B').valid, true, 'Fingerprint B is claimed and persisted');
  seeded.close();

  // A fresh store claims A before it has a key.
  const store = new NonceStore({ stateFile: statePath });
  assertEqual(store.claimSessionKey(peer, 'fp-A').valid, true, 'Fingerprint A is claimed in memory');
  assertEqual(store.setEncryptionKey(keyFor(SEED)), true, 'setEncryptionKey reports success');

  assertEqual(store.claimSessionKey(peer, 'fp-A').valid, false, 'A stays claimed (from memory)');
  assertEqual(store.claimSessionKey(peer, 'fp-B').valid, false, 'B stays claimed (from disk)');
  assertEqual(store.claimSessionKey(peer, 'fp-C').valid, true, 'An unrelated fingerprint is still claimable');

  store.close();
  clean();
}

/** Build a store whose persisted entry for `session` sits at `mark`. */
function seedDiskAt(session, mark) {
  const s = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  s.updateCounters(peer, session, mark, mark);
  s.close();
}

function testMergeKeepsHigherInMemoryMark() {
  console.log('\n=== Test 7: In-memory 50 vs disk 30 → merged mark is 50 ===');
  clean();

  seedDiskAt('sess-hw', 30);

  const store = new NonceStore({ stateFile: statePath });
  store.updateCounters(peer, 'sess-hw', 50, 50);
  assertEqual(store.setEncryptionKey(keyFor(SEED)), true, 'setEncryptionKey reports success');

  const entry = store.getEntry(peer, 'sess-hw');
  assertEqual(entry && entry.sendHighWater, 50, 'sendHighWater is the in-memory 50, not the loaded 30');
  assertEqual(entry && entry.recvHighWater, 50, 'recvHighWater is the in-memory 50, not the loaded 30');
  assertEqual(entry && entry.highWaterMark, 50, 'The aggregate mark is 50');

  store.close();
  clean();
}

function testMergeKeepsHigherDiskMark() {
  console.log('\n=== Test 8: In-memory 30 vs disk 50 → merged mark is 50 ===');
  clean();

  seedDiskAt('sess-hw', 50);

  const store = new NonceStore({ stateFile: statePath });
  store.updateCounters(peer, 'sess-hw', 30, 30);
  assertEqual(store.setEncryptionKey(keyFor(SEED)), true, 'setEncryptionKey reports success');

  const entry = store.getEntry(peer, 'sess-hw');
  assertEqual(entry && entry.sendHighWater, 50, 'sendHighWater is the loaded 50, not the in-memory 30');
  assertEqual(entry && entry.recvHighWater, 50, 'recvHighWater is the loaded 50, not the in-memory 30');
  assertEqual(entry && entry.highWaterMark, 50, 'The aggregate mark is 50');

  // And the merged mark actually gates: a reconnect at 40 must be refused.
  assertEqual(
    store.checkAndUpdate(peer, 'sess-hw', 40, 40).allowed,
    false,
    'A reconnect below the merged mark is refused'
  );

  store.close();
  clean();
}

function testMergedStateIsDurableBeforeReturn() {
  console.log('\n=== Test 9: Merged state is on disk before setEncryptionKey returns ===');
  clean();

  const store = new NonceStore({ stateFile: statePath });
  assertEqual(store.claimSessionKey(peer, 'fp-durable').valid, true, 'Fingerprint claimed with no key');
  assertEqual(store.setEncryptionKey(keyFor(SEED)), true, 'setEncryptionKey reports success');

  // No close() on `store`: stand in for a crash straight after startup.
  const other = new NonceStore({ stateFile: statePath, seedPhrase: SEED });
  assertEqual(
    other.claimSessionKey(peer, 'fp-durable').valid,
    false,
    'A separate store instance already sees the merged claim'
  );

  other.close();
  clean();
}

function testMergePersistFailureFailsClosed() {
  console.log('\n=== Test 10: A merge that cannot be persisted fails closed ===');
  clean();

  const store = new NonceStore({ stateFile: statePath, ...IMPATIENT });
  assertEqual(store.claimSessionKey(peer, 'fp-fail').valid, true, 'Fingerprint claimed with no key');

  blockWrites();

  assertEqual(
    store.setEncryptionKey(keyFor(SEED)),
    false,
    'setEncryptionKey reports FAILURE when the merged state cannot be written'
  );

  // The merge still happened in memory, so this process stays protected.
  assertEqual(
    store.claimSessionKey(peer, 'fp-fail').valid,
    false,
    'The claim is still honoured in memory despite the failed write'
  );

  unblockWrites();
  clean();
}

function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Nonce Store Durability Tests                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    testClaimIsDurableWithoutClose();
    testPersistenceFailureRejectsTheClaim();
    testPartialWriteLeavesOriginalIntact();
    testUpdateCountersStaysBatched();
    testPreKeyClaimSurvivesSetEncryptionKey();
    testMergeUnionsMemoryAndDisk();
    testMergeKeepsHigherInMemoryMark();
    testMergeKeepsHigherDiskMark();
    testMergedStateIsDurableBeforeReturn();
    testMergePersistFailureFailsClosed();
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

runTests();
