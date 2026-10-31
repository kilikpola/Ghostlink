/**
 * Tests for src/p2p/file-transfer.js: per-transfer random keys sealed to the
 * recipient.
 *
 * Run with: node test/file-transfer.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const i = html.indexOf('  async encryptWithPublicKey(plaintext, pubKeyHex) {');
// encryptWithPublicKey and decryptWithPrivateKey are CryptoEngine's last methods.
const j = html.indexOf('\n};\nwindow.CryptoEngine = CryptoEngine;', i);
assert.ok(i > -1 && j > -1, 'could not extract the ECIES helpers from index.html');
const CryptoEngine = vm.runInNewContext(`({ ${html.slice(i, j)} })`,
  { crypto: webcrypto, TextEncoder, TextDecoder });

globalThis.window = globalThis;
require('../src/p2p/file-transfer.js');
const { FileTransfer } = globalThis;

const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
async function identity() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return { keyPair, publicKeyHex: hex(await webcrypto.subtle.exportKey('raw', keyPair.publicKey)) };
}

/**
 * Two endpoints joined by a wire that records every payload. `drop(frame,
 * from)` returning true loses a frame in transit (FT1).
 */
async function pair({ limits, drop } = {}) {
  const wire = [];
  const ends = {};
  const mk = (self, other) => {
    const listeners = [];
    return {
      on: (ev, fn) => { if (ev === 'file-chunk') listeners.push(fn); },
      deliver: (from, data) => Promise.all(listeners.map((fn) => fn(from, data))),
      sendOnChannel: async (to, ch, obj) => {
        const copy = JSON.parse(JSON.stringify(obj));
        wire.push({ ...copy, from: self });
        if (drop && drop(copy, self)) return true;
        ends[to].pm.deliver(self, copy);
        return true;
      },
    };
  };
  const a = await identity(), b = await identity();
  ends.A = { pm: mk('A', 'B'), id: a };
  ends.B = { pm: mk('B', 'A'), id: b };
  const keysFor = (me) => ({
    getPeerPublicKey: (peer) => ends[peer].id.publicKeyHex,
    getPrivateKey: () => ends[me].id.keyPair.privateKey,
  });
  const quiet = { warn: () => {} };
  ends.A.ft = new FileTransfer(ends.A.pm, CryptoEngine, keysFor('A'), { limits, log: quiet });
  ends.B.ft = new FileTransfer(ends.B.pm, CryptoEngine, keysFor('B'), { limits, log: quiet });
  return { ends, wire };
}

const waitFor = (ft, ev) => new Promise((resolve) => ft.on(ev, resolve));
// A real File: the sender reads it with slice() (FT1), as it would a picked file.
const blobOf = (bytes, name, type) => new File([bytes], name, { type });

test('a file sent from A arrives at B intact', async () => {
  const { ends } = await pair();
  const bytes = new Uint8Array(require('crypto').randomBytes(200 * 1024 + 7));
  const done = waitFor(ends.B.ft, 'complete');
  const errors = [];
  ends.B.ft.on('error', (e) => errors.push(e));
  await ends.A.ft.sendFile('B', blobOf(bytes, 'photo.png', 'image/png'));
  const { file } = await done;
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(file.name, 'photo.png');
  assert.strictEqual(file.size, bytes.length);
  const got = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
  assert.deepStrictEqual(got, bytes);
});

test('the wire carries neither the file name nor anything derivable into the key', async () => {
  const { ends, wire } = await pair();
  const bytes = new TextEncoder().encode('top secret contents');
  const done = waitFor(ends.B.ft, 'complete');
  await ends.A.ft.sendFile('B', blobOf(bytes, 'secret-plans.txt', 'text/plain'));
  await done;
  const onWire = JSON.stringify(wire);
  assert.ok(!onWire.includes('secret-plans'), 'file name leaked in the clear');
  // The old scheme: anyone who saw a chunk could rebuild its key.
  const chunk = wire.find((m) => m.type === 'file-chunk');
  delete chunk.from;
  for (const peer of ['A', 'B']) {
    const k = await webcrypto.subtle.importKey('raw',
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${peer}:${chunk.transferId}:${chunk.chunkIndex}`)),
      'AES-GCM', false, ['decrypt']);
    await assert.rejects(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(chunk.iv, 'hex') }, k, Buffer.from(chunk.data, 'hex')));
  }
});

test('peer-claimed sizes and chunk indexes are bounded', async () => {
  const { ends } = await pair();
  const B = ends.B.ft;
  const errors = [];
  const refused = [];
  B.on('error', (e) => errors.push(e.error));
  B.on('refused', (r) => refused.push(r.code));
  const seal = (meta) => CryptoEngine.encryptWithPublicKey(JSON.stringify({ key: 'ab'.repeat(32), meta }), ends.B.id.publicKeyHex);
  // totalChunks inconsistent with size, and an absurd size.
  await B._handleFileChunk('A', { type: 'file-meta', transferId: 't1', sealed: await seal({ name: 'x', size: 10, totalChunks: 1e9 }) });
  await B._handleFileChunk('A', { type: 'file-meta', transferId: 't2', sealed: await seal({ name: 'x', size: 1e13, totalChunks: Math.ceil(1e13 / 65536) }) });
  assert.strictEqual(B._transfers.size, 0);
  // A valid header, then chunk indexes outside the declared range are ignored.
  await B._handleFileChunk('A', { type: 'file-meta', transferId: 't3', sealed: await seal({ name: '../../etc/passwd', size: 10, totalChunks: 1, type: 'text/html' }) });
  const st = B._transfers.get('A\nt3');
  assert.ok(st);
  assert.strictEqual(st.fileName, '.._.._etc_passwd');
  assert.strictEqual(st.mimeType, 'application/octet-stream', 'a peer-chosen text/html blob must not keep its type');
  for (const idx of [-1, 1, 1e9, '0', 0.5]) {
    await B._handleFileChunk('A', { type: 'file-chunk', transferId: 't3', chunkIndex: idx, iv: '00'.repeat(12), data: '00'.repeat(32) });
  }
  assert.strictEqual(st.chunks.size, 0);
  // Another peer cannot touch A's transfer.
  await B._handleFileChunk('C', { type: 'file-done', transferId: 't3' });
  assert.ok(B._transfers.has('A\nt3'));
  // FT1: the inconsistent header is an error; the absurd size is a refusal (too large), reported to the sender.
  assert.strictEqual(errors.length, 1);
  assert.deepStrictEqual(refused, ['BAD_HEADER', 'FILE_TOO_LARGE']);
});

test('the sender does not report its own upload as a received file', async () => {
  const { ends } = await pair();
  let senderComplete = false;
  ends.A.ft.on('complete', () => { senderComplete = true; });
  const sent = waitFor(ends.A.ft, 'sent');
  const done = waitFor(ends.B.ft, 'complete');
  await ends.A.ft.sendFile('B', blobOf(new Uint8Array(10), 'a.bin', ''));
  await Promise.all([sent, done]);
  assert.strictEqual(senderComplete, false);
  assert.strictEqual(ends.B.ft._transfers.size, 0, 'finished transfer (and its plaintext chunks) must be released');
});

// ─── FT1: bounded, logged, honest ────────────────────────────────────────────
// Each limit at its boundary and one over. Every refusal and expiry must be
// logged and reported to the sender; the module's own documented values are used
// where that is cheap (headers declare sizes; no data is needed to refuse).

const MiB = 1024 * 1024;
const LIMITS = FileTransfer.LIMITS || {};
// The values FT1 documents, so a build without them fails at the behaviour, not on NaN.
const L = { maxFileBytes: 256 * MiB, maxIncoming: 16, maxIncomingPerPeer: 2, maxIncomingBytesPerPeer: 256 * MiB,
  maxIncomingBytes: 512 * MiB, maxQueuedFramesPerPeer: 64, ...LIMITS };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A receiver on a recording wire: replies per peer, its log, its refusals. */
async function receiver(limits) {
  const id = await identity();
  const replies = [];
  const logs = [];
  const listeners = {};
  const pm = {
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    sendOnChannel: async (to, ch, obj) => { replies.push({ to, ...JSON.parse(JSON.stringify(obj)) }); return true; },
  };
  const ft = new FileTransfer(pm, CryptoEngine, { getPrivateKey: () => id.keyPair.privateKey, getPeerPublicKey: () => null },
    { limits, log: { warn: (event, d) => logs.push({ event, ...(d || {}) }) } });
  const header = (size, keyHex = 'ab'.repeat(32)) => CryptoEngine.encryptWithPublicKey(
    JSON.stringify({ key: keyHex, meta: { name: 'f.bin', size, type: '', totalChunks: Math.ceil(size / 65536) } }), id.publicKeyHex);
  const meta = async (from, transferId, size, keyHex) => {
    await ft._handleFileChunk(from, { type: 'file-meta', transferId, sealed: await header(size, keyHex) });
    await sleep(0);
  };
  const open = (from, transferId) => ft._transfers.has(`${from}\n${transferId}`);
  const refusedTo = (from, transferId) => replies.find((r) => r.to === from && r.transferId === transferId && r.type === 'file-refused');
  const logged = (from, transferId) => logs.find((l) => l.peerId === from && l.transferId === transferId);
  const emit = (ev, ...a) => (listeners[ev] || []).forEach((fn) => fn(...a));
  return { ft, replies, logs, meta, open, refusedTo, logged, emit };
}

/** A valid encrypted chunk for a header sealed with keyHex. */
async function chunkFrame(keyHex, transferId, chunkIndex, bytes) {
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyHex, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${transferId}:${chunkIndex}`) }, key, bytes);
  return { type: 'file-chunk', transferId, chunkIndex, iv: hex(iv), data: hex(ct) };
}

function refusedAndLogged(r, from, transferId, what) {
  assert.ok(!r.open(from, transferId), `${what}: the transfer must not be open`);
  assert.ok(r.logged(from, transferId), `${what}: the refusal must be logged (no silent return)`);
  const reply = r.refusedTo(from, transferId);
  assert.ok(reply && typeof reply.reason === 'string' && reply.reason.length > 0, `${what}: the sender must be told why (file-refused with a reason)`);
}

test('FT1 limits are named, documented values', async () => {
  assert.strictEqual(LIMITS.maxIncomingPerPeer, 2);
  assert.strictEqual(LIMITS.maxIncoming, 16);
  assert.strictEqual(LIMITS.maxIncomingBytesPerPeer, 256 * MiB);
  assert.strictEqual(LIMITS.maxIncomingBytes, 512 * MiB);
  assert.strictEqual(LIMITS.maxFileBytes, LIMITS.maxIncomingBytesPerPeer, 'a whole file is held in memory: the largest file is the per-peer quota');
  for (const k of ['firstChunkTimeoutMs', 'idleTimeoutMs', 'transferLifetimeMs', 'maxQueuedFramesPerPeer', 'sendWindowChunks', 'ackEveryChunks', 'ackTimeoutMs']) {
    assert.ok(Number.isInteger(LIMITS[k]) && LIMITS[k] > 0, `${k} is a positive integer`);
  }
  assert.ok(LIMITS.maxQueuedFramesPerPeer > LIMITS.sendWindowChunks, 'an honest sender\'s window fits the receiver queue');
});

test('FT1 per-peer cap: the 2nd transfer is accepted, the 3rd refused, logged and reported; another peer still gets a slot', async () => {
  const r = await receiver();
  await r.meta('mallory', 'm0', 10); await r.meta('mallory', 'm1', 10);
  assert.ok(r.open('mallory', 'm0') && r.open('mallory', 'm1'), 'control: the first two from one peer are accepted (boundary)');
  for (let i = 2; i < 16; i++) await r.meta('mallory', `m${i}`, 10);
  refusedAndLogged(r, 'mallory', 'm2', 'one over the per-peer cap');
  assert.ok(r.replies.some((x) => x.to === 'mallory' && x.transferId === 'm1' && x.type === 'file-ack' && x.stage === 'accepted'), 'control: an accepted header is acknowledged as accepted');
  assert.strictEqual([...r.ft._transfers.keys()].filter((k) => k.startsWith('mallory\n')).length, 2);
  await r.meta('alice', 'a0', 10);
  assert.ok(r.open('alice', 'a0'), 'another peer is not blocked by one peer\'s never-finished transfers');
});

test('FT1 global cap: 16 open transfers are accepted, the 17th refused, logged and reported', async () => {
  const r = await receiver();
  for (let p = 0; p < 8; p++) for (let t = 0; t < 2; t++) await r.meta(`p${p}`, `t${t}`, 10);
  assert.strictEqual(r.ft._transfers.size, 16, 'control: 8 peers x 2 = 16 open (boundary)');
  await r.meta('p8', 't0', 10);
  refusedAndLogged(r, 'p8', 't0', 'one over the global cap');
});

test('FT1 per-peer byte quota: declared bytes up to the quota are accepted, one byte over is refused', async () => {
  const r = await receiver();
  const Q = L.maxIncomingBytesPerPeer;
  await r.meta('p', 'a', Q - 10); await r.meta('p', 'b', 10);
  assert.ok(r.open('p', 'a') && r.open('p', 'b'), 'control: exactly the quota is accepted (boundary)');
  await r.meta('q', 'a', Q - 10); await r.meta('q', 'b', 11);
  assert.ok(r.open('q', 'a'));
  refusedAndLogged(r, 'q', 'b', 'one byte over the per-peer quota');
});

test('FT1 largest file: exactly maxFileBytes is accepted, one byte more refused at the header', async () => {
  const r = await receiver();
  await r.meta('p', 'max', L.maxFileBytes);
  assert.ok(r.open('p', 'max'), 'control: a header of exactly maxFileBytes is accepted (boundary)');
  await r.meta('q', 'over', L.maxFileBytes + 1);
  refusedAndLogged(r, 'q', 'over', 'one byte over maxFileBytes');
});

test('FT1 global byte quota: two peers at their quota fill it; one more byte from a third is refused', async () => {
  const r = await receiver();
  const Q = L.maxIncomingBytesPerPeer;
  await r.meta('x', 'a', Q); await r.meta('y', 'a', Q); await r.meta('z', 'empty', 0);
  assert.ok(r.open('x', 'a') && r.open('y', 'a') && r.open('z', 'empty'), `control: ${L.maxIncomingBytes / MiB} MiB declared in total is accepted (boundary)`);
  await r.meta('w', 'a', 1);
  refusedAndLogged(r, 'w', 'a', 'one byte over the global quota');
});

test('FT1 a header with no data is freed after the first-chunk timeout, logged and reported', async () => {
  const r = await receiver({ firstChunkTimeoutMs: 150, idleTimeoutMs: 150, transferLifetimeMs: 5000 });
  await r.meta('p', 's', 100);
  await sleep(75);
  assert.ok(r.open('p', 's'), 'control: still open before the timeout');
  await sleep(250);
  refusedAndLogged(r, 'p', 's', 'first-chunk timeout');
});

test('FT1 a stalled transfer is freed after the idle timeout; chunks within it keep it open', async () => {
  const keyHex = 'cd'.repeat(32);
  const r = await receiver({ firstChunkTimeoutMs: 150, idleTimeoutMs: 150, transferLifetimeMs: 5000 });
  await r.meta('p', 's', 3 * 65536, keyHex);
  for (let i = 0; i < 2; i++) { await sleep(100); await r.ft._handleFileChunk('p', await chunkFrame(keyHex, 's', i, new Uint8Array(65536))); }
  assert.ok(r.open('p', 's'), 'control: 200 ms in, chunks every 100 ms kept a 150 ms idle timer from firing');
  await sleep(300);
  refusedAndLogged(r, 'p', 's', 'idle timeout');
  assert.ok(/stalled/.test(r.refusedTo('p', 's').reason), `reason names the stall (${r.refusedTo('p', 's').reason})`);
});

test('FT1 a transfer that never finishes is freed at its absolute lifetime', async () => {
  const keyHex = 'ef'.repeat(32);
  const r = await receiver({ firstChunkTimeoutMs: 150, idleTimeoutMs: 150, transferLifetimeMs: 500 });
  await r.meta('p', 'l', 40 * 65536, keyHex);
  let i = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 400) { await sleep(60); await r.ft._handleFileChunk('p', await chunkFrame(keyHex, 'l', i++, new Uint8Array(1024 * 64))); }
  assert.ok(r.open('p', 'l'), 'control: 400 ms in (past the idle timeout), still open while chunks keep coming');
  while (Date.now() - t0 < 700) { await sleep(60); await r.ft._handleFileChunk('p', await chunkFrame(keyHex, 'l', i++, new Uint8Array(1024 * 64))); }
  refusedAndLogged(r, 'p', 'l', 'absolute lifetime');
  assert.ok(/lifetime/.test(r.refusedTo('p', 'l').reason));
});

test('FT1 peer disconnect frees that peer\'s slots and quota, and only that peer\'s', async () => {
  const r = await receiver();
  await r.meta('p', 'a', L.maxIncomingBytesPerPeer); await r.meta('q', 'a', 10);
  r.emit('peer-disconnected', 'p');
  await sleep(0);
  assert.ok(!r.open('p', 'a'), 'the disconnected peer\'s transfer is freed');
  assert.ok(r.logged('p', 'a'), 'and the expiry is logged');
  assert.ok(r.open('q', 'a'), 'control: another peer\'s transfer stays');
  await r.meta('p', 'b', L.maxIncomingBytesPerPeer);
  assert.ok(r.open('p', 'b'), 'its byte quota was released: the same peer can be accepted again at full quota');
});

test('FT1 one peer\'s queue: 64 frames waiting are processed, the 65th is dropped, logged and ends its transfers', async () => {
  const run = async (n) => {
    const r = await receiver();
    await r.meta('f', 'x', 10);
    for (let i = 0; i < n; i++) r.emit('file-chunk', 'f', { type: 'file-chunk', transferId: 'x', chunkIndex: 999 + i, iv: '00'.repeat(12), data: '00' });
    await sleep(50);
    return r;
  };
  const atCap = await run(L.maxQueuedFramesPerPeer);
  assert.ok(atCap.open('f', 'x') && !atCap.logs.some((l) => l.event.includes('frames-dropped')), 'control: exactly maxQueuedFramesPerPeer queued frames are processed (boundary)');
  const over = await run(L.maxQueuedFramesPerPeer + 1);
  assert.ok(over.logs.some((l) => l.event.includes('frames-dropped') && l.peerId === 'f'), 'one over: the drop is logged');
  refusedAndLogged(over, 'f', 'x', 'queue overflow');
});

test('FT1 sender: an oversize file is refused before anything is read', async () => {
  const reads = [];
  const spyFile = (size) => ({ name: 'big.bin', type: '', size,
    slice: (...a) => { reads.push(['slice', ...a]); return { arrayBuffer: async () => new ArrayBuffer(Math.max(0, Math.min(size, a[1]) - a[0])) }; },
    arrayBuffer: async () => { reads.push(['arrayBuffer']); return new ArrayBuffer(Math.min(size, 1 << 20)); } });
  const { ends } = await pair();
  const statuses = [];
  ends.A.ft.on('status', (s) => statuses.push(s.status));
  let err = null;
  try { await ends.A.ft.sendFile('B', spyFile(L.maxFileBytes + 1)); } catch (e) { err = e; }
  assert.ok(err && err.code === 'FILE_TOO_LARGE', `refused as too large (got ${err && (err.code || err.message)})`);
  assert.deepStrictEqual(reads, [], 'no slice and no arrayBuffer before the refusal');
  assert.deepStrictEqual(statuses, ['failed']);
  // Boundary, with a small limit: exactly the limit is read chunk by chunk and sent; one byte more is refused unread.
  const small = await pair({ limits: { maxFileBytes: 128 * 1024 } });
  reads.length = 0;
  await small.ends.A.ft.sendFile('B', spyFile(128 * 1024));
  assert.ok(reads.length === 2 && reads.every((r) => r[0] === 'slice'), `control: a file of exactly the limit is read with two slices and no whole-file arrayBuffer (${JSON.stringify(reads.map((r) => r[0]))})`);
  reads.length = 0;
  let err2 = null;
  try { await small.ends.A.ft.sendFile('B', spyFile(128 * 1024 + 1)); } catch (e) { err2 = e; }
  assert.ok(err2 && err2.code === 'FILE_TOO_LARGE' && reads.length === 0, 'one byte over the limit: refused, nothing read');
});

test('FT1 sender: "sent" never appears before the receiver\'s complete ack', async () => {
  // Every ack from the receiver lost: nothing may say "sent".
  {
    const { ends } = await pair({ limits: { ackTimeoutMs: 300 }, drop: (f, from) => from === 'B' && f.type === 'file-ack' });
    const statuses = []; let sentEvent = false;
    ends.A.ft.on('status', (s) => statuses.push(s));
    ends.A.ft.on('sent', () => { sentEvent = true; });
    let err = null;
    try { await ends.A.ft.sendFile('B', blobOf(new Uint8Array(10), 'lost.bin', '')); } catch (e) { err = e; }
    await sleep(50);
    assert.ok(!sentEvent && !statuses.some((s) => s.status === 'sent'), `no "sent" without the receiver's ack (sendFile ${err ? 'rejected' : 'resolved'}, 'sent' event ${sentEvent})`);
    assert.ok(err && statuses.some((s) => s.status === 'failed' && s.reason), `failed with a reason (${err && err.message})`);
  }
  // Control: every frame delivered — 'sent' comes after the complete ack, in that order.
  {
    const { ends, wire } = await pair();
    const order = [];
    ends.A.ft.on('status', (s) => order.push(`status:${s.status}@${wire.length}`));
    await ends.A.ft.sendFile('B', blobOf(new Uint8Array(200 * 1024), 'ok.bin', ''));
    const completeAt = wire.findIndex((m) => m.from === 'B' && m.type === 'file-ack' && m.stage === 'complete');
    const sent = order.find((o) => o.startsWith('status:sent@'));
    assert.ok(completeAt >= 0 && sent && Number(sent.split('@')[1]) > completeAt, `control: sent after the complete ack (ack at ${completeAt}, ${sent})`);
    assert.strictEqual(order[0].split('@')[0], 'status:sending');
  }
});

test('FT1 sender: a receiver that cannot confirm delivery (pre-v2 ack) is a failure, not "sent"', async () => {
  const { ends } = await pair({ drop: (f, from) => from === 'B' && f.type === 'file-ack' });
  // Answer the header the way receivers before v2 did: an untagged ack, nothing after.
  const realSend = ends.A.pm.sendOnChannel;
  ends.A.pm.sendOnChannel = async (to, ch, obj) => {
    const r = await realSend(to, ch, obj);
    if (obj.type === 'file-meta') ends.A.pm.deliver('B', { type: 'file-ack', transferId: obj.transferId });
    return r;
  };
  let err = null;
  try { await ends.A.ft.sendFile('B', blobOf(new Uint8Array(10), 'old.bin', '')); } catch (e) { err = e; }
  assert.ok(err && err.code === 'OLD_RECEIVER', `refused to claim delivery (${err && (err.code || err.message)})`);
});

// A test that never settles would otherwise let node exit 0 with nothing run.
setTimeout(() => { console.log('FAIL: timed out'); process.exit(1); }, 90000).unref();

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack}`); }
  }
  console.log(failures ? `\n${failures} failing` : `\nall ${tests.length} passed`);
  process.exit(failures ? 1 : 0);
})();
