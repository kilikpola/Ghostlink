/**
 * StoreForward.learnContact checks the key it is given against the NodeID,
 * exactly as the link does (handshake.ts nodeIdMatchesKeys): NodeID ==
 * SHA-512(static key), or NodeID == SHA-512(signing key) for a rotated
 * identity. Anything else is refused and logged, never stored silently.
 * (Task H1. The channel tag that authenticates a mailbox sender is derived
 * from this stored key, so a wrong key under a NodeID would let its holder
 * speak as that NodeID.)
 *
 * Run: node test/learn-contact-check-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sha512 } from '@noble/hashes/sha512';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import { StoreForward } from '../dist/storage/store-forward.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const hex = (b) => Buffer.from(b).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-lcc-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const node = createGMPNode({ config: { ...DEFAULTS }, dataDir: path.join(tmp, 'r'), port: 0, transport: new MemoryTransport(new MemoryNetwork()) });
node.on('error', () => {});
await node.loadIdentity('lcc recipient');
const sf = new StoreForward({ host: node, fetchBuckets: 4, ownMailbox: () => null });
const X = await deriveIdentityFromSeedPhrase('lcc contact x');
const Y = await deriveIdentityFromSeedPhrase('lcc contact y');
const stored = (id) => sf.state.contacts[id.toLowerCase()]?.staticPub ?? null;

/** Run fn while capturing everything written to stdout/stderr. */
function capture(fn) {
  const out = [];
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { out.push(String(c)); return true; };
  try { fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
  return out.join('');
}
const refusalLines = (text) => (text.match(/contact-key-mismatch/g) || []).length;

console.log('\n=== a correct pair is accepted (positive control) ===');
{
  const log = capture(() => sf.learnContact(X.nodeIdHex, X.staticPubKey, X.signingPubKey));
  ok(stored(X.nodeIdHex) === hex(X.staticPubKey), 'NodeID == SHA-512(static key): stored');
  ok(refusalLines(log) === 0, 'and nothing is logged as a refusal');
}

console.log('\n=== a static key that is not the NodeID\'s is refused and logged ===');
{
  const log = capture(() => sf.learnContact(Y.nodeIdHex, X.staticPubKey, X.signingPubKey));
  assertAbsent({
    channel: 'a contact entry for Y holding X\'s static key',
    controlMessage: 'the same store holds the correct pair learned above',
    control: () => (stored(X.nodeIdHex) === hex(X.staticPubKey) ? 1 : 0),
    absent: () => stored(Y.nodeIdHex) === null,
    message: 'Y\'s NodeID with X\'s keys: not stored',
  });
  ok(refusalLines(log) === 1, `the refusal is logged once (${refusalLines(log)})`);
  ok(!log.includes(hex(X.staticPubKey)), 'the log line does not carry the key');
}

console.log('\n=== an existing contact is not overwritten by a mismatched key ===');
{
  sf.learnContact(Y.nodeIdHex, Y.staticPubKey, Y.signingPubKey);
  ok(stored(Y.nodeIdHex) === hex(Y.staticPubKey), 'control: Y learned with its own key');
  capture(() => sf.learnContact(Y.nodeIdHex, X.staticPubKey, X.signingPubKey));
  ok(stored(Y.nodeIdHex) === hex(Y.staticPubKey), 'a later mismatched key leaves Y\'s stored key unchanged');
}

console.log('\n=== rotated identity: NodeID == SHA-512(signing key), as the link accepts ===');
{
  // A rotated identity's NodeID is the hash of its signing key; its static
  // key is not hashed into it.
  const rotatedId = hex(sha512(X.signingPubKey));
  const log = capture(() => sf.learnContact(rotatedId, Y.staticPubKey, X.signingPubKey));
  ok(stored(rotatedId) === hex(Y.staticPubKey) && refusalLines(log) === 0, 'accepted with the signing key that hashes to the NodeID');
  const other = hex(sha512(Y.signingPubKey));
  const log2 = capture(() => sf.learnContact(other, Y.staticPubKey, X.signingPubKey));
  ok(stored(other) === null && refusalLines(log2) === 1, 'refused when neither key hashes to the NodeID');
  const log3 = capture(() => sf.learnContact(other, Y.staticPubKey));
  ok(stored(other) === null && refusalLines(log3) === 1, 'refused when no signing key is given and the static key does not match');
}

try { await node.stop(); } catch { /* best effort */ }
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
