import './helpers/isolate-data.mjs'; // must stay first
import { createGMPNode } from '../dist/node-factory.js';
import { deriveIdentityFromSeedPhrase, signMessage, stringToBytes, bytesToHex } from '../dist/identity.js';
import { decidePin, pinOnPresented } from '../dist/contact-pin.js';
import logger from '../dist/logger.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
const { assertAbsent } = absenceAsserter(assert);
function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-pin-${tag}-`)); }
const ID_A = 'a'.repeat(128);
const ID_B = 'b'.repeat(128);

async function run() {
  // ---- T2: the pure pin decision ----
  console.log('\n=== T2: contact pinned to a NodeID; a different NodeID is a mismatch ===');
  assert(decidePin({ pinnedNodeId: ID_A, presentedNodeId: ID_B, rotationVerified: false }) === 'mismatch',
    'different presented NodeID with no verified rotation -> mismatch');
  assert(decidePin({ pinnedNodeId: ID_A, presentedNodeId: ID_A, rotationVerified: false }) === 'accept',
    'positive control: the pinned NodeID itself -> accept');
  assert(decidePin({ pinnedNodeId: ID_A, presentedNodeId: ID_A.toUpperCase(), rotationVerified: false }) === 'accept',
    'case-insensitive NodeID match -> accept');
  assert(decidePin({ pinnedNodeId: null, presentedNodeId: ID_B, rotationVerified: false }) === 'accept',
    'TOFU: no prior pin -> accept (pin on first authenticated presentation)');

  // ---- T4: the mismatch is logged unconditionally (family 5) ----
  console.log('\n=== T4: contact-key-mismatch is logged ===');
  logger.configure({ toConsole: true });
  const lines = [];
  const origWarn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  const dMismatch = pinOnPresented({ pinnedNodeId: ID_A, presentedNodeId: ID_B, rotationVerified: false });
  const dAccept = pinOnPresented({ pinnedNodeId: ID_A, presentedNodeId: ID_A, rotationVerified: false });
  console.warn = origWarn;
  assert(dMismatch === 'mismatch', 'pinOnPresented returns mismatch for a differing key');
  assert(dAccept === 'accept', 'pinOnPresented returns accept for the pinned key');
  const mismatchLines = lines.filter((l) => /"event":"contact-key-mismatch"/.test(l));
  assert(mismatchLines.length >= 1, 'a contact-key-mismatch line is emitted on mismatch');
  assert(mismatchLines.every((l) => !new RegExp(ID_A).test(l) && !new RegExp(ID_B).test(l)),
    'the log carries only NodeID prefixes, never a full NodeID');
  assertAbsent({
    channel: 'contact-key-mismatch log lines',
    control: () => mismatchLines.length, // the channel demonstrably shows the event (from the mismatch call)
    absent: () => lines.filter((l) => /"event":"contact-key-mismatch"/.test(l)).length === 1,
    message: 'the accept call emits no contact-key-mismatch line',
  });

  // ---- T3: legitimate rotation updates the pin; forged does not ----
  console.log('\n=== T3: rotation is decided by the existing KeyRotationManager verify ===');
  // Legitimate: A rotates; V (which trusts A) verifies the signed cert.
  const V = createGMPNode({ port: 0, disableBootstrap: true, dataDir: tmp('v') });
  await V.loadIdentity('ghost pin verifier seed one');
  const A = createGMPNode({ port: 0, disableBootstrap: true, dataDir: tmp('a') });
  await A.loadIdentity('ghost pin pinned contact old seed');
  const oldANodeId = A.identity.nodeIdHex;
  V.peerCache.recordSuccess(oldANodeId, '127.0.0.1', 59990, A.identity.signingPubKeyHex);
  const successor = await deriveIdentityFromSeedPhrase('ghost pin pinned contact new seed');
  let rotated = null;
  V.on('key-rotated', (e) => { rotated = e; });
  const cert = A.rotateKey(successor);
  V.keyRotationManager.handleReceivedRotation({ cert, sequenceNumber: 1, ttl: 8 }, null);
  const legitVerified = !!(rotated && rotated.oldNodeId === oldANodeId && rotated.newNodeId === cert.newNodeId);
  assert(legitVerified, 'the existing KeyRotationManager verified the legitimately signed rotation');
  assert(decidePin({ pinnedNodeId: oldANodeId, presentedNodeId: cert.newNodeId, rotationVerified: legitVerified }) === 'update-pin',
    'legitimate rotation -> update-pin');

  // Forged: a cert for B's successor signed by an attacker key, not B's.
  const V2 = createGMPNode({ port: 0, disableBootstrap: true, dataDir: tmp('v2') });
  await V2.loadIdentity('ghost pin verifier seed two');
  const B = createGMPNode({ port: 0, disableBootstrap: true, dataDir: tmp('b') });
  await B.loadIdentity('ghost pin pinned contact B seed');
  V2.peerCache.recordSuccess(B.identity.nodeIdHex, '127.0.0.1', 59991, B.identity.signingPubKeyHex);
  const successor2 = await deriveIdentityFromSeedPhrase('ghost pin forged successor seed');
  const attacker = await deriveIdentityFromSeedPhrase('ghost pin attacker seed');
  const ts = Date.now();
  const forgedMsg = B.identity.nodeIdHex + successor2.signingPubKeyHex + successor2.nodeIdHex + ts;
  const forgedCert = {
    oldNodeId: B.identity.nodeIdHex,
    newPublicKey: successor2.signingPubKeyHex,
    newNodeId: successor2.nodeIdHex,
    rotationTimestamp: ts,
    signature: bytesToHex(signMessage(attacker.signingPrivKey, stringToBytes(forgedMsg))),
  };
  let rotated2 = null;
  V2.on('key-rotated', (e) => { rotated2 = e; });
  V2.keyRotationManager.handleReceivedRotation({ cert: forgedCert, sequenceNumber: 1, ttl: 8 }, null);
  const forgedVerified = !!rotated2;
  assertAbsent({
    channel: 'key-rotated event on V2',
    control: () => legitVerified, // the same event channel DID fire for the legitimate rotation on V
    absent: () => forgedVerified === false,
    message: 'a forged rotation does not verify (no key-rotated)',
  });
  assert(decidePin({ pinnedNodeId: B.identity.nodeIdHex, presentedNodeId: successor2.nodeIdHex, rotationVerified: forgedVerified }) === 'mismatch',
    'forged/unsigned rotation -> mismatch');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
