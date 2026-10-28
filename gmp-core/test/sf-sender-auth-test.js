/**
 * Mailbox sender authentication (task R3b).
 *
 * A mailbox message's sender is the contact whose CHANNEL TAG the blob carries
 * (store-forward.ts _receive): the tag is HKDF of the pair's static-static
 * X25519 secret, so only the two ends of that pair can compute it. The sealed
 * sender NodeID must also equal that contact. Contacts' static keys come only
 * from authenticated GMP handshakes (gmp-node-manager.ts _onSfPeer ->
 * learnContact), where NodeID = SHA-512(static key) is checked.
 *
 * Real sf-crypto and StoreForward throughout; nothing cryptographic is mocked.
 * A malicious storage host controls exactly what a fetch returns, so forged
 * blobs are handed to StoreForward's own fetch-result handler (_receive) — the
 * same function a poll feeds. The genuine control also goes end to end through
 * a real storage host.
 *
 * Run: node test/sf-sender-auth-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { Channel, pairSecret, sealBlob } from '../dist/storage/sf-crypto.js';
import { StoreForward } from '../dist/storage/store-forward.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-sfauth-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_SF_DEPOSIT_BURST: 100000, GMP_SF_DEPOSIT_RATE_PER_MINUTE: 100000, ...cfg },
    dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new MemoryTransport(network),
  });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}
const sfFor = (node, mailbox) => new StoreForward({ host: node, fetchBuckets: 4, ownMailbox: () => mailbox });
const id = (node) => node.identity;
const KIND_MESSAGE = 0x00; // store-forward.ts:48
const nowEpochOf = (ch) => ch.epoch(Math.floor(Date.now() / 1000));
/** A sealed blob exactly as StoreForward builds it, from whatever secret the builder holds. */
function blob({ secret, recipient, claimedSender, text }) {
  const ch = new Channel(secret, recipient.nodeId);
  return sealBlob(recipient.staticPubKey, {
    tag: ch.tag(nowEpochOf(ch)), receiptSecret: crypto.randomBytes(32),
    senderNodeId: Buffer.from(claimedSender.nodeId),
    payload: Buffer.concat([Buffer.from([KIND_MESSAGE]), Buffer.from(text)]),
  });
}
/** Hand a fetch result to the receiver (what a host returns) and collect what it emits. */
function receive(sf, blobs) {
  const got = [];
  const on = (m) => got.push(m);
  sf.on('message', on);
  sf._receive({ blobs: blobs.map((b, i) => ({ blobId: `${Date.now()}-${Math.random()}-${i}`, blob: b })) });
  sf.off ? sf.off('message', on) : sf.removeListener('message', on);
  return got;
}

const network = new MemoryNetwork();
const S = await makeNode(network, 'sfauth storage host', { GMP_STORAGE_ENABLED: true });
await S.listen();
const mailbox = { address: 'storage.example', port: S.port, nodeId: S.identity.nodeIdHex, operator: 'op' };
const X = await makeNode(network, 'sfauth sender X');
const R = await makeNode(network, 'sfauth recipient R');
const R2 = await makeNode(network, 'sfauth recipient R2');
const Y = await makeNode(network, 'sfauth contact Y');
const H = await makeNode(network, 'sfauth host-side party');
const sfX = sfFor(X, mailbox), sfR = sfFor(R, mailbox), sfR2 = sfFor(R2, mailbox), sfY = sfFor(Y, mailbox);
// What authenticated handshakes would have taught each side.
sfX.learnContact(id(R).nodeIdHex, id(R).staticPubKey); sfR.learnContact(id(X).nodeIdHex, id(X).staticPubKey);
sfX.learnContact(id(R2).nodeIdHex, id(R2).staticPubKey); sfR2.learnContact(id(X).nodeIdHex, id(X).staticPubKey);
sfY.learnContact(id(R).nodeIdHex, id(R).staticPubKey); sfR.learnContact(id(Y).nodeIdHex, id(Y).staticPubKey);

console.log('\n=== control: a genuine X -> R message, end to end through a real storage host ===');
let controlCount = 0;
{
  const got = [];
  sfR.on('message', (m) => got.push(m));
  await sfX.send(id(R).nodeIdHex, 'genuine hello');
  for (let i = 0; i < 20 && !got.length; i++) await sfR.poll('test');
  const m = got[0];
  ok(!!m && m.payload === 'genuine hello', 'R receives it');
  ok(!!m && m.fromNodeId === id(X).nodeIdHex && /^[0-9a-f]{128}$/.test(m.fromNodeId), `tagged with X's full NodeID (${m && m.fromNodeId.slice(0, 16)}…)`);
  const direct = receive(sfR, [blob({ secret: pairSecret(id(X).staticPrivKey, id(X).nodeId, id(R).staticPubKey, id(R).nodeId), recipient: id(R), claimedSender: id(X), text: 'genuine via fetch result' })]);
  controlCount = direct.length;
  ok(direct.length === 1 && direct[0].fromNodeId === id(X).nodeIdHex, 'the same fetch-result path accepts a genuine X -> R blob (control for the forgeries below)');
}

console.log('\n=== host forgery: knows only public keys, claims sender X ===');
{
  // Its best guess at the X -> R channel: DH with its OWN key against R's
  // public key, under X's and R's NodeIDs. Plus a random tag.
  const guess = pairSecret(id(H).staticPrivKey, id(X).nodeId, id(R).staticPubKey, id(R).nodeId);
  const forged = [
    blob({ secret: guess, recipient: id(R), claimedSender: id(X), text: 'forged: DH(host, R) tag' }),
    sealBlob(id(R).staticPubKey, { tag: crypto.randomBytes(32), receiptSecret: crypto.randomBytes(32), senderNodeId: Buffer.from(id(X).nodeId),
      payload: Buffer.concat([Buffer.from([KIND_MESSAGE]), Buffer.from('forged: random tag')]) }),
  ];
  const got = receive(sfR, forged);
  assertAbsent({
    channel: 'R emitting a message for a host-forged blob claiming X',
    controlMessage: 'the same fetch-result path emits a genuine X -> R blob',
    control: () => controlCount,
    absent: () => got.length === 0,
    message: `R rejects both forgeries; nothing is emitted toward the renderer (${got.length})`,
  });
}

console.log('\n=== a real contact (Y) cannot speak as X ===');
{
  const yr = pairSecret(id(Y).staticPrivKey, id(Y).nodeId, id(R).staticPubKey, id(R).nodeId);
  const got = receive(sfR, [blob({ secret: yr, recipient: id(R), claimedSender: id(X), text: 'Y claiming to be X' })]);
  ok(got.length === 0, 'Y\'s genuine tag with sender NodeID X is rejected (the sealed sender must match the tag\'s contact)');
  const honest = receive(sfR, [blob({ secret: yr, recipient: id(R), claimedSender: id(Y), text: 'Y as Y' })]);
  ok(honest.length === 1 && honest[0].fromNodeId === id(Y).nodeIdHex, 'positive control: the same blob claiming Y is accepted, tagged Y');
}

console.log('\n=== wrong-pair replay: a genuine X -> R blob re-addressed to R2 ===');
{
  const genuine = blob({ secret: pairSecret(id(X).staticPrivKey, id(X).nodeId, id(R).staticPubKey, id(R).nodeId), recipient: id(R), claimedSender: id(X), text: 'for R only' });
  const atR2 = receive(sfR2, [genuine]);
  const atR = receive(sfR, [genuine]);
  assertAbsent({
    channel: 'R2 accepting a blob X sealed to R',
    controlMessage: 'R itself accepts that blob',
    control: () => atR.length,
    absent: () => atR2.length === 0,
    message: 'R2 (also a contact of X) rejects it',
  });
}

for (const node of nodes) { try { await node.stop(); } catch { /* best effort */ } }
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
