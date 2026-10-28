/**
 * A key proof delivered through the mailbox pins a key as mesh-proven only for
 * the AUTHENTICATED sender NodeID (task R3b, end to end).
 *
 *   gmp-core (real): storage host, StoreForward for X / R / Y, sf-crypto.
 *   bridge: what gmp-bridge.ts:297 publishes for a node 'message' event,
 *           { type: 'message', fromNodeId, payload, via } — restated here.
 *   renderer (real, extracted from index.html): GMPBridgeConnector on a fake
 *           bridge socket, and createKeyPinning. The component's dispatch
 *           (key-announce -> onAnnounce, key-proof -> onProof, passing meta.via)
 *           is restated in three lines.
 *
 * Attacks, before the genuine proof: the storage host forges a key-proof blob
 * claiming X (it is even given the nonce); contact Y sends the right nonce as
 * itself. Neither may pin anything. Control: X's own proof pins X's key, as
 * mesh-proven, under X's full NodeID.
 *
 * Run: node test/mailbox-key-proof.test.mjs
 */
import '../gmp-core/test/helpers/isolate-data.mjs';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = (p) => import(path.join(root, 'gmp-core', 'dist', p));
const { createGMPNode } = await core('node-factory.js');
const { DEFAULTS } = await core('config.js');
const { MemoryNetwork, MemoryTransport } = await core('transport/memory-transport.js');
const { Channel, pairSecret, sealBlob } = await core('storage/sf-crypto.js');
const { StoreForward } = await core('storage/store-forward.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

// ── Renderer side, extracted from index.html ──────────────────────────────
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function extract(name) {
  const m = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm').exec(html);
  if (!m) throw new Error(`index.html no longer declares: ${name}`);
  const first = html.slice(m.index, html.indexOf('\n', m.index));
  if (/^const [^\n]*;\s*(\/\/.*)?$/.test(first)) return first;
  const close = html.indexOf('\n}', m.index);
  return html.slice(m.index, close + (html[close + 2] === ';' ? 3 : 2));
}
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
global.window = { location: { protocol: 'http:', search: '', hostname: 'localhost', host: 'localhost:3001', pathname: '/' } };
const sockets = [];
class FakeWebSocket {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  deliver(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
}
global.WebSocket = FakeWebSocket;
const NAMES = ['SecretStore', 'PeerCache', 'GHOST_ADDRESS_ALPHABET', 'GHOST_ADDRESS_LENGTH', 'GHOST_ADDRESS_PATTERN', 'NODE_ID_PATTERN',
  'ghostAddressFromNodeId', 'normalizeGhostAddress', 'isGhostAddress', 'isNodeIdHex', 'KNOWN_PEERS_KEY', 'BLOCKED_PEERS_KEY',
  'KNOWN_PEERS_MAX', 'loadBlockedPeers', 'setPeerBlocked', 'loadKnownPeers', 'rememberKnownPeer', 'forgetKnownPeer',
  'getGmpPort', 'isTrustedBridgeTarget', 'getBridgeWsUrl', 'openBridgeSocket', 'MESH_TRANSPORT_LABELS', 'meshModeLabel', 'GMPBridgeConnector',
  'INBOUND_NAME_MAX', 'inboundStr', 'PINNABLE_KEY', 'NODE_ID_FULL', 'createKeyPinning'];
const lib = new Function('WebSocket', 'window', 'localStorage', `${NAMES.map(extract).join('\n\n')}\nreturn { GMPBridgeConnector, createKeyPinning, ghostAddressFromNodeId };`)(FakeWebSocket, global.window, global.localStorage);

// ── gmp-core side ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-mbkp-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0; const nodes = [];
async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({ config: { ...DEFAULTS, GMP_SF_DEPOSIT_BURST: 100000, GMP_SF_DEPOSIT_RATE_PER_MINUTE: 100000, ...cfg },
    dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new MemoryTransport(network) });
  node.on('error', () => {}); nodes.push(node);
  await node.loadIdentity(seed);
  return node;
}
const network = new MemoryNetwork();
const S = await makeNode(network, 'mbkp storage host', { GMP_STORAGE_ENABLED: true });
await S.listen();
const mailbox = { address: 'storage.example', port: S.port, nodeId: S.identity.nodeIdHex, operator: 'op' };
const X = await makeNode(network, 'mbkp sender X');
const R = await makeNode(network, 'mbkp recipient R');
const Y = await makeNode(network, 'mbkp contact Y');
const H = await makeNode(network, 'mbkp host-side party');
const sf = (node) => new StoreForward({ host: node, fetchBuckets: 4, ownMailbox: () => mailbox });
const sfX = sf(X), sfR = sf(R), sfY = sf(Y);
sfX.learnContact(R.identity.nodeIdHex, R.identity.staticPubKey); sfR.learnContact(X.identity.nodeIdHex, X.identity.staticPubKey);
sfY.learnContact(R.identity.nodeIdHex, R.identity.staticPubKey); sfR.learnContact(Y.identity.nodeIdHex, Y.identity.staticPubKey);
const XID = X.identity.nodeIdHex;

// R's renderer: a started connector on a fake bridge socket.
const conn = new lib.GMPBridgeConnector({ name: 'R' });
const opened = conn.connect();
const ws = sockets[sockets.length - 1];
ws.open(); await opened;
ws.deliver({ type: 'started', nodeId: R.identity.nodeIdHex, ghostAddress: lib.ghostAddressFromNodeId(R.identity.nodeIdHex) });
// The bridge publishing R's node 'message' events (gmp-bridge.ts:297).
sfR.on('message', (m) => ws.deliver({ type: 'message', fromNodeId: m.fromNodeId, payload: m.payload, via: 'mailbox' }));

const pins = []; const challenges = [];
const kp = lib.createKeyPinning({
  seal: async (obj) => JSON.stringify(obj), unseal: async (s) => JSON.parse(s),
  selfIds: () => [R.identity.nodeIdHex], send: (peerId, payload) => challenges.push({ peerId, payload }),
  getPinned: () => null, hasMeshPin: () => false,
  pin: (peerId, key, name, opts) => pins.push({ peerId, key, viaMesh: !!(opts && opts.viaMesh) }),
  randomHex: () => crypto.randomBytes(16).toString('hex'),
});
// The component's dispatch (index.html conn.on('message', ...)).
conn.on('message', async (peerId, msg, meta) => {
  if (msg && msg.type === 'key-announce') await kp.onAnnounce(peerId, msg, meta?.via);
  else if (msg && msg.type === 'key-proof') kp.onProof(peerId, msg, meta?.via);
});
const pollR = async (until) => { for (let i = 0; i < 20 && !until(); i++) await sfR.poll('test'); return until(); };
const KEY = '04' + crypto.randomBytes(64).toString('hex');

console.log('\n=== X announces its chat key through the mailbox ===');
await sfX.send(R.identity.nodeIdHex, JSON.stringify({ type: 'key-announce', publicKeyHex: KEY, name: 'x' }));
ok(await pollR(() => challenges.length > 0), 'R challenged the announcing peer');
const challenge = challenges[0];
ok(challenge && challenge.peerId === XID, `the challenge goes to X's full NodeID (${challenge && challenge.peerId.slice(0, 16)}…)`);
const nonce = challenge ? JSON.parse(challenge.payload.sealed).nonce : null;

console.log('\n=== attacks before X answers ===');
{
  // The host forges a key-proof from "X" carrying the right nonce.
  const guess = pairSecret(H.identity.staticPrivKey, X.identity.nodeId, R.identity.staticPubKey, R.identity.nodeId);
  const ch = new Channel(guess, R.identity.nodeId);
  const forged = sealBlob(R.identity.staticPubKey, { tag: ch.tag(ch.epoch(Math.floor(Date.now() / 1000))), receiptSecret: crypto.randomBytes(32),
    senderNodeId: Buffer.from(X.identity.nodeId), payload: Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify({ type: 'key-proof', nonce }))]) });
  sfR._receive({ blobs: [{ blobId: 'forged-proof', blob: forged }] });
  // Contact Y, authenticated as itself, sends X's nonce.
  await sfY.send(R.identity.nodeIdHex, JSON.stringify({ type: 'key-proof', nonce }));
  let yDelivered = false;
  const onY = (m) => { if (m.fromNodeId === Y.identity.nodeIdHex) yDelivered = true; };
  sfR.on('message', onY);
  await pollR(() => yDelivered);
  ok(yDelivered, 'control: Y\'s message did reach R\'s renderer (tagged as Y)');
}
const pinsAfterAttacks = pins.length;

console.log('\n=== X answers through the mailbox ===');
await sfX.send(R.identity.nodeIdHex, JSON.stringify({ type: 'key-proof', nonce }));
await pollR(() => pins.length > pinsAfterAttacks);
assertAbsent({
  channel: 'a key pin from the host forgery or from Y',
  controlMessage: 'X\'s own proof, through the same mailbox and renderer path, pins a key',
  control: () => pins.length - pinsAfterAttacks,
  absent: () => pinsAfterAttacks === 0,
  message: `no pin from the forged blob or from Y (pins before X answered: ${pinsAfterAttacks})`,
});
ok(pins.length === 1 && pins[0].peerId === XID && pins[0].key === KEY && pins[0].viaMesh === true,
  'exactly one pin: X\'s key, under X\'s full NodeID, mesh-proven');

conn.destroy && conn.destroy();
for (const node of nodes) { try { await node.stop(); } catch { /* best effort */ } }
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
