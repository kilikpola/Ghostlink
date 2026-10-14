import './helpers/isolate-data.mjs'; // must stay first
import { createGMPNode } from '../dist/node-factory.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { ghostAddressFromNodeId } from '../dist/ghost-address.js';
import logger from '../dist/logger.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha512 } from '@noble/hashes/sha512';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Fixture: two integers whose HKDF-derived seeds produce colliding 45-bit Ghost
// Addresses (both -> GHOST-A4F-0Y6-YA8) with distinct full NodeIDs. Found by a
// one-off birthday search (~4.1M probes, ~16 min); only the integers are kept,
// the identities are re-derived here exactly as production does.
const FIXTURE = [969102, 4102598];
const FIXTURE_INFO = 'gmp-collision-fixture-v1';

function seedForIndex(i) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(i));
  return hkdf(sha512, b, undefined, FIXTURE_INFO, 32);
}
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-col-${t}-`)); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }

async function makeLeaf(index, tag) {
  const n = createGMPNode({ derivedSeed: seedForIndex(index), port: 0, disableBootstrap: true, dataDir: tmp(tag) });
  n.loadIdentityFromDerivedSeed();
  await n.listen();
  return n;
}

async function run() {
  const A = await makeLeaf(FIXTURE[0], 'a');
  const address = ghostAddressFromNodeId(A.identity.nodeId);

  // Positive control FIRST, while A is the ONLY node with this address (before B
  // exists), through the SAME lookupGhostAddress path: it resolves to A's full
  // NodeID. (Run after B exists, the mesh correctly also surfaces B via A<->Q<->B,
  // which is the whole point — so the clean single-match control must precede B.)
  console.log('\n--- positive control: one node with that address resolves (same query path) ---');
  const Qc = new GMPNodeManager({ seedPhrase: 'ghost collision control seed phrase two', GMP_PORT: 0, disableBootstrap: true, dataDir: tmp('qc') });
  await Qc.start();
  await Qc.connectToPeer('127.0.0.1', A.port);
  await delay(400);
  const one = await Qc.lookupGhostAddress(address);
  assert(one.reason === 'ok' && !!one.nodeId && one.nodeId.toLowerCase() === A.identity.nodeIdHex.toLowerCase(),
    'one colliding node -> resolved to its full NodeID');
  await Qc.stop().catch(() => {});

  console.log('\n=== T1: a colliding Ghost Address resolves to ALL matches, never a silent pick ===');
  const B = await makeLeaf(FIXTURE[1], 'b');
  assert(address === ghostAddressFromNodeId(B.identity.nodeId), `fixture nodes share a Ghost Address (${address})`);
  assert(A.identity.nodeIdHex !== B.identity.nodeIdHex, 'fixture nodes have distinct full NodeIDs');

  logger.configure({ toConsole: true });
  const lines = [];
  const origWarn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));

  const Q = new GMPNodeManager({ seedPhrase: 'ghost collision querier seed phrase one', GMP_PORT: 0, disableBootstrap: true, dataDir: tmp('q') });
  await Q.start();
  await Q.connectToPeer('127.0.0.1', A.port);
  await Q.connectToPeer('127.0.0.1', B.port);
  await delay(400);
  const amb = await Q.lookupGhostAddress(address);
  console.warn = origWarn;

  assert(amb.reason === 'ambiguous', `resolving a colliding address is ambiguous, not a silent winner (got ${amb.reason})`);
  const cand = (amb.candidates || []).map((x) => x.toLowerCase());
  assert(cand.includes(A.identity.nodeIdHex.toLowerCase()) && cand.includes(B.identity.nodeIdHex.toLowerCase()),
    'the ambiguous result lists BOTH full colliding NodeIDs');
  const ambLog = lines.filter((l) => /"event":"ghost-address-ambiguous"/.test(l));
  assert(ambLog.length >= 1, 'an ambiguous resolution is logged unconditionally (family 5)');
  assert(ambLog.every((l) => !l.includes(A.identity.nodeIdHex) && !l.includes(B.identity.nodeIdHex)),
    'the ambiguous log carries only NodeID prefixes, never a full NodeID');

  await Q.stop().catch(() => {});
  try { A.close?.(); B.close?.(); } catch { /* best effort */ }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e && e.stack ? e.stack : e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
