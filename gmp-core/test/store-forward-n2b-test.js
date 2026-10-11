/**
 * Store-and-forward without a delivery oracle:
 *
 *  1. no FETCH_DELETE: a full send / fetch / receipt round trip sends the host
 *     no 0x15 and no blob ID; a read blob stays (TTL/LRU only); a stray 0x15
 *     is ignored and never promotes a session
 *  2. DELIVERED comes from a sealed receipt that looks like any message to
 *     the host (same size bucket, same control fields)
 *  3. fetch cursors: nothing returned or decrypted twice; every entry is
 *     { bucket, since }; decoys encoded like real entries
 *  4. bucketCount 1 at launch, release-pinned; a change (1 -> 2) is fetched
 *     under both for exactly one TTL
 *  5. nothing in the UI presents bucketing as privacy
 *
 * Run: node test/store-forward-n2b-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { withSource } from './helpers/ephemeral-source.mjs';
import * as sfCrypto from '../dist/storage/sf-crypto.js';
import { StoreForward } from '../dist/storage/store-forward.js';
import { MESSAGETYPES } from '../dist/link/frame.js';

let testsPassed = 0;
let testsFailed = 0;
function assert(condition, message) {
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); } else { testsFailed++; console.error(`  ✗ ${message}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-n2b-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const nodes = [];
const DAY = 86400000;

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

/** Everything a storage host is handed, decoded. */
function tapHost(S) {
  const seen = [];
  const handle = S.storageServer.handleFrame.bind(S.storageServer);
  S.storageServer.handleFrame = (link, type, pt) => {
    let control = null;
    try { control = JSON.parse(pt.subarray(4, 4 + pt.readUInt32BE(0)).toString()); } catch { /* not ours */ }
    seen.push({ type, control, tailLength: pt.length - 4 - (pt.length >= 4 ? pt.readUInt32BE(0) : 0) });
    return handle(link, type, pt);
  };
  return seen;
}

/**
 * Poll until `done()` or one full rotation of the fetch set has passed: a poll
 * covers 4 buckets, so reaching a given bucket can take ceil(set / 4) polls.
 */
async function pollUntil(sf, done, reason = 'poll') {
  const limit = Math.ceil(sf.fetchSet().length / sf.fetchBuckets) + 1;
  for (let i = 0; i < limit && !done(); i++) await sf.poll(reason);
  return done();
}

function sfFor(node, mailbox, opts = {}) {
  return new StoreForward({ host: node, fetchBuckets: 4, ownMailbox: () => mailbox, ...opts });
}

async function setup(prefix, hostCfg = {}, opts = {}) {
  const network = new MemoryNetwork();
  const S = await makeNode(network, `${prefix} host`, { GMP_STORAGE_ENABLED: true, ...hostCfg });
  await S.listen();
  if (opts.bucketSchedule) S.storageServer.bucketSchedule = opts.bucketSchedule;
  const mailbox = { address: 'storage.example', port: S.port };
  const A = await makeNode(network, `${prefix} sender`);
  const B = await makeNode(network, `${prefix} recipient`);
  const sfA = sfFor(A, mailbox, opts);
  const sfB = sfFor(B, mailbox, opts);
  sfA.learnContact(B.identity.nodeIdHex, B.identity.staticPubKey);
  sfB.learnContact(A.identity.nodeIdHex, A.identity.staticPubKey);
  return { network, S, A, B, sfA, sfB, mailbox };
}

async function testNoDelete() {
  console.log('\n=== 1. N2b-1: no FETCH_DELETE ===');
  const { network, S, A, B, sfA, sfB } = await setup('n2b oracle');
  const seen = tapHost(S);
  const states = [];
  sfA.on('stored', (e) => states.push(`stored:${e.localId}`));
  sfA.on('delivered', (e) => states.push(`delivered:${e.localId}`));
  const got = [];
  sfB.on('message', (m) => got.push(m.payload));
  await sfA.send(B.identity.nodeIdHex, 'hello', 'm1');
  await pollUntil(sfB, () => got.length > 0);   // reads the message, queues its receipt
  await sfB.poll('interval');                   // deposits the receipt
  await pollUntil(sfA, () => states.includes('delivered:m1'));
  assert(got.join() === 'hello' && states.join() === 'stored:m1,delivered:m1', `round trip complete (${states.join(' ')})`);
  assert(!seen.some((f) => f.type === 0x15), `the host received no 0x15 in the whole round trip (${seen.map((f) => '0x' + f.type.toString(16)).join(' ')})`);
  const fromClients = seen.flatMap((f) => Object.keys(f.control || {}));
  assert(!fromClients.includes('blobId') && !fromClients.includes('receipt') && !fromClients.includes('commitment'),
    `no client ever names a blob to the host (fields sent: ${[...new Set(fromClients)].sort().join(', ')})`);
  const stats = S.storageServer.getStats();
  assert(stats.blobs === 2, `the message the recipient read is still stored, next to its receipt (${stats.blobs} blobs): removed only by TTL or LRU`);
  assert(MESSAGETYPES.FETCH_DELETE === undefined && MESSAGETYPES.RETIRED_0x15 === 0x15, '0x15 is retired in the frame table, not reused');

  // A stray 0x15 as a first frame: still an infrastructure frame (hop), ignored.
  const claims = S.nonceStore.claimCount;
  const hop = await RelayHop.open(new MemoryTransport(network), { address: 'x', port: S.port }, withSource());
  hop.link.sendRelay(0x15, Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]));
  await delay(30);
  const rl = [...S.links.values()].find((l) => l.remoteNodeId && Buffer.from(l.remoteNodeId).equals(Buffer.from(hop.link.identity.nodeId)));
  assert(rl && rl.role === 'hop' && S.nonceStore.claimCount === claims && S.storageServer.getStats().blobs === 2,
    'a retired 0x15 still counts as infrastructure: the session is a hop, nothing persisted, nothing deleted');
  hop.close();
}

async function testReceiptsAreBlobs() {
  console.log('\n=== 2. N2b-2: receipts are blobs ===');
  const { S, A, B, sfA, sfB } = await setup('n2b receipt');
  const seen = tapHost(S);
  await sfA.send(B.identity.nodeIdHex, 'x', 'm1');
  const msgStore = seen.filter((f) => f.type === MESSAGETYPES.STORE_REQUEST);
  let read = 0;
  sfB.on('message', () => read++);
  await pollUntil(sfB, () => read > 0);
  await sfB.poll('b');
  const allStores = seen.filter((f) => f.type === MESSAGETYPES.STORE_REQUEST);
  const receipt = allStores[allStores.length - 1];
  assert(allStores.length === 2 && msgStore.length === 1, 'the recipient deposited exactly one blob after reading: the receipt');
  assert(receipt.tailLength === msgStore[0].tailLength && JSON.stringify(Object.keys(receipt.control).sort()) === JSON.stringify(Object.keys(msgStore[0].control).sort()),
    `receipt and message are the same shape to the host: ${receipt.tailLength} B each, fields ${Object.keys(receipt.control).sort().join(', ')}`);
  // The receipt went to the sender-direction bucket, under the release derivation.
  const ch = new sfCrypto.Channel(sfCrypto.pairSecret(B.identity.staticPrivKey, B.identity.nodeId, A.identity.staticPubKey, A.identity.nodeId), A.identity.nodeId);
  const toA = ch.bucket(sfCrypto.RELEASE_BUCKET_COUNT);
  assert(receipt.control.bucket === toA, `into the sender-direction bucket (${receipt.control.bucket})`);
  const delivered = [];
  sfA.on('delivered', (e) => delivered.push(e.localId));
  await pollUntil(sfA, () => delivered.length > 0);
  assert(delivered.join() === 'm1', 'the sender reads it from its own mailbox: DELIVERED');
  await sfA.poll('d');
  assert(delivered.join() === 'm1', 'once');
}

async function testCursors() {
  console.log('\n=== 3. N2b-3 / N2c-4: fetch cursors ===');
  // Multi-bucket so decoys are live; the release (1 bucket) is covered in store-forward-test §6b.
  const SCHED64 = [{ bucketCount: 64, from: 0 }];
  const { S, B, A, sfA, sfB } = await setup('n2b cursor', {}, { bucketSchedule: SCHED64 });
  const seen = tapHost(S);
  const opens = new Map();
  const open = sfCrypto.openBlob;
  sfB._openBlob = (priv, pub, blob) => { const k = blob.subarray(0, 32).toString('hex'); opens.set(k, (opens.get(k) || 0) + 1); return open(priv, pub, blob); };
  await sfA.send(B.identity.nodeIdHex, 'one', 'm1');
  let blobs1 = 0;
  sfB.on('poll-complete', (r) => { blobs1 += r.requests.reduce((a, q) => a + q.blobs, 0); });
  await pollUntil(sfB, () => blobs1 > 0);
  sfB.removeAllListeners('poll-complete');
  for (let i = 0; i < 3; i++) await sfB.poll('again');
  assert(blobs1 >= 1 && [...opens.values()].every((c) => c === 1), `no blob is ever trial-decrypted twice (${opens.size} distinct blobs opened, max ${Math.max(...opens.values())} each)`);
  assert(DEFAULTS.GMP_SF_CURSOR_QUANTUM_MS === 300000, 'cursors are rounded to 5 min by default (GM-N2c-4): clients behind one address send the same values');

  // Exact cursors (quantum 0): nothing already seen comes back at all.
  const x = await setup('n2b exact', {}, { bucketSchedule: SCHED64, cursorQuantumMs: 0 });
  await x.sfA.send(x.B.identity.nodeIdHex, 'one', 'm1');
  let first = 0;
  x.sfB.on('poll-complete', (r) => { first += r.requests.reduce((a, q) => a + q.blobs, 0); });
  await pollUntil(x.sfB, () => first > 0);
  x.sfB.removeAllListeners('poll-complete');
  let refetchedExact = 0;
  for (let i = 0; i < Math.ceil(x.sfB.fetchSet().length / 4) + 1; i++) refetchedExact += (await x.sfB.poll('later')).refetched;
  assert(first >= 1 && refetchedExact === 0, `with exact cursors nothing already seen is ever sent again over a full rotation (${refetchedExact})`);
  // Rounded (default): the host may resend blobs from the current 5-min window; they are skipped, not decrypted.
  let refetchedRounded = 0;
  for (let i = 0; i < 3; i++) refetchedRounded += (await sfB.poll('rounded')).refetched;
  assert([...opens.values()].every((c) => c === 1), `with 5-min rounding ${refetchedRounded} blob(s) from the current window came back and were skipped by the seen-set, never re-decrypted`);

  const fetches = seen.filter((f) => f.type === MESSAGETYPES.FETCH_REQUEST).map((f) => f.control);
  assert(fetches.every((c) => Array.isArray(c.buckets) && c.buckets.length === 4 && c.buckets.every((e) => JSON.stringify(Object.keys(e)) === '["bucket","since"]')),
    'above one bucket every FETCH_REQUEST has exactly 4 entries, each exactly { bucket, since }');

  // Decoys: poll several times, then look at a request with the selection known.
  for (let i = 0; i < 4; i++) await sfB.poll('warm');
  const real = new Set(sfB.fetchSet().filter((x) => !x.decoy).map((x) => x.bucket));
  let entries = [];
  for (let i = 0; i < 12; i++) {
    entries = sfB.selectFetch(sfB.fetchSet(), true).entries;
    if (entries.some((e) => real.has(e.bucket)) && entries.some((e) => !real.has(e.bucket))) break;
  }
  const decoys = entries.filter((e) => !real.has(e.bucket));
  const reals = entries.filter((e) => real.has(e.bucket));
  const shape = (e) => JSON.stringify(Object.keys(e)) + typeof e.since + Number.isInteger(e.since);
  assert(decoys.length > 0 && reals.length > 0, `a request mixing real (${reals.length}) and decoy (${decoys.length}) entries`);
  assert(entries.every((e) => shape(e) === shape(entries[0])), 'decoy entries are encoded exactly like real ones (same keys, same types)');
  assert(decoys.every((e) => e.since > 0), `no decoy carries a zero cursor (${decoys.map((e) => e.since).join(', ')})`);
  const history = new Set(sfB.cursorValues());
  assert(entries.every((e) => history.has(e.since)), 'every cursor, real or decoy, is a value this host itself returned earlier (rounded)');
  assert(entries.every((e) => e.since % 300000000 === 0), `and every cursor is a 5-min boundary (${entries.map((e) => e.since).join(', ')})`);
}

async function testBucketCount() {
  console.log('\n=== 4. N2c-3: one bucket at launch, pinned; 1 -> 2 with a one-TTL overlap ===');
  assert(sfCrypto.RELEASE_BUCKET_COUNT === 1, `the release bucket count is 1 (${sfCrypto.RELEASE_BUCKET_COUNT})`);
  assert(!('GMP_SF_BUCKET_COUNT' in DEFAULTS), 'it is not a runtime config key');
  const t0 = Date.UTC(2027, 0, 1);
  const ttl = 7 * DAY;
  const schedule = [{ bucketCount: 1, from: 0 }, { bucketCount: 2, from: t0 }];
  const at = (t) => sfCrypto.activeBucketCounts(t, ttl, schedule).join('+');
  assert(at(t0 - 1) === '1', 'before the change: 1 only');
  assert(at(t0) === '2+1' && at(t0 + ttl - 1) === '2+1', 'from the change for one TTL: both, new first');
  assert(at(t0 + ttl) === '2', 'exactly one TTL later: the old derivation is dropped');

  // End to end across the change: a blob deposited in the single bucket the
  // minute before is still fetched, and one deposited under 2 is too.
  let now = t0 - 60000;
  const clock = () => now;
  const { S, B, sfA, sfB } = await setup('n2c overlap', {}, { clock, bucketSchedule: schedule });
  S.storageServer.store.clock = clock;
  S.storageServer.clock = clock;
  const got = [];
  sfB.on('message', (m) => got.push(m.payload));
  const before = sfB.requestSize;
  await sfA.send(B.identity.nodeIdHex, 'sent under 1', 'old');
  now = t0 + 60000;
  const during = sfB.requestSize;
  await sfA.send(B.identity.nodeIdHex, 'sent under 2', 'new');
  for (let i = 0; i < 12 && got.length < 2; i++) await sfB.poll('overlap');
  assert(got.sort().join() === 'sent under 1,sent under 2', `during the overlap both derivations are polled: got ${got.length}/2`);
  assert(before === 1 && during === 2, `request size follows the active bucket count (1 before, ${during} during)`);
  now = t0 + ttl + 60000;
  const set = sfB.fetchSet().filter((x) => !x.decoy);
  assert(set.every((x) => x.bucketCount === 2), 'after one TTL only the new derivation is polled');
}

function testUiClaims() {
  console.log('\n=== 5. N2b-4: the UI claims nothing about bucketing ===');
  const ui = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  const sfText = ['SF_STATE_LABELS', 'SF_STATE_TITLES', 'STORAGE_UNSEPARATED_EXPLANATION', 'STORAGE_UNSEPARATED_LABEL']
    .map((name) => { const i = ui.indexOf(`const ${name}`); return i < 0 ? '' : ui.slice(i, ui.indexOf(';', i)); }).join('\n');
  assert(sfText.length > 200 && !/anonym|bucket|untraceable|unlinkable|k-anon|hidden among|cannot tell who/i.test(sfText),
    'no store-and-forward label or tooltip mentions buckets or anonymity');
  assert(!/bucket/i.test(ui.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').match(/Mailbox:[^`]*/)?.[0] || ''), 'the mailbox status line says nothing about buckets');
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N2b — Delivery Oracle Removed Test                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  for (const t of [testNoDelete, testReceiptsAreBlobs, testCursors, testBucketCount, testUiClaims]) {
    try { await t(); } catch (err) { console.error(`\n${t.name} error:`, err.message); testsFailed++; }
  }
  for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
