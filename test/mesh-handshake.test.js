/**
 * Ghost Mesh identity handshake in P2PConnector:
 *
 *   - a session key is an ECDH product or the connection is refused (no
 *     fallback derived from public fingerprints)
 *   - an announced fingerprint must be the truncated SHA-256 of the announced key
 *
 * Run with: node test/mesh-handshake.test.js
 */
'use strict';

const assert = require('assert');

// ── Minimal browser surface the connector touches at construction ──────────
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.window = {
  addEventListener() {},
  dispatchEvent() {},
  ghostlink: undefined,
};
global.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
global.WebSocket = class WebSocket {};
global.RTCPeerConnection = class RTCPeerConnection {};

const { P2PConnector } = require('../src/p2p/p2p-connector.js');

const subtle = globalThis.crypto.subtle;
const hex = (buf) => Array.from(new Uint8Array(buf))
  .map((b) => b.toString(16).padStart(2, '0')).join('');

/** The fingerprint a key is entitled to claim (matches index.html). */
async function fingerprintFor(publicKeyHex) {
  const digest = await subtle.digest('SHA-256',
    new TextEncoder().encode(publicKeyHex.toLowerCase()));
  return hex(digest).slice(0, 16).toUpperCase();
}

async function makeIdentity(name) {
  const kp = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKeyHex = hex(await subtle.exportKey('raw', kp.publicKey));
  return {
    name,
    keyPair: kp,
    privateKey: kp.privateKey,
    publicKeyHex,
    fingerprint: await fingerprintFor(publicKeyHex),
  };
}

/** A connector wired to a fake mesh transport that records closes and sends. */
function makeConnector(identity) {
  const closed = [];
  const sent = [];
  global.window.ghostlink = {
    ghostMesh: {
      close: (connId) => closed.push(connId),
      send: async (connId, data) => sent.push({ connId, data }),
      // The constructor subscribes to these; each returns an unsubscribe fn.
      onPeerConnected: () => () => {},
      onData: () => () => {},
      onPeerDisconnected: () => () => {},
      startServer: async () => ({ success: true }),
    },
  };
  const c = new P2PConnector({ identity });
  c.identity = identity;
  return { c, closed, sent };
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('an honest peer establishes a real ECDH session key', async () => {
  const me = await makeIdentity('me');
  const them = await makeIdentity('them');
  const { c, closed } = makeConnector(me);

  await c._handleMeshData('conn-1', JSON.stringify({
    type: 'identity',
    fingerprint: them.fingerprint,
    name: them.name,
    publicKeyHex: them.publicKeyHex,
    reply: true,
  }));

  assert.deepStrictEqual(closed, [], 'honest peer must not be dropped');
  const session = c.meshConns[them.fingerprint];
  assert.ok(session, 'a session should exist for the peer');

  // Session keys are imported non-extractable, so prove the key by using it:
  // what the peer seals with the real ECDH secret must open, and what the old
  // public-data fallback would have produced must not.
  const ecdhBits = await subtle.deriveBits(
    { name: 'ECDH', public: them.keyPair.publicKey }, me.privateKey, 256);
  const realKey = await subtle.importKey(
    'raw', ecdhBits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({ hello: 'world' });
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv }, realKey, new TextEncoder().encode(payload));
  const opened = await subtle.decrypt({ name: 'AES-GCM', iv }, session.sharedKey, ct);
  assert.strictEqual(new TextDecoder().decode(opened), payload,
    'the session key must be the ECDH secret');

  // The key the removed fallback would have derived must be a different key.
  const fallbackBits = await subtle.digest('SHA-256',
    new TextEncoder().encode(me.fingerprint + ':' + them.fingerprint));
  const fallbackKey = await subtle.importKey(
    'raw', fallbackBits, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  await assert.rejects(
    subtle.decrypt({ name: 'AES-GCM', iv }, fallbackKey, ct),
    'a key derived from public fingerprints must not open the session');
});

test('a malformed public key is refused, not downgraded to a public-data key', async () => {
  const me = await makeIdentity('me');
  const them = await makeIdentity('them');
  const { c, closed } = makeConnector(me);

  // Claim a real fingerprint but send a key that cannot be imported. The old
  // code caught the failure and derived SHA-256(me.fingerprint + ':' + peerId).
  await c._handleMeshData('conn-2', JSON.stringify({
    type: 'identity',
    fingerprint: them.fingerprint,
    name: them.name,
    publicKeyHex: 'not-a-key',
    reply: true,
  }));

  assert.deepStrictEqual(closed, ['conn-2'], 'the connection must be torn down');
  assert.strictEqual(c.meshConns[them.fingerprint], undefined,
    'no session may be created without a real ECDH key');
});

test('an unparseable key that claims a matching fingerprint is still refused', async () => {
  const me = await makeIdentity('me');
  const { c, closed } = makeConnector(me);

  // Well-formed hex of the right length, but not a point on the curve — so it
  // passes the fingerprint binding yet fails importKey.
  const bogusKeyHex = '04' + 'ab'.repeat(64);
  await c._handleMeshData('conn-3', JSON.stringify({
    type: 'identity',
    fingerprint: await fingerprintFor(bogusKeyHex),
    name: 'liar',
    publicKeyHex: bogusKeyHex,
    reply: true,
  }));

  assert.deepStrictEqual(closed, ['conn-3'], 'the connection must be torn down');
  assert.strictEqual(Object.keys(c.meshConns).length, 0, 'no session may be created');
});

test('a key announced under someone else\'s fingerprint is refused', async () => {
  const me = await makeIdentity('me');
  const victim = await makeIdentity('victim');
  const attacker = await makeIdentity('attacker');
  const { c, closed } = makeConnector(me);

  await c._handleMeshData('conn-4', JSON.stringify({
    type: 'identity',
    fingerprint: victim.fingerprint,      // the name being impersonated
    name: victim.name,
    publicKeyHex: attacker.publicKeyHex,  // the key actually controlled
    reply: true,
  }));

  assert.deepStrictEqual(closed, ['conn-4'], 'the connection must be torn down');
  assert.strictEqual(c.meshConns[victim.fingerprint], undefined,
    'a peer must not hold a session under a fingerprint it cannot prove');
});

test('a missing local private key refuses the session rather than faking one', async () => {
  const me = await makeIdentity('me');
  const them = await makeIdentity('them');
  const { c, closed } = makeConnector({
    name: me.name,
    fingerprint: me.fingerprint,
    publicKeyHex: me.publicKeyHex,
    // no privateKey / keyPair — e.g. a half-restored identity
  });

  await c._handleMeshData('conn-5', JSON.stringify({
    type: 'identity',
    fingerprint: them.fingerprint,
    name: them.name,
    publicKeyHex: them.publicKeyHex,
    reply: true,
  }));

  assert.deepStrictEqual(closed, ['conn-5'], 'the connection must be torn down');
  assert.strictEqual(Object.keys(c.meshConns).length, 0, 'no session may be created');
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  if (failures) {
    console.error(`\n${failures} mesh-handshake test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll mesh-handshake tests passed');
})();
