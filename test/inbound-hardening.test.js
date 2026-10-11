/**
 * Peer-controlled input handled in index.html:
 *   - sealed chat, voice and reaction payloads are shape-checked, and a voice
 *     note's `url` is never fetched
 *   - announced keys are pinned only after a sealed challenge is answered
 *   - the QR scanner reads Ghost Addresses
 *   - MessageVault cannot finish a write after lock()
 *
 * The code under test is extracted from index.html, not copied.
 * Run with: node test/inbound-hardening.test.js
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
function slice(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  assert.ok(i > -1, `could not find ${JSON.stringify(startMarker)} in index.html`);
  const j = html.indexOf(endMarker, i);
  assert.ok(j > -1, `could not find ${JSON.stringify(endMarker)} after it`);
  return html.slice(i, j);
}

const helpersSrc = slice('// ==================== INBOUND PAYLOAD SHAPING', '// ==================== PEER CACHE');
const addrSrc = slice("const GHOST_ADDRESS_ALPHABET", "const GHOST_ADDRESS_PATTERN") +
  slice('function normalizeGhostAddress(input) {', '\nfunction isGhostAddress');
const cryptoSrc = slice('  async encryptWithPublicKey(plaintext, pubKeyHex) {', '  /**\n   * Derive the legacy Yggdrasil');
const sealSrc = slice('async function sealPayload(', '// ==================== INBOUND PAYLOAD SHAPING');
const vaultSrc = slice('const SECURE_STORAGE_KEYS =', '\n// ==================== END-TO-END MESSAGE SEALING');

const store = {};
const sandbox = {
  crypto: webcrypto, console, TextEncoder, TextDecoder, Date, JSON,
  MSG_STORAGE_KEY: 'gl_messages', CHAIN_STORAGE_KEY: 'gl_chain',
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
vm.createContext(sandbox);
vm.runInContext(`
  const CryptoEngine = { ${cryptoSrc} };
  ${sealSrc}
  ${addrSrc}
  ${helpersSrc}
  ${vaultSrc}
  globalThis.__t = { sanitizeInboundChat, sanitizeInboundVoice, applyInboundReaction,
    createKeyPinning, ghostAddressFromScan, sealPayload, unsealPayload, MessageVault, REACTION_EMOJIS };
`, sandbox);
const T = sandbox.__t;
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── Payload shaping ────────────────────────────────────────────────────────

test('chat: fields that crashed the renderer come out as the types it expects', () => {
  const out = plain(T.sanitizeInboundChat({
    content: { evil: 1 }, msgType: 'file', sender: ['x'],
    meta: { chunks: { a: 1 }, fileName: { b: 2 }, fileSize: 'huge', replyTo: { sender: {}, preview: [] },
            mimeType: 'text/html', imageData: '<svg onload=x>', status: 'awaiting' },
  }, 'Alice'));
  assert.strictEqual(out.content, '');
  assert.strictEqual(out.msgType, 'file');
  assert.strictEqual(out.sender, 'Peer');
  assert.deepStrictEqual(out.meta, { replyTo: { index: 0, sender: '', preview: '' } });
});

test('chat: a legitimate message passes through unchanged', () => {
  const meta = { fileSize: 1234, chunks: 1, hash: 'abc', fileName: 'a.png', selfDestruct: 30,
                 imageData: 'iVBORw0KGgo=', mimeType: 'image/png', replyTo: { index: 3, sender: 'Bob', preview: 'hi' } };
  const out = plain(T.sanitizeInboundChat({ content: 'hello', msgType: 'image', sender: 'Bob', meta }, 'Alice'));
  assert.deepStrictEqual(out, { content: 'hello', msgType: 'image', meta, sender: 'Bob' });
});

test('chat: a peer cannot take our own name (bubbles are sided by name)', () => {
  assert.strictEqual(T.sanitizeInboundChat({ content: 'x', sender: 'Alice' }, 'Alice').sender, 'Alice (peer)');
  assert.strictEqual(T.sanitizeInboundChat({ content: 'x', msgType: 'script' }, 'Alice').msgType, 'text');
});

test('voice: peer-supplied url is dropped; waveform is always a bounded number array', () => {
  assert.strictEqual(T.sanitizeInboundVoice({ url: 'https://tracker.example/x.mp3' }, 'A'), null,
    'a voice note with no inline audio must be refused, not played from a URL');
  const v = plain(T.sanitizeInboundVoice({ audioData: 'AAAA', url: 'https://tracker.example/x.mp3',
    waveform: 'not-an-array', mimeType: 'text/html', sender: 'A', duration: {} }, 'A'));
  assert.ok(!('url' in v));
  assert.deepStrictEqual(v.waveform, []);
  assert.strictEqual(v.mimeType, 'audio/webm');
  assert.strictEqual(v.sender, 'A (peer)');
  assert.strictEqual(v.duration, 0);
  const big = T.sanitizeInboundVoice({ audioData: 'AAAA', waveform: new Array(100000).fill(5) }, 'A');
  assert.strictEqual(big.waveform.length, 12000);
  assert.ok(big.waveform.every((a) => a === 1));
});

test('reaction: inherited-property emoji no longer throw inside the state updater', () => {
  // The updater as it was before the fix, for the record.
  const before = (prev, r, peerId) => {
    const existing = prev[r.messageHash] || {};
    const reactors = existing[r.emoji] || [];
    if (!reactors.includes(peerId)) return { ...prev, [r.messageHash]: { ...existing, [r.emoji]: [...reactors, peerId] } };
    return prev;
  };
  assert.throws(() => before({}, { messageHash: 'h', emoji: 'toString' }, 'p'), TypeError);

  const prev = {};
  for (const emoji of ['toString', '__proto__', 'constructor', 'hasOwnProperty', '<img>']) {
    assert.strictEqual(T.applyInboundReaction(prev, 'h', emoji, 'p'), prev);
  }
  assert.strictEqual(T.applyInboundReaction(prev, { toString: 1 }, T.REACTION_EMOJIS[0], 'p'), prev);
  const next = T.applyInboundReaction(prev, 'h', T.REACTION_EMOJIS[0], 'p');
  assert.deepStrictEqual(plain(next), { h: { [T.REACTION_EMOJIS[0]]: ['p'] } });
  assert.strictEqual(T.applyInboundReaction(next, 'h', T.REACTION_EMOJIS[0], 'p'), next);
});

test('QR: the app\'s own invite QR payload yields its Ghost Address', () => {
  const qr = JSON.stringify({ c: 'GHOST-7K2-9QM-X4P', n: 'Alice', p: '04ab', t: Date.now() });
  assert.strictEqual(T.ghostAddressFromScan(qr), 'GHOST-7K2-9QM-X4P');
  assert.strictEqual(T.ghostAddressFromScan('ghost 7k2 9qm x4p'), 'GHOST-7K2-9QM-X4P');
  assert.strictEqual(T.ghostAddressFromScan('{"c":"nope"}'), null);
  assert.strictEqual(T.ghostAddressFromScan(null), null);
});

// ── Key pinning ────────────────────────────────────────────────────────────

const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
async function identity(name) {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return { name, keyPair, publicKeyHex: hex(await webcrypto.subtle.exportKey('raw', keyPair.publicKey)) };
}

/** A node on a fake mesh: `nodeId` is its authenticated transport address. */
function node(nodeId, ident, net) {
  const pinned = {};
  const n = {
    nodeId, ident, pinned,
    pinning: T.createKeyPinning({
      seal: T.sealPayload,
      unseal: (sealed) => T.unsealPayload(sealed, ident),
      selfIds: () => [nodeId],
      send: (to, payload) => net.push({ from: nodeId, to, payload }),
      getPinned: (peer) => pinned[peer] || null,
      pin: (peer, key) => { pinned[peer] = key; },
      randomHex: (k) => hex(webcrypto.getRandomValues(new Uint8Array(k))),
    }),
  };
  return n;
}

/** Deliver queued messages until the network is quiet. */
async function run(net, nodes, intercept = () => false) {
  while (net.length) {
    const m = net.shift();
    if (intercept(m)) continue;
    const dst = nodes[m.to];
    if (!dst) continue;
    const p = m.payload;
    if (p.type === 'key-challenge') await dst.pinning.onChallenge(m.from, p);
    else if (p.type === 'key-proof') dst.pinning.onProof(m.from, p);
  }
}

test('pinning: an honest peer\'s key is pinned once it answers the challenge', async () => {
  const net = [];
  const alice = node('A', await identity('alice'), net);
  const bob = node('B', await identity('bob'), net);
  const nodes = { A: alice, B: bob };
  assert.strictEqual(await alice.pinning.onAnnounce('B', { publicKeyHex: bob.ident.publicKeyHex }), 'challenged');
  assert.strictEqual(alice.pinned.B, undefined, 'must not pin before the proof');
  await run(net, nodes);
  assert.strictEqual(alice.pinned.B, bob.ident.publicKeyHex);
  assert.strictEqual(await alice.pinning.onAnnounce('B', { publicKeyHex: bob.ident.publicKeyHex }), 'known');
  const other = await identity('x');
  assert.strictEqual(await alice.pinning.onAnnounce('B', { publicKeyHex: other.publicKeyHex }), 'mismatch');
  assert.strictEqual(await alice.pinning.onAnnounce('B', { publicKeyHex: 'zz' }), 'invalid');
});

test('pinning: a node announcing someone else\'s public key is never pinned to it', async () => {
  const net = [];
  const alice = node('A', await identity('alice'), net);
  const admin = await identity('admin');
  const mallory = node('M', await identity('mallory'), net);
  const nodes = { A: alice, M: mallory };
  await alice.pinning.onAnnounce('M', { publicKeyHex: admin.publicKeyHex });
  // Mallory cannot open the challenge (sealed to the admin's key) and guesses.
  await run(net, nodes, (m) => {
    if (m.payload.type === 'key-challenge' && m.to === 'M') {
      alice.pinning.onProof('M', { type: 'key-proof', nonce: '00'.repeat(16) });
      return true;
    }
    return false;
  });
  assert.strictEqual(alice.pinned.M, undefined);
});

test('pinning: relaying the challenge to the real key holder does not help', async () => {
  const net = [];
  const alice = node('A', await identity('alice'), net);
  const admin = node('X', await identity('admin'), net);
  const mallory = node('M', await identity('mallory'), net);
  const nodes = { A: alice, X: admin, M: mallory };
  await alice.pinning.onAnnounce('M', { publicKeyHex: admin.ident.publicKeyHex });
  let relayed = false;
  await run(net, nodes, (m) => {
    // Mallory forwards Alice's challenge to the admin as its own, and would
    // forward any answer back to Alice.
    if (m.to === 'M' && m.payload.type === 'key-challenge') {
      net.push({ from: 'M', to: 'X', payload: m.payload });
      return true;
    }
    if (m.to === 'M' && m.payload.type === 'key-proof') {
      relayed = true;
      net.push({ from: 'M', to: 'A', payload: m.payload });
      return true;
    }
    return false;
  });
  assert.strictEqual(relayed, false, 'the real holder must refuse a challenge not addressed to it');
  assert.strictEqual(alice.pinned.M, undefined);
});

// ── Vault ─────────────────────────────────────────────────────────────────

test('vault: a write in flight when the vault is locked does not reach storage', async () => {
  const V = T.MessageVault;
  V._key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  delete store.gl_chain;
  const pending = V.save('gl_chain', [{ content: 'deleted history' }]);
  // Let the queued write start sealing, then lock (what deleteAccount does).
  await Promise.resolve(); await Promise.resolve();
  V.lock();
  assert.strictEqual(await pending, false);
  assert.ok(!('gl_chain' in store), 'locked vault wrote the old history back');
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
