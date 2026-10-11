/**
 * Sealed store-and-forward
 *
 *  1. addressing: bucket = top bits of the tag; directional channels; per-
 *     channel epoch offsets; sealing to exactly one at-rest bucket
 *  2. end to end: SENT (stored) on STORE_ACK; DELIVERED only from the
 *     recipient's sealed receipt blob; message delivered once
 *  3. DELIVERED cannot come from anything else: eviction, expiry, a blob
 *     the host or a stranger makes up
 *  4. the host never sees a tag, a NodeID, a static key or a sender
 *  5. fetch shape: exactly N buckets, decoys, shuffle, round-robin; the host
 *     refuses any other shape
 *  6. limits: TTL hard delete (file gone), per-bucket LRU eviction by count
 *     and bytes, per-/24 deposit rate limit, bucketCount change refused
 *  7. throwaway identities only; a real identity is refused even when passed
 *     in; the storage host keeps no peer or nonce state for hops
 *  8. storage role separation: hard refusals by host, NodeID and operator;
 *     separation status
 *  9. no timers in the delivery path (static check)
 * 10. trial-decrypt cost, measured
 *
 * Run: node test/store-forward-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase, generateEphemeralIdentity } from '../dist/identity.js';
import {
  Channel, bucketOf, bucketBits, pairSecret, sealBlob, openBlob, STORAGE_BUCKETS, MAX_SF_PAYLOAD, RELEASE_BUCKET_COUNT,
} from '../dist/storage/sf-crypto.js';
import { StoreForward, parseStoragePeer } from '../dist/storage/store-forward.js';
import { StorageSession } from '../dist/storage/storage-client.js';
import { withSource } from './helpers/ephemeral-source.mjs';
import { RoleSeparationError } from '../dist/relay/role-separation.js';
import { MESSAGETYPES } from '../dist/link/frame.js';
import { SfPollScheduler } from '../dist/storage/sf-scheduler.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

let testsPassed = 0;
let testsFailed = 0;
function assert(condition, message) {
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); } else { testsFailed++; console.error(`  ✗ ${message}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-sf-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
const rejection = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_SF_DEPOSIT_BURST: 100000, GMP_SF_DEPOSIT_RATE_PER_MINUTE: 100000, ...cfg },
    dataDir: path.join(tmp, `n${n++}`),
    port: 0,
    transport: new MemoryTransport(network),
  });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}

/**
 * The bucket schedule for the section running: undefined = the release
 * schedule (1 bucket at launch); SCHED64 for the sections that exercise
 * multi-bucket behaviour (fetch shape, decoys, per-bucket limits).
 */
const SCHED64 = [{ bucketCount: 64, from: 0 }];
let SCHEDULE;

async function storageHost(network, seed = `sf storage host ${n}`, cfg = {}) {
  const S = await makeNode(network, seed, { GMP_STORAGE_ENABLED: true, ...cfg });
  await S.listen();
  if (SCHEDULE) S.storageServer.bucketSchedule = SCHEDULE;
  return S;
}

/** A client node with a StoreForward whose mailbox is `mailbox`. */
function sfFor(node, mailbox, opts = {}) {
  return new StoreForward({ host: node, fetchBuckets: opts.fetchBuckets ?? 4, ownMailbox: () => mailbox, clock: opts.clock, stateFile: opts.stateFile, bucketSchedule: opts.bucketSchedule ?? SCHEDULE });
}

function introduce(a, sfA, b, sfB) {
  sfA.learnContact(b.identity.nodeIdHex, b.identity.staticPubKey);
  sfB.learnContact(a.identity.nodeIdHex, a.identity.staticPubKey);
}

async function testAddressing() {
  console.log('\n=== 1. addressing and sealing ===');
  const a = await deriveIdentityFromSeedPhrase('sf addressing a');
  const b = await deriveIdentityFromSeedPhrase('sf addressing b');
  const sAB = pairSecret(a.staticPrivKey, a.nodeId, b.staticPubKey, b.nodeId);
  const sBA = pairSecret(b.staticPrivKey, b.nodeId, a.staticPubKey, a.nodeId);
  assert(sAB.equals(sBA), 'both ends derive the same pair secret');
  const toB = new Channel(sAB, b.nodeId);
  const toA = new Channel(sAB, a.nodeId);
  const e = toB.epoch(1_790_000_000);
  const tag = toB.tag(e);
  assert(bucketOf(tag, 4096) === (tag.readUInt16BE(0) >> 4), `bucket = top 12 bits of the tag (${bucketOf(tag, 4096)})`);
  assert(bucketOf(tag, 256) === tag[0] && bucketBits(4096) === 12 && bucketOf(tag, 64) === (tag[0] >> 2), 'the derivation works for any power of two (release: 64 -> top 6 bits)');
  let threw = false;
  try { bucketBits(1000); } catch { threw = true; }
  assert(threw, 'a bucketCount that is not a power of two is refused');
  assert(!toA.tag(toA.epoch(1_790_000_000)).equals(tag) && toA.offset !== toB.offset,
    'A->B and B->A are different channels: different tags, different roll times');
  const roll = (ch, s) => ch.epoch(s + 1) !== ch.epoch(s);
  let rolls = 0;
  for (let s = 1_790_000_000; s < 1_790_000_000 + 86400; s++) if (roll(toB, s)) rolls++;
  assert(rolls === 1, 'a channel rolls exactly once a day, at its own offset');

  // 12 contacts' offsets: spread, not one shared midnight.
  const me = await deriveIdentityFromSeedPhrase('sf addressing me');
  const offsets = [];
  for (let i = 0; i < 12; i++) {
    const c = await deriveIdentityFromSeedPhrase(`sf addressing contact ${i}`);
    offsets.push(new Channel(pairSecret(me.staticPrivKey, me.nodeId, c.staticPubKey, c.nodeId), me.nodeId).offset);
  }
  assert(new Set(offsets).size === 12, `12 contacts roll at 12 different moments (offsets ${offsets.map((o) => (o / 3600).toFixed(1) + 'h').join(' ')})`);

  const sizes = [0, 100, 3900, 4000, 60000, 1_000_000, MAX_SF_PAYLOAD].map((len) =>
    sealBlob(b.staticPubKey, { tag, receiptSecret: crypto.randomBytes(32), senderNodeId: Buffer.from(a.nodeId), payload: Buffer.alloc(len, 7) }).length);
  assert(sizes.every((s) => STORAGE_BUCKETS.includes(s)) && JSON.stringify([...new Set(sizes)]) === '[4096,65536,1048576]',
    `every sealed blob is exactly 4 KiB, 64 KiB or 1 MiB (${sizes.join(', ')})`);
  const receipt = crypto.randomBytes(32);
  const blob = sealBlob(b.staticPubKey, { tag, receiptSecret: receipt, senderNodeId: Buffer.from(a.nodeId), payload: Buffer.from('hello') });
  const opened = openBlob(b.staticPrivKey, b.staticPubKey, blob);
  assert(opened && opened.payload.toString() === 'hello' && opened.tag.equals(tag) && opened.receiptSecret.equals(receipt) && opened.senderNodeId.equals(Buffer.from(a.nodeId)),
    'the recipient opens it: payload, tag, receipt secret and sender NodeID, all inside the ciphertext');
  assert(openBlob(a.staticPrivKey, a.staticPubKey, blob) === null, 'nobody else opens it (not even the sender)');
  const tampered = Buffer.from(blob); tampered[100] ^= 1;
  assert(openBlob(b.staticPrivKey, b.staticPubKey, tampered) === null, 'a changed byte fails authentication');
}

/** Poll until done() or one full rotation of the fetch set (a poll covers 4 buckets). */
async function pollUntil(sf, done, reason = 'poll') {
  const limit = Math.ceil(sf.fetchSet().length / sf.fetchBuckets) + 1;
  for (let i = 0; i < limit && !done(); i++) await sf.poll(reason);
  return done();
}

/** The bucket A deposits into for B right now. */
function bucketToward(a, b, count = RELEASE_BUCKET_COUNT) {
  const ch = new Channel(pairSecret(a.identity.staticPrivKey, a.identity.nodeId, b.identity.staticPubKey, b.identity.nodeId), b.identity.nodeId);
  return ch.bucket(count);
}

async function testEndToEnd() {
  console.log('\n=== 2. end to end: SENT on STORE_ACK, DELIVERED on the recipient\'s receipt ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network);
  const mailbox = { address: 'storage.example', port: S.port, nodeId: S.identity.nodeIdHex, operator: 'op-storage' };
  const A = await makeNode(network, 'sf e2e sender');
  const B = await makeNode(network, 'sf e2e recipient');
  const sfA = sfFor(A, mailbox);
  const sfB = sfFor(B, mailbox);
  introduce(A, sfA, B, sfB);

  const events = [];
  sfA.on('stored', (e) => events.push(`stored:${e.localId}`));
  sfA.on('delivered', (e) => events.push(`delivered:${e.localId}`));
  const got = [];
  sfB.on('message', (m) => got.push(m));

  await sfA.send(B.identity.nodeIdHex, JSON.stringify({ type: 'queued-message', text: 'while you were away' }), 'msg-1');
  assert(events.join() === 'stored:msg-1', 'SENT (stored) the moment the host acknowledged the deposit');
  await pollUntil(sfA, () => false);
  assert(!events.includes('delivered:msg-1'), 'the sender polling a full rotation first sees no DELIVERED: no receipt exists');

  await pollUntil(sfB, () => got.length > 0, 'foreground');
  assert(got.length === 1 && got[0].fromNodeId === A.identity.nodeIdHex && JSON.parse(got[0].payload).text === 'while you were away',
    'the recipient\'s polls deliver it, attributed to the sender from inside the seal');
  assert(S.storageServer.getStats().blobs === 1, 'the host still holds it: reading tells the host nothing (GM-N2b-1)');

  await sfB.poll('next');
  assert(S.storageServer.getStats().blobs === 2, 'at its next poll the recipient deposits a sealed receipt');
  await pollUntil(sfA, () => events.includes('delivered:msg-1'));
  assert(events.join() === 'stored:msg-1,delivered:msg-1', 'the sender finds the receipt in its own mailbox: DELIVERED');
  assert(sfA.outbox.length === 0, 'and drops it from the outbox');
  await pollUntil(sfB, () => false);
  assert(got.length === 1, 'delivered exactly once (cursors and the seen-set)');
  return { network, S, A, B, sfA, sfB, mailbox };
}

async function testDeliveredOnlyFromReceipt() {
  console.log('\n=== 3. DELIVERED only from the recipient ===');
  const network = new MemoryNetwork();
  let now = Date.now();
  const clock = () => now;
  const S = await storageHost(network, 'sf receipts host', { GMP_SF_BUCKET_MAX_BLOBS: 3 });
  S.storageServer.store.clock = clock;
  const mailbox = { address: 'storage.example', port: S.port };
  const A = await makeNode(network, 'sf receipts sender');
  const B = await makeNode(network, 'sf receipts recipient');
  const sfA = sfFor(A, mailbox, { clock });
  const sfB = sfFor(B, mailbox, { clock });
  introduce(A, sfA, B, sfB);
  const delivered = [];
  const expired = [];
  sfA.on('delivered', (e) => delivered.push(e.localId));
  sfA.on('expired', (e) => expired.push(e.localId));

  // Eviction: fill B's bucket past its cap before B ever polls.
  await sfA.send(B.identity.nodeIdHex, 'evict me', 'evicted');
  const bucket = bucketToward(A, B, 64);
  const [first] = S.storageServer.store.list(bucket);
  const filler = await StorageSession.open(new MemoryTransport(network), mailbox, withSource());
  for (let i = 0; i < 3; i++) await filler.store(bucket, crypto.randomBytes(4096));
  assert(!fs.existsSync(S.storageServer.store.fileFor(first.blobId)), 'LRU eviction hard-deleted the oldest blob in the full bucket');
  await pollUntil(sfB, () => false);
  await sfB.poll('receipts');
  await pollUntil(sfA, () => false);
  assert(!delivered.includes('evicted'), 'an evicted message is never read, so never DELIVERED');

  // Blobs the host (or a stranger) makes up: sealed to A, but no contact's tag.
  const stranger = await deriveIdentityFromSeedPhrase('sf receipts stranger');
  const aBucket = bucketToward(B, A, 64);
  for (let kind = 0; kind < 2; kind++) {
    const fake = sealBlob(A.identity.staticPubKey, { tag: crypto.randomBytes(32), receiptSecret: crypto.randomBytes(32), senderNodeId: Buffer.from(B.identity.nodeId), payload: Buffer.concat([Buffer.from([1]), Buffer.from(sfA.outbox[0]?.receipt || '00'.repeat(32), 'hex')]) });
    await filler.store(aBucket, fake);
  }
  const fromStranger = sealBlob(A.identity.staticPubKey, { tag: crypto.randomBytes(32), receiptSecret: crypto.randomBytes(32), senderNodeId: Buffer.from(stranger.nodeId), payload: Buffer.from([1]) });
  await filler.store(aBucket, fromStranger);
  await pollUntil(sfA, () => false);
  assert(delivered.length === 0, 'a receipt forged without the pair\'s tag — even carrying the right secret and the recipient\'s NodeID — is ignored');

  // No receipt within two TTLs: 'expired' (no receipt), never 'delivered'.
  now += 2 * DEFAULTS.GMP_SF_TTL_MS + 1000;
  await sfA.poll('after ttl');
  assert(S.storageServer.store.list(bucket).length === 0, 'past the TTL every blob in the bucket is gone (hard delete)');
  assert(expired.includes('evicted') && delivered.length === 0, `after two TTLs without a receipt: reported expired (no receipt), never delivered (${expired.join(',')})`);
  filler.close();
}

async function testHostSeesNoIdentity() {
  console.log('\n=== 4. what the storage host reads ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network);
  const seen = [];
  const handle = S.storageServer.handleFrame.bind(S.storageServer);
  S.storageServer.handleFrame = (link, type, pt) => { seen.push({ link, type, pt: Buffer.from(pt) }); return handle(link, type, pt); };
  const mailbox = { address: 'storage.example', port: S.port };
  const A = await makeNode(network, 'sf metadata sender');
  const B = await makeNode(network, 'sf metadata recipient');
  const sfA = sfFor(A, mailbox);
  const sfB = sfFor(B, mailbox);
  introduce(A, sfA, B, sfB);
  await sfA.send(B.identity.nodeIdHex, 'secret text');
  let read = 0;
  sfB.on('message', () => read++);
  await pollUntil(sfB, () => read > 0);
  await sfB.poll('receipt');
  await pollUntil(sfA, () => sfA.outbox.length === 0);

  const ch = new Channel(pairSecret(A.identity.staticPrivKey, A.identity.nodeId, B.identity.staticPubKey, B.identity.nodeId), B.identity.nodeId);
  const now = Math.floor(Date.now() / 1000);
  const tags = [0, -1].map((k) => ch.tag(ch.epoch(now) + k));
  const all = Buffer.concat(seen.map((s) => s.pt));
  const needles = [
    ...tags.map((t) => ['tag', t]),
    ...tags.map((t) => ['tag prefix (4 B)', t.subarray(0, 4)]),
    ['sender NodeID', Buffer.from(A.identity.nodeId)], ['recipient NodeID', Buffer.from(B.identity.nodeId)],
    ['sender static key', Buffer.from(A.identity.staticPubKey)], ['recipient static key', Buffer.from(B.identity.staticPubKey)],
    ['sender NodeID (hex)', Buffer.from(A.identity.nodeIdHex)], ['recipient NodeID (hex)', Buffer.from(B.identity.nodeIdHex)],
    ['plaintext', Buffer.from('secret text')],
  ];
  const found = needles.filter(([, b]) => all.includes(b)).map(([name]) => name);
  assertAbsent({
    channel: 'byte search over every host frame',
    control: () => seen.length >= 4 && all.includes(Buffer.from('"bucket"')) && all.includes(Buffer.from('requestId')) && seen.length,
    controlMessage: 'the same search finds the control fields present in every frame',
    absent: () => found.length === 0,
    message: `across ${seen.length} frames the host read no tag, tag prefix, NodeID, static key or plaintext (${found.join(', ') || 'none'})`,
  });
  const keys = new Set(seen.flatMap((s) => {
    const len = s.pt.readUInt32BE(0);
    return Object.keys(JSON.parse(s.pt.subarray(4, 4 + len).toString()));
  }));
  assert([...keys].sort().join() === 'bucket,buckets,requestId',
    `control fields the host ever receives: ${[...keys].sort().join(', ')}`);
  const peers = new Set(seen.map((s) => hex(s.link.remoteNodeId)));
  assert(!peers.has(A.identity.nodeIdHex) && !peers.has(B.identity.nodeIdHex) && peers.size === seen.filter((s, i) => i === 0 || s.link !== seen[i - 1].link).length,
    `every operation came from its own throwaway hop identity (${peers.size} distinct), never A or B`);
}

async function testFetchShape() {
  console.log('\n=== 5. fetch shape ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network);
  const mailbox = { address: 'storage.example', port: S.port };
  const B = await makeNode(network, 'sf shape recipient');
  const sfB = sfFor(B, mailbox);
  const contacts = [];
  for (let i = 0; i < 5; i++) {
    const c = await deriveIdentityFromSeedPhrase(`sf shape contact ${i}`);
    contacts.push(c);
    sfB.learnContact(hex(c.nodeId), c.staticPubKey);
  }
  const set = sfB.fetchSet();
  const real = set.filter((x) => !x.decoy).map((x) => x.bucket);
  assert(set.length >= 5 && set.length <= 7 && set.some((x) => x.decoy), `5 contacts + 2 decoy channels, one fixed bucket each -> ${set.length} buckets out of 64 (${real.length} real)`);

  const requests = [];
  const handle = S.storageServer.handleFrame.bind(S.storageServer);
  S.storageServer.handleFrame = (link, type, pt) => {
    if (type === MESSAGETYPES.FETCH_REQUEST) requests.push(JSON.parse(pt.subarray(4, 4 + pt.readUInt32BE(0)).toString()).buckets);
    return handle(link, type, pt);
  };
  const rounds = Math.ceil(set.length / 4);
  for (let i = 0; i < rounds; i++) await sfB.poll('rr');
  assert(requests.every((b) => b.length === 4), `every FETCH_REQUEST carries exactly 4 entries (${requests.map((b) => b.length).join(',')})`);
  const covered = new Set(requests.flat().map((e) => e.bucket).filter((b) => real.includes(b)));
  assert(covered.size === new Set(real).size, `round-robin covered the whole real set in ${requests.length} polls (${covered.size}/${new Set(real).size})`);
  // order is shuffled: over many selections, a given id does not sit in a fixed position
  const positions = new Set();
  const small = [{ bucket: 7, bucketCount: 64, epochStartMs: 0, decoy: false }, { bucket: 8, bucketCount: 64, epochStartMs: 0, decoy: false }];
  for (let i = 0; i < 40; i++) positions.add(sfB.selectFetch(small, false).entries.findIndex((e) => e.bucket === 7));
  assert(positions.size >= 3, `order is randomised (an id seen at ${positions.size} different positions)`);

  const lone = await makeNode(network, 'sf shape nobody');
  const sfL = sfFor(lone, mailbox);
  const r = await sfL.poll('empty');
  assert(r.requests[0].entries.length === 4 && r.requests[0].real === 0, 'a user with no contacts still sends the same shape: 4 entries, all decoy channels');

  const sess = await StorageSession.open(new MemoryTransport(network), mailbox, withSource());
  const e = (b, since = 0) => ({ bucket: b, since });
  const three = await rejection(sess.fetch([e(1), e(2), e(3)]));
  const five = await rejection(sess.fetch([e(1), e(2), e(3), e(4), e(5)]));
  const dup = await rejection(sess.fetch([e(1), e(1), e(2), e(3)]));
  const range = await rejection(sess.fetch([e(1), e(2), e(3), e(64)]));
  const negative = await rejection(sess.fetch([e(1), e(2), e(3), e(4, -1)]));
  assert([three, five, dup, range, negative].every((x) => x && x.reason === 'bad-fetch-size'), 'the host refuses 3, 5, duplicate, out-of-range (64+) or negative-cursor entries: one shape for everyone');
  sess.close();
}

async function testLimits() {
  console.log('\n=== 6. limits ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network, 'sf limits host', { GMP_SF_BUCKET_MAX_BLOBS: 256, GMP_SF_BUCKET_MAX_BYTES: 16 * 1024 * 1024 });
  const mailbox = { address: 'storage.example', port: S.port };
  const sess = await StorageSession.open(new MemoryTransport(network), mailbox, withSource());
  const ids = [];
  for (let i = 0; i < 256; i++) await sess.store(9, crypto.randomBytes(4096));
  const oldest = S.storageServer.store.list(9)[0].blobId;
  await sess.store(9, crypto.randomBytes(4096));
  for (const m of S.storageServer.store.list(9)) ids.push(m.blobId);
  assert(S.storageServer.store.list(9).length === 256 && !fs.existsSync(S.storageServer.store.fileFor(oldest)), 'the 257th blob evicts the least recently used (count cap 256), file removed');
  for (let i = 0; i < 17; i++) await sess.store(20, crypto.randomBytes(1048576));
  const big = S.storageServer.store.list(20);
  assert(big.length === 16 && big.reduce((a, m) => a + m.size, 0) <= 16 * 1024 * 1024, `byte cap: 17 x 1 MiB into one bucket keeps ${big.length}, evicting the rest (<= 16 MiB)`);
  const badSize = await rejection(sess.store(1, crypto.randomBytes(5000)));
  assert(badSize && badSize.reason === 'bad-size', 'a blob that is not exactly one storage bucket is refused');
  sess.close();

  const S2 = await storageHost(network, 'sf rate host', { GMP_SF_DEPOSIT_BURST: 5, GMP_SF_DEPOSIT_RATE_PER_MINUTE: 1 });
  const s2 = await StorageSession.open(new MemoryTransport(network), { address: 'x', port: S2.port }, withSource());
  const results = [];
  for (let i = 0; i < 7; i++) results.push((await rejection(s2.store(1, crypto.randomBytes(4096))))?.reason ?? 'ok');
  assert(results.join() === 'ok,ok,ok,ok,ok,rate-limited,rate-limited', `deposits per /24 follow the N1b-4 token bucket (${results.join(',')})`);
  s2.close();

  // restart: blobs survive, sealed at rest
  const S3dir = S.dataDir;
  const before = S.storageServer.getStats().blobs;
  const raw = fs.readFileSync(S.storageServer.store.fileFor(ids[5]));
  assert(!raw.includes(Buffer.from('"bucket"')), 'blob files are sealed at rest (no readable metadata)');
  S.close();
  const S3 = createGMPNode({ config: { ...DEFAULTS, GMP_STORAGE_ENABLED: true }, dataDir: S3dir, port: 0, transport: new MemoryTransport(network) });
  nodes.push(S3);
  await S3.loadIdentity('sf limits host');
  assert(S3.storageServer.getStats().blobs === before, `a restarted host reloads its blobs (${before})`);
}

/** At launch there is one bucket; shape and decoys are inert. */
async function testLaunchOneBucket() {
  console.log('\n=== 6b. launch: one bucket, fetch everything ===');
  assert(RELEASE_BUCKET_COUNT === 1, `release bucket count is 1 (${RELEASE_BUCKET_COUNT})`);
  const network = new MemoryNetwork();
  const S = await storageHost(network, 'sf one bucket host');
  const mailbox = { address: 'storage.example', port: S.port };
  const users = [];
  for (let i = 0; i < 3; i++) users.push(await makeNode(network, `sf one bucket user ${i}`));
  const sfs = users.map((u) => sfFor(u, mailbox));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) sfs[i].learnContact(users[j].identity.nodeIdHex, users[j].identity.staticPubKey);
  const requests = [];
  const handle = S.storageServer.handleFrame.bind(S.storageServer);
  S.storageServer.handleFrame = (link, type, pt) => {
    if (type === MESSAGETYPES.FETCH_REQUEST) requests.push(JSON.parse(pt.subarray(4, 4 + pt.readUInt32BE(0)).toString()).buckets);
    if (type === MESSAGETYPES.STORE_REQUEST) requests.push(['store', JSON.parse(pt.subarray(4, 4 + pt.readUInt32BE(0)).toString()).bucket]);
    return handle(link, type, pt);
  };
  assert(sfs.every((sf) => JSON.stringify(sf.fetchSet().map((x) => x.bucket)) === '[0]' && sf.requestSize === 1), 'every user\'s fetch set is {0}, one entry per request: decoys and padding inert');
  const got = [];
  sfs[2].on('message', (m) => got.push(m.payload));
  await sfs[0].send(users[2].identity.nodeIdHex, 'to the only bucket');
  await sfs[1].send(users[2].identity.nodeIdHex, 'also to it');
  for (const sf of sfs) await sf.poll('one');
  const fetches = requests.filter((r) => !(r[0] === 'store'));
  assert(fetches.every((b) => b.length === 1 && b[0].bucket === 0), `every FETCH_REQUEST is exactly [{ bucket: 0, since }] (${fetches.length} requests)`);
  assert(requests.filter((r) => r[0] === 'store').every((r) => r[1] === 0), 'every deposit goes to bucket 0');
  assert(got.sort().join('|') === 'also to it|to the only bucket', 'the recipient finds both messages in the one bucket');
  const sess = await StorageSession.open(new MemoryTransport(network), mailbox, withSource());
  const four = await rejection(sess.fetch([{ bucket: 0, since: 0 }, { bucket: 1, since: 0 }, { bucket: 2, since: 0 }, { bucket: 3, since: 0 }]));
  assert(four && four.reason === 'bad-fetch-size', 'at one bucket the host refuses a 4-entry request (and any bucket but 0)');
  sess.close();
}

async function testThrowawayOnly() {
  console.log('\n=== 7. throwaway identities only ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network);
  const conns = [];
  S.on('connection', (e) => conns.push(e));
  const claims = S.nonceStore.claimCount;
  const mailbox = { address: 'storage.example', port: S.port };
  const A = await makeNode(network, 'sf throwaway sender');
  const B = await makeNode(network, 'sf throwaway recipient');
  const sfA = sfFor(A, mailbox);
  const sfB = sfFor(B, mailbox);
  introduce(A, sfA, B, sfB);
  await sfA.send(B.identity.nodeIdHex, 'x');
  await sfB.poll('x');
  await delay(30);
  const sawPeer = { conns: conns.length, claims: S.nonceStore.claimCount - claims, cached: S.peerCache.cache.length };
  // Control: a real peer that talks to the host is seen by the same listener and counters.
  const P = await makeNode(network, 'sf storage control peer');
  await P.dial('memory', S.port);
  await P.getLinkByNodeId(S.identity.nodeId).send('control');
  await delay(50);
  assertAbsent({
    channel: 'storage host connection event + claim count',
    control: () => conns.length === 1 && S.nonceStore.claimCount === claims + 1 && conns,
    controlMessage: 'a real peer is seen (one connection event, one claim)',
    absent: () => sawPeer.conns === 0 && sawPeer.claims === 0 && sawPeer.cached === 0,
    message: 'the storage host saw no peer: no connection event, no claim, no peer-cache entry',
  });
  const real = await rejection(StorageSession.open(new MemoryTransport(network), mailbox, withSource({ identity: A.identity })));
  assert(real && real.reason === 'real-identity', `passing the real identity in is refused before connecting (${real && real.message})`);
  const fake = await rejection(StorageSession.open(new MemoryTransport(network), mailbox, withSource({ identity: { ...A.identity, ephemeral: 1 } })));
  assert(fake && fake.reason === 'real-identity', 'only ephemeral === true counts');
  const eph = await StorageSession.open(new MemoryTransport(network), mailbox, withSource({ identity: generateEphemeralIdentity() }));
  assert(eph.link.role === 'hop', 'a generated throwaway identity is accepted');
  eph.close();
}

async function testRoleSeparation() {
  console.log('\n=== 8. storage role separation ===');
  const network = new MemoryNetwork();
  const S = await storageHost(network);
  const R = await makeNode(network, 'sf roles relay', { GMP_RELAY_ENABLED: true });
  await R.listen();
  const Boot = await makeNode(network, 'sf roles bootstrap');
  await Boot.listen();

  // hard rule 3a: a host that saw the real identity
  const N1 = await makeNode(network, 'sf roles one');
  await N1.dial('memory', S.port);
  const sf1 = sfFor(N1, { address: 'memory', port: S.port });
  sf1.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  const hostsBefore = S.links.size;
  const e1 = await rejection(sf1.send(Boot.identity.nodeIdHex, 'x'));
  assert(e1 instanceof RoleSeparationError && e1.code === 'STORAGE_ON_BOOTSTRAP_HOST' && S.links.size === hostsBefore,
    `storage on a host that saw the identity: refused before connecting (${e1 && e1.code})`);
  const sf1b = sfFor(N1, { address: 'alias', port: S.port, nodeId: S.identity.nodeIdHex });
  sf1b.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  const e1b = await rejection(sf1b.send(Boot.identity.nodeIdHex, 'x'));
  assert(e1b instanceof RoleSeparationError && e1b.code === 'STORAGE_ON_BOOTSTRAP_HOST', 'by NodeID under another name, too');

  // operator level
  const N2 = await makeNode(network, 'sf roles two');
  await N2.dial('memory', Boot.port, { infrastructure: { operator: 'op-x' } });
  const sf2 = sfFor(N2, { address: 'other', port: S.port, operator: 'op-x' });
  sf2.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  const e2 = await rejection(sf2.send(Boot.identity.nodeIdHex, 'x'));
  assert(e2 instanceof RoleSeparationError && e2.code === 'STORAGE_ON_BOOTSTRAP_HOST', `a different host of the bootstrap host's operator: refused (${e2 && e2.code})`);
  const e2b = await rejection(N2.reserveRelay({ address: 'memory', port: R.port, operator: 'op-x' }));
  assert(e2b instanceof RoleSeparationError && e2b.code === 'RESERVE_ON_BOOTSTRAP_HOST', 'and a relay of that operator too (N1b-1 now refuses at operator level)');

  // hard rule 3b: a reservation host
  const N3 = await makeNode(network, 'sf roles three');
  await N3.reserveRelay({ address: 'memory', port: R.port, operator: 'op-r' });
  const sf3 = sfFor(N3, { address: 'memory', port: R.port });
  sf3.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  const e3 = await rejection(sf3.send(Boot.identity.nodeIdHex, 'x'));
  assert(e3 instanceof RoleSeparationError && e3.code === 'STORAGE_ON_RELAY_HOST', `storage on the reservation host: refused (${e3 && e3.code})`);
  const sf3b = sfFor(N3, { address: 'y', port: S.port, operator: 'op-r' });
  sf3b.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  const e3b = await rejection(sf3b.send(Boot.identity.nodeIdHex, 'x'));
  assert(e3b instanceof RoleSeparationError && e3b.code === 'STORAGE_ON_RELAY_HOST', 'or on another host of the relay\'s operator');

  // hard rule 4: once a storage host is in use
  const N4 = await makeNode(network, 'sf roles four');
  const sf4 = sfFor(N4, { address: 'memory', port: S.port, operator: 'op-s' });
  sf4.learnContact(Boot.identity.nodeIdHex, Boot.identity.staticPubKey);
  await sf4.send(Boot.identity.nodeIdHex, 'x');
  const before = S.links.size;
  const e4 = await rejection(N4.dial('memory', S.port));
  assert(e4 instanceof RoleSeparationError && e4.code === 'BOOTSTRAP_VIA_STORAGE_HOST' && S.links.size === before, `the real identity is never shown to the storage host in use (${e4 && e4.code})`);
  const e4b = await rejection(N4.dial('alias', S.port, { nodeId: S.identity.nodeIdHex }));
  assert(e4b instanceof RoleSeparationError && e4b.code === 'BOOTSTRAP_VIA_STORAGE_HOST', 'nor under another name (by NodeID)');
  const e4c = await rejection(N4.reserveRelay({ address: 'memory', port: S.port }));
  assert(e4c instanceof RoleSeparationError && e4c.code === 'RESERVE_ON_STORAGE_HOST', 'and it is never used as a relay');
  const e4d = await rejection(N4.dial('memory', Boot.port, { infrastructure: { operator: 'op-s' } }));
  assert(e4d instanceof RoleSeparationError && e4d.code === 'BOOTSTRAP_VIA_STORAGE_HOST', 'nor any host of the storage operator for bootstrap');

  // separation status
  const N5 = await makeNode(network, 'sf roles five');
  await N5.dial('memory', Boot.port, { infrastructure: { operator: 'op-boot' } });
  assert(N5.storageSeparation({ address: 's', port: 1, operator: 'op-other' }) === 'separated', 'known, different operator: separated');
  assert(N5.storageSeparation({ address: 's', port: 1 }) === 'unseparated', 'unknown operator: not separated (shown amber, not refused)');
  assert(N5.storageSeparation({ address: 's', port: 1, operator: 'self' }) === 'separated', 'self-hosted: separated');
  const N6 = await makeNode(network, 'sf roles six');
  await N6.dial('memory', Boot.port, { infrastructure: { operator: null } });
  assert(N6.storageSeparation({ address: 's', port: 1, operator: 'op-other' }) === 'unseparated', 'bootstrap host of unknown operator: cannot claim separation');
}

function testNoTimersInPath() {
  console.log('\n=== 9. no timers in the delivery path ===');
  const files = ['storage/storage-client.js', 'storage/store-forward.js', 'storage/sf-crypto.js', 'storage/storage-protocol.js'];
  const offenders = files.filter((f) => /setTimeout|setInterval|setImmediate/.test(fs.readFileSync(path.join(here, '..', 'dist', f), 'utf8')));
  assert(offenders.length === 0, `no setTimeout / setInterval / setImmediate in ${files.join(', ')} (${offenders.join(', ') || 'none'})`);
  const sched = fs.readFileSync(path.join(here, '..', 'dist', 'storage', 'sf-scheduler.js'), 'utf8');
  assert(/this\.poll\(/.test(sched) && !/stored|delivered|emit\(/.test(sched), 'the scheduler (the one timer) only calls poll(); it never emits a message state');
  const ui = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  const region = (from, to) => { const i = ui.indexOf(from); const j = ui.indexOf(to, i + from.length); return i >= 0 && j > i ? ui.slice(i, j) : null; };
  const uiParts = [
    region("msg.type === 'sf-stored' || msg.type === 'sf-delivered'", "} else if (msg.type === 'external-address')"),
    region("bridgeConn.on('sf-state'", "\n      });"),
    region('sendStored(peerId, localId, dataObj) {', 'sendOnChannel(peerId, channelName, dataObj) {'),
    region('const offline = !conn || !dcConnected;', 'conn.sendPresence(peerId'),
  ];
  assert(uiParts.every((r) => r !== null) && uiParts.every((r) => !/setTimeout|setInterval/.test(r)),
    'UI: the offline send path, the sf-state handler and the bridge-event branch contain no timer');
  assert(/'delivered'/.test(uiParts[0]) && /'sf-delivered': 'delivered'/.test(uiParts[0]), 'UI: "delivered" is set only from the bridge\'s sf-delivered event');
  assert(ui.includes("'Ghost Mesh · Storage not separated'") && /separation === 'unseparated'/.test(ui), 'UI: "Ghost Mesh · Storage not separated" is shown (amber) when separation is not established');
}

async function testTrialDecryptCost() {
  console.log('\n=== 10. trial-decrypt cost (measured) ===');
  const me = await deriveIdentityFromSeedPhrase('sf perf me');
  const contacts = [];
  for (let i = 0; i < 50; i++) contacts.push(await deriveIdentityFromSeedPhrase(`sf perf contact ${i}`));
  const other = await deriveIdentityFromSeedPhrase('sf perf stranger');
  const blobs = [];
  for (let i = 0; i < 256; i++) {
    // 1 in 16 for us, the rest for someone else sharing the bucket
    const toMe = i % 16 === 0;
    const from = contacts[i % 50];
    const ch = new Channel(pairSecret(from.staticPrivKey, from.nodeId, me.staticPubKey, me.nodeId), me.nodeId);
    blobs.push(sealBlob(toMe ? me.staticPubKey : other.staticPubKey, { tag: ch.tag(ch.epoch(Math.floor(Date.now() / 1000))), receiptSecret: crypto.randomBytes(32), senderNodeId: Buffer.from(from.nodeId), payload: Buffer.from('m') }));
  }
  const t0 = process.hrtime.bigint();
  const expected = new Map();
  const nowS = Math.floor(Date.now() / 1000);
  for (const c of contacts) {
    const ch = new Channel(pairSecret(me.staticPrivKey, me.nodeId, c.staticPubKey, c.nodeId), me.nodeId);
    for (const k of [0, -1]) expected.set(ch.tag(ch.epoch(nowS) + k).toString('hex'), hex(c.nodeId));
  }
  const t1 = process.hrtime.bigint();
  let mine = 0;
  for (const b of blobs) {
    const inner = openBlob(me.staticPrivKey, me.staticPubKey, b);
    if (inner && expected.has(inner.tag.toString('hex'))) mine++;
  }
  const t2 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  console.log(`    MEASURED: 256 blobs (4 KiB) x 50 contacts x 2 epochs: ${ms(t0, t2).toFixed(1)} ms total`);
  console.log(`              = ${ms(t0, t1).toFixed(1)} ms deriving the 100 expected tags + ${ms(t1, t2).toFixed(1)} ms opening 256 blobs (${(ms(t1, t2) / 256).toFixed(3)} ms/blob)`);
  console.log('              Sealing to the recipient key makes the cost one X25519 + one GCM open per blob, independent of contact count;');
  console.log('              the 50 x 2 epochs cost is the tag table, a set lookup per blob.');
  assert(mine === 16, `found exactly its own 16 blobs among 256 (${mine})`);
  assert(ms(t0, t2) < 5000, 'within budget for a mobile poll (< 5 s here)');
}

async function testScheduler() {
  console.log('\n=== 11. poll schedule ===');
  const s1 = new SfPollScheduler(900000, async () => {});
  const delays = Array.from({ length: 2000 }, () => s1.nextDelay());
  const min = Math.min(...delays), max = Math.max(...delays);
  assert(min >= 450000 && max <= 1350000 && max - min > 800000, `interval jittered uniformly over 0.5x-1.5x of 15 min (${(min / 60000).toFixed(1)}-${(max / 60000).toFixed(1)} min)`);
  const s2 = new SfPollScheduler(900000, async () => {});
  const a = Array.from({ length: 5 }, () => s1.nextDelay()).join();
  const b = Array.from({ length: 5 }, () => s2.nextDelay()).join();
  assert(a !== b, 'two users do not share a schedule');
  const reasons = [];
  const s3 = new SfPollScheduler(3600000, async (r) => { reasons.push(r); });
  s3.start();
  await s3.trigger('foreground');
  await s3.trigger('network');
  s3.stop();
  assert(reasons.join() === 'foreground,network', `foreground and network change poll at once (${reasons.join(',')})`);
}

function testParse() {
  const p = parseStoragePeer('127.0.0.1:49600');
  const q = parseStoragePeer(`mail.example:443#${'ab'.repeat(64)}`);
  assert(p && p.address === '127.0.0.1' && p.port === 49600 && p.operator === 'self' && q.nodeId === 'ab'.repeat(64) && parseStoragePeer('nonsense') === null,
    'GMP_SF_STORAGE_PEER parses host:port[#nodeId] as a self-hosted mailbox');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N2 — Sealed Store-and-Forward Test                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    await testAddressing();
    testParse();
    await testEndToEnd();
    SCHEDULE = SCHED64;
    await testDeliveredOnlyFromReceipt();
    await testHostSeesNoIdentity();
    await testFetchShape();
    await testLimits();
    SCHEDULE = undefined;
    await testLaunchOneBucket();
    await testThrowawayOnly();
    await testRoleSeparation();
    testNoTimersInPath();
    await testTrialDecryptCost();
    await testScheduler();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
