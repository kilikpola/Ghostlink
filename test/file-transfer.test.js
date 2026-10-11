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
const j = html.indexOf('  /**\n   * Derive the legacy Yggdrasil', i);
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

/** Two endpoints joined by a wire that records every payload. */
async function pair() {
  const wire = [];
  const ends = {};
  const mk = (self, other) => {
    const listeners = [];
    return {
      on: (ev, fn) => { if (ev === 'file-chunk') listeners.push(fn); },
      deliver: (from, data) => Promise.all(listeners.map((fn) => fn(from, data))),
      sendOnChannel: async (to, ch, obj) => {
        const copy = JSON.parse(JSON.stringify(obj));
        wire.push(copy);
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
  ends.A.ft = new FileTransfer(ends.A.pm, CryptoEngine, keysFor('A'));
  ends.B.ft = new FileTransfer(ends.B.pm, CryptoEngine, keysFor('B'));
  return { ends, wire };
}

const waitFor = (ft, ev) => new Promise((resolve) => ft.on(ev, resolve));
const blobOf = (bytes, name, type) => ({ name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) });

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
  B.on('error', (e) => errors.push(e.error));
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
  assert.strictEqual(errors.length, 2);
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

// A test that never settles would otherwise let node exit 0 with nothing run.
setTimeout(() => { console.log('FAIL: timed out'); process.exit(1); }, 30000).unref();

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack}`); }
  }
  console.log(failures ? `\n${failures} failing` : `\nall ${tests.length} passed`);
  process.exit(failures ? 1 : 0);
})();
