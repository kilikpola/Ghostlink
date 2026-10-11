/**
 * GMP Claim Log Tests: flat latency, partial tails, corrupt records, and
 * migration out of the old in-JSON claims map.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { NonceStore } from '../dist/nonce-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

const SEED = 'claim log seed';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-log-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };
/** The key-scoped claim log path (mirrors ClaimLog.scopedPath). */
function claimsPathFor(stateFile, seed) {
  const key = crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const id = crypto.createHash('sha256').update('gmp-claim-log-id').update(key).digest('hex').slice(0, 16);
  return `${stateFile}.claims.${id}.log`;
}
const claimsOf = (stateFile) => claimsPathFor(stateFile, SEED);
const peer = Buffer.alloc(64, 5);
const fp = (i) => crypto.createHash('sha256').update(`fp-${i}`).digest('hex').slice(0, 32);

/**
 * The whole point: claim latency must not grow with the number of claims held.
 * Under the old in-JSON scheme every claim rewrote the accumulated set, so the
 * 100,000th claim cost about 500ms against the 100th's 0.1ms.
 */
function testLatencyIsFlat() {
  console.log('\n=== Test 1: Claim latency is flat, not linear ===');
  const stateFile = freshFile();
  const store = new NonceStore({ stateFile, seedPhrase: SEED });

  const timeOne = (i) => {
    const started = process.hrtime.bigint();
    store.claimSessionKey(peer, fp(i));
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const early = [];
  for (let i = 0; i < 100; i++) early.push(timeOne(i));
  const earlyMean = early.slice(50).reduce((a, b) => a + b, 0) / 50;

  for (let i = 100; i < 100_000; i++) store.claimSessionKey(peer, fp(i));

  const late = [];
  for (let i = 100_000; i < 100_050; i++) late.push(timeOne(i));
  const lateMean = late.reduce((a, b) => a + b, 0) / late.length;

  assertEqual(store.claimCount, 100_050, '100,050 claims are held');
  console.log(`      100th claim: ${earlyMean.toFixed(3)} ms   100,000th claim: ${lateMean.toFixed(3)} ms`);
  assert(
    lateMean < earlyMean * 5 + 1,
    `The 100,000th claim costs about the same as the 100th (${earlyMean.toFixed(3)}ms -> ${lateMean.toFixed(3)}ms)`
  );

  // And a repeat claim is refused without touching the disk at all.
  const sizeBefore = fs.statSync(claimsOf(stateFile)).size;
  assertEqual(store.claimSessionKey(peer, fp(42)).valid, false, 'An already-claimed fingerprint is refused');
  const sizeAfterRefusal = fs.statSync(claimsOf(stateFile)).size;
  assertAbsent({
    channel: 'claim log file size',
    control: () => { const b = fs.statSync(claimsOf(stateFile)).size; return store.claimSessionKey(peer, fp(200_001)).valid && fs.statSync(claimsOf(stateFile)).size - b; },
    controlMessage: 'an accepted claim grows the file (bytes)',
    absent: () => sizeAfterRefusal === sizeBefore,
    message: 'A refused claim writes nothing',
  });

  store.close();
  dropDir();
}

/** A crash mid-append leaves a partial record. That is ordinary, not corruption. */
function testPartialTailIsDiscarded() {
  console.log('\n=== Test 2: A partial final record is discarded, prior claims intact ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 5; i++) a.claimSessionKey(peer, fp(i));
  a.close();

  // Simulate a process killed partway through writing record six.
  const whole = fs.readFileSync(claims);
  const sealed = Buffer.concat([whole, whole.subarray(0, 20)]);
  fs.writeFileSync(claims, sealed);

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  let b;
  try {
    b = new NonceStore({ stateFile, seedPhrase: SEED });
    b.load();
  } finally { console.error = realErr; }

  assertEqual(b.claimCount, 5, 'All five completed claims are present');
  assert(!seen.some(l => l.includes('state-claim-log-corrupt')), 'No corruption is reported for a partial tail');
  for (let i = 0; i < 5; i++) {
    if (b.claimSessionKey(peer, fp(i)).valid) { assert(false, `Claim ${i} survived`); break; }
  }
  assert(true, 'Every prior claim is still refused');
  b.close();
  dropDir();
}

/** A damaged record in the middle invalidates everything after it, loudly. */
function testMidFileCorruption() {
  console.log('\n=== Test 3: A corrupt record stops the read and is loud ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 10; i++) a.claimSessionKey(peer, fp(i));
  a.close();

  // Flip a byte inside the ciphertext of roughly the fifth record.
  const bytes = fs.readFileSync(claims);
  const target = Math.floor(bytes.length / 2);
  bytes[target] ^= 0xff;
  fs.writeFileSync(claims, bytes);

  const damaged = fs.readFileSync(claims);   // keep a copy: the load below repairs the file

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  let recovered = 0;
  try {
    const b = new NonceStore({ stateFile, seedPhrase: SEED, strictState: false });
    b.load();
    recovered = b.claimCount;
    b.close();
  } finally { console.error = realErr; }

  assert(seen.some(l => l.includes('state-claim-log-corrupt')), 'An ERROR naming state-claim-log-corrupt is logged');
  assert(recovered > 0, `Records before the damage survive (${recovered} recovered)`);
  assert(recovered < 10, 'Records after the damage are not trusted');
  assert(
    seen.some(l => l.includes('claim-log-quarantined')),
    'The unreadable log is set aside and rebuilt so the node can still record claims'
  );
  assert(
    fs.readdirSync(path.dirname(claims)).some(f => f.includes('.corrupt-')),
    'The damaged file is preserved for inspection, not deleted'
  );

  // Strict mode gets its own copy of the damage: the load above repaired the
  // live file, which is the whole point of the quarantine.
  fs.writeFileSync(claims, damaged);
  fs.rmSync(`${claims}.ckpt`, { force: true });
  let threw = null;
  try {
    new NonceStore({ stateFile, seedPhrase: SEED, strictState: true }).load();
  } catch (e) { threw = e; }
  assertEqual(threw && threw.name, 'StateAuthenticationError', 'Strict mode refuses to start');
  dropDir();
}

/** Migration out of a version 2 state file that still carries a claims map. */
function testMigrationFromJson() {
  console.log('\n=== Test 4: Claims migrate out of the state JSON into the log ===');
  const stateFile = freshFile();
  const key = crypto.pbkdf2Sync(SEED, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const peerHex = Buffer.from(peer).toString('hex');

  const v2 = {
    version: 2,
    entries: { [`${peerHex}:${fp(99)}`]: { highWaterMark: 7, lastActivity: Date.now() } },
    claims: {
      [fp(1)]: { peerNodeId: peerHex, claimedAt: Date.now() - 1000 },
      [fp(2)]: { peerNodeId: peerHex, claimedAt: Date.now() - 500 },
      [fp(3)]: { peerNodeId: peerHex, claimedAt: Date.now() },
    },
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v2), 'utf8'), c.final()]);
  fs.writeFileSync(stateFile, JSON.stringify({
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([c.getAuthTag(), ct]).toString('hex'),
    version: 1,
  }, null, 2));

  const store = new NonceStore({ stateFile, seedPhrase: SEED });
  store.load();

  assert(fs.existsSync(claimsOf(stateFile)), 'The claim log was created');
  assertEqual(store.claimCount, 3, 'All three claims came across');
  for (const i of [1, 2, 3]) {
    assertEqual(store.claimSessionKey(peer, fp(i)).valid, false, `Claim ${i} is honoured after migration`);
  }
  store.close();

  // The rewritten state file must no longer carry claims.
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const blob = Buffer.from(raw.ciphertext, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'hex'));
  d.setAuthTag(blob.subarray(0, 16));
  const plain = JSON.parse(Buffer.concat([d.update(blob.subarray(16)), d.final()]).toString('utf8'));
  assertEqual(plain.version, 3, 'The state file is now version 3');
  assertEqual(plain.claims, undefined, 'The state JSON no longer carries a claims map');
  assert(Object.keys(plain.entries).length === 1, 'Counter entries are untouched');

  // Reloading must not re-append the same claims.
  const again = new NonceStore({ stateFile, seedPhrase: SEED });
  again.load();
  assertEqual(again.claimCount, 3, 'A second load does not duplicate the migrated claims');
  again.close();
  dropDir();
}

/** Durability: a claim is on disk before claimSessionKey returns. */
function testClaimDurableBeforeReturn() {
  console.log('\n=== Test 5: A claim is durable before it returns ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(a.claimSessionKey(peer, fp(7)).valid, true, 'Claim succeeds');
  // No close(): stand in for SIGKILL immediately afterwards.

  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(b.claimSessionKey(peer, fp(7)).valid, false, 'A new process already sees it');
  b.close();
  dropDir();
}


/** A partial record from a crash must not swallow claims appended after it. */
function testAppendBehindPartialRecord() {
  console.log('\n=== Test 6: A claim appended after a partial record survives a reload ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 4; i++) a.claimSessionKey(peer, fp(i));
  a.close();

  // A process killed partway through writing record five.
  const whole = fs.readFileSync(claims);
  fs.writeFileSync(claims, Buffer.concat([whole, whole.subarray(0, 24)]));
  fs.rmSync(`${claims}.ckpt`, { force: true });

  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(b.claimSessionKey(peer, 'after-partial').valid, true, 'A new claim is accepted');
  b.close();

  // The claim must be visible to a process that reads the file from scratch.
  fs.rmSync(`${claims}.ckpt`, { force: true });
  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(
    c.claimSessionKey(peer, 'after-partial').valid,
    false,
    'It is still claimed after a full reload — not stranded behind the partial record'
  );
  for (let i = 0; i < 4; i++) {
    if (c.claimSessionKey(peer, fp(i)).valid) { assert(false, `Earlier claim ${i} survived`); break; }
  }
  assert(true, 'And every earlier claim survived too');
  c.close();
  dropDir();
}

/**
 * FIX 2, the other half: corruption is not a partial record, and must not be
 * truncated away. Appending is refused instead, and the file is left alone.
 */
function testAppendRefusedOnCorruption() {
  console.log('\n=== Test 7: A corrupt log refuses appends and is not truncated ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 6; i++) a.claimSessionKey(peer, fp(100 + i));
  a.close();

  // A live store with a valid offset, facing a bad record written past it —
  // which is what another writer producing damage actually looks like.
  // Overwriting the whole file behind the store instead would leave its offset
  // pointing into unrelated bytes, which is a different (and unreal) scenario.
  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  b.load();

  const garbage = Buffer.alloc(64);
  garbage.writeUInt32BE(0x00ffffff, 0);    // a length far beyond the 64 KiB cap
  fs.appendFileSync(claims, garbage);
  const sizeBefore = fs.statSync(claims).size;

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  let result;
  try {
    result = b.claimSessionKey(peer, 'against-corruption');
  } finally { console.error = realErr; }

  assertEqual(result.valid, false, 'The claim is REFUSED rather than appended behind the damage');
  assert(
    seen.some(l => l.includes('claim-log-append-blocked')),
    'The refusal is logged as claim-log-append-blocked'
  );
  assertEqual(fs.statSync(claims).size, sizeBefore, 'The damaged file was not truncated');
  b.close();
  dropDir();
}


/**
 * A log that cannot be read (EMFILE, EACCES, EIO...) is not treated as
 * corrupt, so it is never rebuilt from an empty index.
 */
function testUnreadableLogIsNotCorruption() {
  console.log('\n=== Test 8: An unreadable log is left alone, not quarantined ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 5; i++) a.claimSessionKey(peer, fp(200 + i));
  a.close();

  const before = fs.readFileSync(claims);
  fs.chmodSync(claims, 0o000);
  // Running as root ignores the mode bits, in which case this cannot be tested
  // this way; skip rather than assert something untrue.
  let readable = true;
  try { fs.readFileSync(claims); } catch { readable = false; }
  if (readable) {
    console.log('  — skipped: the file is readable despite mode 000 (running as root?)');
    fs.chmodSync(claims, 0o600);
    dropDir();
    return;
  }

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  try {
    const b = new NonceStore({ stateFile, seedPhrase: SEED, strictState: false });
    b.load();
    b.close();
  } finally { console.error = realErr; }

  assert(seen.some(l => l.includes('state-log-unreadable')), 'An ERROR naming state-log-unreadable is logged');
  assert(!seen.some(l => l.includes('claim-log-quarantined')), 'The log was NOT quarantined');
  assert(
    !fs.readdirSync(path.dirname(claims)).some(f => f.includes('.corrupt-')),
    'No .corrupt- rename happened'
  );

  fs.chmodSync(claims, 0o600);
  assert(fs.readFileSync(claims).equals(before), 'The log is byte-identical: nothing was rebuilt over it');

  // And the claims are all still there once it can be read again.
  const c = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(c.claimCount, 5, 'Every claim survived the unreadable start');
  c.close();

  // Strict mode must refuse rather than run without a replay record.
  fs.chmodSync(claims, 0o000);
  let threw = null;
  try {
    const realErr2 = console.error;
    console.error = () => {};
    try { new NonceStore({ stateFile, seedPhrase: SEED, strictState: true }).load(); } finally { console.error = realErr2; }
  } catch (e) { threw = e; }
  assertEqual(threw && threw.name, 'StateAuthenticationError', 'Strict mode refuses to start');

  fs.chmodSync(claims, 0o600);
  dropDir();
}

/**
 * The offset invariant assertion itself. Four separate paths have set
 * consumedBytes to something that was not a record boundary; this is what is
 * meant to catch the fifth.
 */
function testBoundaryAssertionFires() {
  console.log('\n=== Test 9: A bad offset trips the invariant assertion ===');
  const stateFile = freshFile();

  const store = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 4; i++) store.claimSessionKey(peer, fp(300 + i));

  const log = store.claimLog;
  const goodOffset = log.consumedBytes;
  const goodAccounted = log.bytesAccountedFor;

  // (a) The offset advanced past a boundary — the shape of every one of the
  //     four historical bugs.
  log.consumedBytes = goodOffset - 3;
  let threw = null;
  try { log._assertConsumedBoundary('deliberate'); } catch (e) { threw = e; }
  assert(threw !== null, 'An offset that is not a record boundary throws');
  assert(
    threw && /offset invariant violated/.test(threw.message),
    'The message names the invariant that was broken'
  );

  // (b) The accounting witness catches an offset taken from the filesystem
  //     even when it happens to land on a boundary.
  log.consumedBytes = goodOffset;
  log.bytesAccountedFor = goodAccounted - 1;
  threw = null;
  try { log._assertConsumedBoundary('deliberate'); } catch (e) { threw = e; }
  assert(threw !== null, 'An offset not backed by accounted-for records throws');
  assert(
    threw && /accounted for/.test(threw.message),
    'The message says how many bytes were actually accounted for'
  );

  // (c) And the healthy state passes.
  log.bytesAccountedFor = goodAccounted;
  threw = null;
  try { log._assertConsumedBoundary('deliberate'); } catch (e) { threw = e; }
  assert(threw === null, 'A correct offset passes');

  store.close();
  dropDir();
}

function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Claim Log Tests                                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testLatencyIsFlat();
    testPartialTailIsDiscarded();
    testMidFileCorruption();
    testMigrationFromJson();
    testClaimDurableBeforeReturn();
    testAppendBehindPartialRecord();
    testAppendRefusedOnCorruption();
    testUnreadableLogIsNotCorruption();
    testBoundaryAssertionFires();
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
