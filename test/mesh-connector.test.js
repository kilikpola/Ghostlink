/**
 * GMPBridgeConnector (inline in index.html), driven against a fake WebSocket:
 *
 *   - joinRoom resolves a Ghost Address and connects by NodeID, refusing other
 *     kinds of code
 *   - when the bridge socket drops, the connector reconnects and silently
 *     restores every peer session
 *
 * Run with: node test/mesh-connector.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Extract the connector and its helpers out of index.html ────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const pattern = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm');
  const match = pattern.exec(html);
  if (!match) throw new Error(`index.html no longer declares: ${name}`);
  const start = match.index;

  // Single-line consts end at the newline; everything else is a top-level
  // block that closes at column 0.
  const firstLineEnd = html.indexOf('\n', start);
  const firstLine = html.slice(start, firstLineEnd);
  if (firstLine.startsWith('const') && firstLine.trimEnd().endsWith(';')) {
    return firstLine;
  }
  const close = html.indexOf('\n}', start);
  if (close === -1) throw new Error(`Could not find the end of: ${name}`);
  const semicolon = html[close + 2] === ';' ? 3 : 2;
  return html.slice(start, close + semicolon);
}

const SOURCE = [
  'PeerCache',
  'GHOST_ADDRESS_ALPHABET', 'GHOST_ADDRESS_LENGTH', 'GHOST_ADDRESS_PATTERN', 'NODE_ID_PATTERN',
  'ghostAddressFromNodeId', 'normalizeGhostAddress', 'isGhostAddress', 'isNodeIdHex',
  'KNOWN_PEERS_KEY', 'BLOCKED_PEERS_KEY', 'KNOWN_PEERS_MAX',
  'loadBlockedPeers', 'setPeerBlocked', 'loadKnownPeers', 'rememberKnownPeer', 'forgetKnownPeer',
  'getGmpPort', 'isTrustedBridgeTarget', 'getBridgeWsUrl',
  'MESH_TRANSPORT_LABELS', 'meshModeLabel',
  'GMPBridgeConnector'
].map(extract).join('\n\n');

// ── Browser shim ───────────────────────────────────────────────────────────
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

global.window = { location: { protocol: 'http:', search: '', hostname: 'localhost', host: 'localhost:3001', pathname: '/' } };

const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    sockets.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }

  // Test helpers
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  deliver(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
  /** Reply to the last request of `type` with `reply` fields, echoing requestId. */
  reply(type, replyType, reply) {
    const req = [...this.sent].reverse().find((m) => m.type === type);
    assert.ok(req, `expected a "${type}" request to have been sent`);
    this.deliver({ type: replyType, requestId: req.requestId, ...reply });
    return req;
  }
  lastSent(type) { return [...this.sent].reverse().find((m) => m.type === type); }
}
global.WebSocket = FakeWebSocket;

const scope = new Function('WebSocket', 'window', 'localStorage', `
  ${SOURCE}
  return { GMPBridgeConnector, ghostAddressFromNodeId, loadKnownPeers, rememberKnownPeer };
`)(FakeWebSocket, global.window, global.localStorage);

const { GMPBridgeConnector, ghostAddressFromNodeId } = scope;

const NODE_A = 'a1'.repeat(64);            // us
const NODE_B = '52ab5611'.padEnd(128, 'c'); // a peer
const NODE_C = '77991122'.padEnd(128, 'd'); // another peer

/** Build a connector whose socket is open and whose node has reported 'started'. */
async function makeStarted() {
  store.clear();
  sockets.length = 0;
  const conn = new GMPBridgeConnector({ name: 'Me' });
  const promise = conn.connect();
  const ws = sockets[sockets.length - 1];
  ws.open();
  await promise;
  ws.deliver({ type: 'started', nodeId: NODE_A, ghostAddress: ghostAddressFromNodeId(NODE_A) });
  return { conn, ws };
}

// ── Identity ───────────────────────────────────────────────────────────────

test("'started' gives the connector its own Ghost Address", async () => {
  const { conn } = await makeStarted();
  assert.strictEqual(conn.nodeId, NODE_A);
  assert.strictEqual(conn.ghostAddress, ghostAddressFromNodeId(NODE_A));
  conn.destroy();
});

test('an older bridge that omits the address still yields one', async () => {
  store.clear(); sockets.length = 0;
  const conn = new GMPBridgeConnector({});
  const promise = conn.connect();
  const ws = sockets[sockets.length - 1];
  ws.open();
  await promise;
  ws.deliver({ type: 'started', nodeId: NODE_A });
  assert.strictEqual(conn.ghostAddress, ghostAddressFromNodeId(NODE_A));
  conn.destroy();
});

test('waitUntilReady resolves once the node reports in', async () => {
  store.clear(); sockets.length = 0;
  const conn = new GMPBridgeConnector({});
  const promise = conn.connect();
  const ws = sockets[sockets.length - 1];
  ws.open();
  await promise;

  const ready = conn.waitUntilReady(2000);
  ws.deliver({ type: 'started', nodeId: NODE_A, ghostAddress: ghostAddressFromNodeId(NODE_A) });
  assert.strictEqual((await ready).ghostAddress, ghostAddressFromNodeId(NODE_A));
  conn.destroy();
});

// ── Joining by address ─────────────────────────────────────────────────────

test('joinRoom resolves a Ghost Address, then connects by NodeID', async () => {
  const { conn, ws } = await makeStarted();
  const address = ghostAddressFromNodeId(NODE_B);

  const joined = conn.joinRoom(address);
  await delay(10);

  const resolveReq = ws.lastSent('resolve');
  assert.strictEqual(resolveReq.address, address, 'sends a resolve for the normalised address');
  ws.reply('resolve', 'resolve-result', { reason: 'ok', nodeId: NODE_B, address });
  await delay(10);

  const connectReq = ws.lastSent('connectNode');
  assert.strictEqual(connectReq.nodeId, NODE_B, 'connects to the resolved NodeID — never to an IP');
  ws.reply('connectNode', 'connect-result', { connected: true, nodeId: NODE_B, transport: 'virtual' });

  assert.strictEqual(await joined, NODE_B);
  conn.destroy();
});

test('a sloppily typed address still resolves', async () => {
  const { conn, ws } = await makeStarted();
  const address = ghostAddressFromNodeId(NODE_B);

  const joined = conn.joinRoom(`  ${address.toLowerCase().replace(/-/g, '')}  `);
  await delay(10);
  assert.strictEqual(ws.lastSent('resolve').address, address);
  ws.reply('resolve', 'resolve-result', { reason: 'ok', nodeId: NODE_B, address });
  await delay(10);
  ws.reply('connectNode', 'connect-result', { connected: true, nodeId: NODE_B });
  assert.strictEqual(await joined, NODE_B);
  conn.destroy();
});

test('joinRoom rejects anything that is not an address', async () => {
  const { conn, ws } = await makeStarted();
  await assert.rejects(conn.joinRoom('v=0\r\no=- 46117 2 IN IP4 127.0.0.1'), /Ghost Address/);
  await assert.rejects(conn.joinRoom(''), /No connection code/);
  assert.strictEqual(ws.lastSent('resolve'), undefined, 'nothing was asked of the mesh');
  conn.destroy();
});

test('joinRoom refuses your own address instead of dialling yourself', async () => {
  const { conn } = await makeStarted();
  await assert.rejects(conn.joinRoom(ghostAddressFromNodeId(NODE_A)), /your own Ghost Address/);
  conn.destroy();
});

test('an ambiguous address is reported, not guessed at', async () => {
  const { conn, ws } = await makeStarted();
  const address = ghostAddressFromNodeId(NODE_B);
  const joined = conn.joinRoom(address);
  await delay(10);
  ws.reply('resolve', 'resolve-result', { reason: 'ambiguous', address, candidates: [NODE_B, NODE_C] });
  await assert.rejects(joined, /more than one identity/);
  assert.strictEqual(ws.lastSent('connectNode'), undefined, 'no connection was attempted');
  conn.destroy();
});

test('a legacy LAN code from an old build still dials', async () => {
  const { conn, ws } = await makeStarted();
  await conn.joinRoom('GHOST-192-168-1-5-49500');
  const req = ws.lastSent('connect');
  assert.deepStrictEqual([req.address, req.port], ['192.168.1.5', 49500]);
  conn.destroy();
});

// ── Staying connected ──────────────────────────────────────────────────────

test('the bridge socket is dialled back after it drops', async () => {
  const { conn, ws } = await makeStarted();
  const before = sockets.length;

  ws.close();
  assert.strictEqual(conn.wsOpen, false);

  await delay(1400); // first backoff step is 1s
  assert.ok(sockets.length > before, 'a new socket was opened without anyone asking');
  conn.destroy();
});

test('an explicit disconnect stays disconnected', async () => {
  const { conn } = await makeStarted();
  const before = sockets.length;
  conn.disconnect();
  await delay(1400);
  assert.strictEqual(sockets.length, before, 'a deliberate disconnect is not undone');
  conn.destroy();
});

test('peer sessions are restored after the socket comes back', async () => {
  const { conn, ws } = await makeStarted();
  ws.deliver({ type: 'peer-connected', nodeId: NODE_B });

  ws.close();
  await delay(1400);

  const ws2 = sockets[sockets.length - 1];
  ws2.open();
  ws2.deliver({ type: 'started', nodeId: NODE_A, ghostAddress: ghostAddressFromNodeId(NODE_A) });

  await delay(1400); // redial backoff
  const req = ws2.lastSent('connectNode');
  assert.ok(req && req.nodeId === NODE_B, 'the peer we were talking to is dialled again, unprompted');
  conn.destroy();
});

test('a peer that drops is picked up again on its own', async () => {
  const { conn, ws } = await makeStarted();
  ws.deliver({ type: 'peer-connected', nodeId: NODE_B });
  ws.deliver({ type: 'peer-disconnected', nodeId: NODE_B });

  await delay(1400);
  const req = ws.lastSent('connectNode');
  assert.ok(req && req.nodeId === NODE_B, 'a redial was attempted with no user action');
  conn.destroy();
});

test('a removed peer is not resurrected by the session restore', async () => {
  const { conn, ws } = await makeStarted();
  ws.deliver({ type: 'peer-connected', nodeId: NODE_B });
  ws.deliver({ type: 'peer-connected', nodeId: NODE_C });

  conn.removePeer(NODE_B);

  ws.close();
  await delay(1400);
  const ws2 = sockets[sockets.length - 1];
  ws2.open();
  ws2.deliver({ type: 'started', nodeId: NODE_A });
  await delay(1400);

  const dialled = ws2.sent.filter((m) => m.type === 'connectNode').map((m) => m.nodeId);
  assert.ok(!dialled.includes(NODE_B), 'the removed peer stays removed');
  assert.ok(dialled.includes(NODE_C), 'the other peer still comes back');
  conn.destroy();
});

test('a removal survives a reload, and a deliberate reconnect lifts it', async () => {
  const { conn, ws } = await makeStarted();
  ws.deliver({ type: 'peer-connected', nodeId: NODE_B });
  conn.removePeer(NODE_B);
  conn.destroy();

  // A fresh connector, as after a page reload: in-memory blocks are gone but
  // the persisted one must still hold.
  const fresh = new GMPBridgeConnector({});
  const promise = fresh.connect();
  const ws2 = sockets[sockets.length - 1];
  ws2.open();
  await promise;
  ws2.deliver({ type: 'started', nodeId: NODE_A });
  await delay(1400);
  assert.strictEqual(ws2.lastSent('connectNode'), undefined, 'the removal survived the reload');

  // Dialling them on purpose is consent and clears the block.
  const joined = fresh.connectToNode(NODE_B);
  await delay(10);
  ws2.reply('connectNode', 'connect-result', { connected: true, nodeId: NODE_B });
  await joined;
  assert.ok(scope.loadKnownPeers().some((p) => p.nodeId === NODE_B), 'the peer is remembered again');
  fresh.destroy();
});

test('in-flight requests fail fast when the socket drops', async () => {
  const { conn, ws } = await makeStarted();
  const joined = conn.joinRoom(ghostAddressFromNodeId(NODE_B));
  await delay(10);
  ws.close();
  await assert.rejects(joined, /disconnected|not reachable|not connected/i);
  conn.destroy();
});

// ── Runner ─────────────────────────────────────────────────────────────────
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
  console.log(failures === 0
    ? '\nAll mesh-connector tests passed'
    : `\n${failures} mesh-connector test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
