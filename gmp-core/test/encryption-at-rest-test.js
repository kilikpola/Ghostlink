/**
 * GMP Encryption-At-Rest Test Suite — Phase 5
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { PeerCache } from '../dist/peer-cache.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

const tempCachePath = path.join(__dirname, 'data', 'temp-enc-cache.json');
const tempNoncePath = path.join(__dirname, 'data', 'temp-enc-nonce.json');

function cleanTempFiles() {
  if (fs.existsSync(tempCachePath)) {
    try { fs.unlinkSync(tempCachePath); } catch (e) {}
  }
  if (fs.existsSync(tempNoncePath)) {
    try { fs.unlinkSync(tempNoncePath); } catch (e) {}
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 5 — Encryption At Rest Tests                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    testRoundTrip();
    testTamperedCiphertextFallback();
    testWrongKeyFallback();
    testNoPlaintextOnDisk();

    cleanTempFiles();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempFiles();
    process.exit(1);
  }
}

function testRoundTrip() {
  console.log('\n=== Test 1: Write Encrypted Cache, Read It Back ===');

  const seed = 'test seed phrase one';
  const cache1 = new PeerCache({ filePath: tempCachePath, seedPhrase: seed });
  
  // Record success to populate cache
  cache1.recordSuccess('node_id_1234567890123456789012345678901234567890123456789012345678901234', '192.168.1.100', 49500);

  const cache2 = new PeerCache({ filePath: tempCachePath, seedPhrase: seed });
  assertEqual(cache2.cache.length, 1, "Cache successfully loaded encrypted entry");
  assertEqual(cache2.cache[0].address, '192.168.1.100', "Address matches");
  assertEqual(cache2.cache[0].port, 49500, "Port matches");
}

function testTamperedCiphertextFallback() {
  console.log('\n=== Test 2: Tampered Ciphertext Fallback ===');

  const seed = 'test seed phrase one';
  const cache1 = new PeerCache({ filePath: tempCachePath, seedPhrase: seed });
  cache1.recordSuccess('node_id_1234567890123456789012345678901234567890123456789012345678901234', '192.168.1.100', 49500);

  // Tamper with the file on disk
  const raw = fs.readFileSync(tempCachePath, 'utf8');
  const parsed = JSON.parse(raw);
  // Flip the first character of the ciphertext to something it is not. A flat
  // `'a' + ...` was a no-op whenever the (random) auth tag already started with
  // 'a', so 1 run in 16 wrote the file back unchanged, decrypted fine, and
  // failed the assertion below.
  parsed.ciphertext = (parsed.ciphertext[0] === 'a' ? 'b' : 'a') + parsed.ciphertext.slice(1);
  fs.writeFileSync(tempCachePath, JSON.stringify(parsed), 'utf8');

  // Attempt to read tampered file
  let loadedWithoutCrash = false;
  let cache2;
  try {
    cache2 = new PeerCache({ filePath: tempCachePath, seedPhrase: seed });
    loadedWithoutCrash = true;
  } catch (e) {
    loadedWithoutCrash = false;
  }

  assert(loadedWithoutCrash, "Decryption failure does not cause a crash");
  assertEqual(cache2.cache.length, 0, "Cache falls back to empty array");
}

function testWrongKeyFallback() {
  console.log('\n=== Test 3: Wrong Key Fallback ===');

  const seedA = 'seed phrase A';
  const seedB = 'seed phrase B';

  const cache1 = new PeerCache({ filePath: tempCachePath, seedPhrase: seedA });
  cache1.recordSuccess('node_id_1234567890123456789012345678901234567890123456789012345678901234', '192.168.1.100', 49500);

  // Attempt to read with seedB
  const cache2 = new PeerCache({ filePath: tempCachePath, seedPhrase: seedB });
  assertEqual(cache2.cache.length, 0, "Decryption with wrong key fails gracefully, starting fresh");
}

function testNoPlaintextOnDisk() {
  console.log('\n=== Test 4: Confirm No Plaintext on Disk ===');

  const seed = 'test seed phrase one';
  const cache1 = new PeerCache({ filePath: tempCachePath, seedPhrase: seed });
  cache1.recordSuccess('node_id_1234567890123456789012345678901234567890123456789012345678901234', '192.168.1.100', 49500);

  const raw = fs.readFileSync(tempCachePath, 'utf8');
  assert(!raw.includes('192.168.1.100'), "Plaintext IP address is not visible on disk");
  assert(!raw.includes('node_id_1234567890123456789012345678901234567890123456789012345678901234'), "Plaintext NodeID is not visible on disk");
  if (process.platform !== 'win32') {
    assertEqual((fs.statSync(tempCachePath).mode & 0o777).toString(8), '600', "State file is written owner-only (0600)");
  }
}

runTests();
