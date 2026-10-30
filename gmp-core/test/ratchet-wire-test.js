/**
 * The ratchet wired into the node and the bridge (identity-v2.md §3.1, §3.2,
 * §4, D13; task R7). Every negative has a positive control.
 *
 *  1. wire format: content type 0x02 inside DATA (the forwarder's literal
 *     matches ratchet-wire), padding classes, binary across the bridge as base64.
 *  2. two nodes through two bridges (memory transport): 50 messages each way,
 *     interleaved, exactly once, intact, tagged with the full NodeID.
 *  3. restart mid-conversation: sealed store continues; memory-only
 *     re-handshakes and the peer's event lists what was never acknowledged.
 *  4. not connected → RatchetNotConnectedError; control: connected → delivered.
 *  5. padding on the wire: direct frames 253 / 1021 / 4093 and relayed records
 *     272 / 1040 / 4112 for 0, 1, 200, 900, 3000 bytes; control: unpadded varies.
 *  6. factory: a ratchet-capable node with no ratchet spec refuses to start.
 *  7. no sealPayload on the ratchet send path (planted control).
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { absenceAsserter } from './helpers/assert-absent.mjs';
import { fileAnchor } from './helpers/ratchet-store-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let W = null, M = null;
try { W = await import('../dist/ratchet/ratchet-wire.js'); M = await import('../dist/gmp-node-manager.js'); } catch (e) { console.log(`  (import failed: ${e.code || e.message})`); }
console.log('\n=== the module exists ===');
ok(!!W && typeof W.padContent === 'function' && !!M && typeof M.GMPNodeManager.prototype.ratchetSend === 'function',
  'dist/ratchet/ratchet-wire.js exists and GMPNodeManager has ratchetSend()');
if (!W || !M?.GMPNodeManager.prototype.ratchetSend) done();
const { GMPNodeManager } = M;
const { startBridge } = await import('../dist/gmp-bridge.js');
const { MemoryNetwork, MemoryTransport, MemoryConnection } = await import('../dist/transport/memory-transport.js');
const { createGMPNode } = await import('../dist/node-factory.js');
const { DEFAULTS } = await import('../dist/config-defaults.js');
const R = await import('../dist/ratchet/ratchet.js');
const S = await import('../dist/ratchet/ratchet-store.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-wire-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let nDir = 0;
const dirOf = (l) => { const d = path.join(tmp, `${String(++nDir).padStart(3, '0')}-${l}`); fs.mkdirSync(d, { recursive: true }); return d; };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const TOKEN = crypto.randomBytes(16).toString('hex');
const base = { disableBootstrap: true, GMP_LAN_DISCOVERY: false, storeForward: false, GMP_METRICS_PORT: 0, GMP_PORT: 0 };

/** A manager on the memory network with a bridge and a WS client to it. */
async function peer(network, label, ratchets, extra = {}) {
  const dataDir = dirOf(label);
  const m = new GMPNodeManager({ ...base, seedPhrase: `r7 wire test ${label} seed phrase`, transport: new MemoryTransport(network), dataDir, ratchetCapable: true, ratchets, ...extra });
  const bridgePort = await freePort();
  const bridge = await startBridge(m, bridgePort, '127.0.0.1', { authToken: TOKEN });
  const started = await m.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, [TOKEN]);
  const inbox = [];
  const events = [];
  const waiting = new Map();
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString('utf8'));
    if (msg.type === 'ratchet-message') inbox.push(msg);
    else if (msg.type && msg.type.startsWith('ratchet-') && msg.type !== 'ratchet-send-result' && msg.type !== 'ratchet-status') events.push(msg);
    if (msg.requestId !== undefined && waiting.has(msg.requestId)) { waiting.get(msg.requestId)(msg); waiting.delete(msg.requestId); }
  });
  await new Promise((r) => ws.on('open', r));
  let rid = 0;
  const request = (obj) => new Promise((resolve) => { const id = `${label}-${++rid}`; waiting.set(id, resolve); ws.send(JSON.stringify({ ...obj, requestId: id })); });
  const send = (to, bytes) => request({ type: 'ratchet-send', to, payloadB64: Buffer.from(bytes).toString('base64') });
  const stop = async () => { ws.close(); await bridge.close(); await m.stop(); };
  return { m, label, nodeId: started.nodeId, port: started.port, inbox, events, request, send, stop, dataDir };
}
async function connect(a, b) {
  const r = await a.m.connectToPeer('memory', b.port);
  for (let i = 0; i < 100 && !b.m.node?.getLinkByNodeId(a.nodeId); i++) await delay(20);
  return r.connected && !!b.m.node.getLinkByNodeId(a.nodeId);
}
const waitFor = async (pred, ms = 5000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await delay(20); return pred(); };
const randomBytes = (n, seed) => { const out = Buffer.alloc(n); for (let i = 0; i < n; i += 32) crypto.createHash('sha256').update(`${seed}/${i}`).digest().copy(out, i, 0, Math.min(32, n - i)); return out; };

// ── 1. wire format ────────────────────────────────────────────────────────
console.log('\n=== 1. wire format: content type, padding classes ===');
{
  const fwd = fs.readFileSync(path.join(pkg, 'src', 'forwarder.ts'), 'utf8');
  const literal = Number(/const RATCHET_CONTENT_TYPE = (0x[0-9a-f]+);/.exec(fwd)?.[1]);
  ok(W.RATCHET_CONTENT_TYPE === 0x02 && literal === W.RATCHET_CONTENT_TYPE, `content type 0x02 in ratchet-wire and the forwarder (${literal}); 0x01 stays the routed flag`);
  const sizes = [0, 1, 200, 900, 3000].map((n) => [1, 2].map((kind) => 1 + R.OVERHEAD[kind] + W.padContent(new Uint8Array(n), kind).length));
  ok(sizes.every((pair) => pair.every((s) => W.DATA_CLASSES.includes(s))), `DATA plaintext for 0/1/200/900/3000 bytes, kinds 0x01/0x02: ${sizes.map((p) => p.join('/')).join(', ')} — all in 232/1000/4072`);
  const p = W.padContent(randomBytes(700, 'u'), 1);
  ok(Buffer.from(W.unpadContent(p)).equals(randomBytes(700, 'u')) && p.length === 925, 'padding round-trips; 700 bytes pad to 925 (kind 0x01)');
  let tooBig = null; try { W.padContent(new Uint8Array(3996), 1); } catch (e) { tooBig = e.name; }
  ok(tooBig === 'RatchetPayloadTooLargeError' && W.padContent(new Uint8Array(3995), 1).length === 3997, `3995 bytes is the largest message (kind 0x01); 3996 is refused (${tooBig})`);
}

// ── 2. 50 each way through the bridges ────────────────────────────────────
console.log('\n=== 2. two nodes, two bridges: 50 messages each way, interleaved ===');
{
  const network = new MemoryNetwork();
  const a = await peer(network, 'alice', { memoryOnly: 'test: memory transport' });
  const b = await peer(network, 'bob', { memoryOnly: 'test: memory transport' });
  ok(await connect(a, b), 'alice and bob are connected');
  const sent = { [a.nodeId]: [], [b.nodeId]: [] };
  const replies = [];
  for (let i = 0; i < 50; i++) {
    // Interleaved: both sides send in the same round (the first round is a glare), then wait for the round to land.
    const round = [];
    for (const [from, to] of [[a, b], [b, a]]) {
      const bytes = randomBytes(i * 37 % 1500, `${from.label}-${i}`);     // binary, every byte value
      sent[from.nodeId].push(bytes.toString('hex'));
      round.push(from.send(to.nodeId, bytes));
    }
    replies.push(...await Promise.all(round));
    await waitFor(() => a.inbox.length >= i + 1 && b.inbox.length >= i + 1, 3000);
  }
  await waitFor(() => a.inbox.length >= 50 && b.inbox.length >= 50);
  await delay(200);
  const check = (who, other) => {
    const got = who.inbox.map((x) => Buffer.from(x.payloadB64, 'base64').toString('hex'));
    const ids = who.inbox.map((x) => x.messageId);
    return { n: got.length, intact: JSON.stringify([...got].sort()) === JSON.stringify([...sent[other.nodeId]].sort()), once: new Set(ids).size === ids.length && new Set(got).size === got.length,
      from: who.inbox.every((x) => x.fromNodeId === other.nodeId && x.fromNodeId.length === 128) };
  };
  const ca = check(a, b), cb = check(b, a);
  ok(replies.every((r) => r.type === 'ratchet-send-result' && /^[0-9a-f]{32}$/.test(r.messageId)), `all 100 sends answered with a messageId (${replies.filter((r) => r.type !== 'ratchet-send-result').map((r) => r.code).join(', ') || 'no errors'})`);
  ok(ca.n === 50 && cb.n === 50 && ca.intact && cb.intact && ca.once && cb.once, `each side got exactly its 50, every byte intact, none twice (alice ${ca.n}, bob ${cb.n})`);
  ok(ca.from && cb.from, 'every message is tagged with the sender\'s full 128-hex NodeID');
  const initials = replies.filter((r) => r.kind === 'initial').length;
  ok(initials >= 2 && initials <= 4 && replies.filter((r) => r.kind === 'ratchet').length === 100 - initials,
    `the first sends start the session (both sides at once: a glare; ${initials} kind 0x02), every later one is a ratchet message`);
  const legacy = [];
  b.m.on('message', (x) => legacy.push(x));
  await a.m.sendMessage(b.nodeId, 'plain string still works');
  await waitFor(() => legacy.length > 0, 2000);
  ok(legacy[0]?.payload === 'plain string still works' && b.inbox.length === 50, 'control: the existing string API is unchanged beside it');
  await a.stop(); await b.stop();
}

// ── 2b. over a mesh-routed (virtual) link ─────────────────────────────────
console.log('\n=== 2b. over a mesh-routed (virtual) link: alice and bob each linked only to a hub ===');
{
  const network = new MemoryNetwork();
  const hubDir = dirOf('hub');
  const hub = new GMPNodeManager({ ...base, seedPhrase: 'r7 wire test hub seed phrase', transport: new MemoryTransport(network), dataDir: hubDir });
  const hs = await hub.start();
  const a = await peer(network, 'alice-v', { memoryOnly: 'test' });
  const b = await peer(network, 'bob-v', { memoryOnly: 'test' });
  await a.m.connectToPeer('memory', hs.port); await b.m.connectToPeer('memory', hs.port);
  await delay(300);
  const routed = await a.m.node.topologyManager.queryRoute(b.nodeId);
  const conn = await a.m.connectByNodeId(b.nodeId);
  await waitFor(() => !!b.m.node.virtualConnections.get(a.nodeId.slice(0, 64)), 3000);
  const noDirect = !a.m.node.getLinkByNodeId(b.nodeId) && !b.m.node.getLinkByNodeId(a.nodeId);
  const r1 = await a.send(b.nodeId, randomBytes(300, 'v1'));
  await waitFor(() => b.inbox.length === 1);
  const r2 = await b.send(a.nodeId, randomBytes(300, 'v2'));
  await waitFor(() => a.inbox.length === 1);
  ok(routed === true && conn.connected && conn.transport === 'virtual' && noDirect, `route found through the hub; a virtual link and no direct alice–bob link (${conn.transport})`);
  ok(r1.type === 'ratchet-send-result' && r2.type === 'ratchet-send-result' && b.inbox[0]?.fromNodeId === a.nodeId && a.inbox[0]?.fromNodeId === b.nodeId &&
    Buffer.from(b.inbox[0].payloadB64, 'base64').equals(randomBytes(300, 'v1')) && Buffer.from(a.inbox[0].payloadB64, 'base64').equals(randomBytes(300, 'v2')),
    `ratchet messages cross the virtual link both ways, intact, tagged with full NodeIDs (${r1.code || 'ok'} / ${r2.code || 'ok'})`);
  await a.stop(); await b.stop(); await hub.stop();
}

// ── 3. restart ────────────────────────────────────────────────────────────
console.log('\n=== 3. restart one side mid-conversation ===');
{
  const network = new MemoryNetwork();
  const storeDir = dirOf('alice-sealed');
  const anchorFile = path.join(storeDir, 'keyring', 'anchor.json');
  const sealedSpec = () => ({ dir: path.join(storeDir, 'ratchets'), anchor: fileAnchor(anchorFile).provider });
  let a = await peer(network, 'alice-s', sealedSpec());
  const b = await peer(network, 'bob-s', { memoryOnly: 'test' });
  await connect(a, b);
  for (let i = 0; i < 5; i++) { await a.send(b.nodeId, Buffer.from(`a${i}`)); await b.send(a.nodeId, Buffer.from(`b${i}`)); }
  await waitFor(() => a.inbox.length === 5 && b.inbox.length === 5);
  await a.stop();
  a = await peer(network, 'alice-s', sealedSpec());
  ok(await connect(a, b), 'alice restarts (same seed, same sealed store) and reconnects');
  for (let i = 5; i < 10; i++) { await a.send(b.nodeId, Buffer.from(`a${i}`)); await b.send(a.nodeId, Buffer.from(`b${i}`)); }
  await waitFor(() => a.inbox.length === 5 && b.inbox.length === 10);
  const st = await a.request({ type: 'ratchet-status' });
  ok(st.mode === 'sealed' && a.inbox.map((x) => Buffer.from(x.payloadB64, 'base64').toString()).join() === 'b5,b6,b7,b8,b9' &&
    b.inbox.map((x) => Buffer.from(x.payloadB64, 'base64').toString()).join() === 'a0,a1,a2,a3,a4,a5,a6,a7,a8,a9' && b.events.filter((e) => e.type === 'ratchet-session-replaced').length === 0,
    'sealed store: the same session continues after the restart, no re-handshake, nothing lost or repeated');
  await a.stop(); await b.stop();

  // Memory-only: the restarted side has no state; it starts over and the peer reports what never got through.
  const net2 = new MemoryNetwork();
  let c = await peer(net2, 'carol-m', { memoryOnly: 'test' });
  const d = await peer(net2, 'dave-m', { memoryOnly: 'test' });
  await connect(c, d);
  const dSent = [];
  for (let i = 0; i < 4; i++) { await c.send(d.nodeId, Buffer.from(`c${i}`)); dSent.push((await d.send(c.nodeId, Buffer.from(`d${i}`))).messageId); }
  await waitFor(() => c.inbox.length === 4);
  await c.stop();
  await waitFor(() => !d.m.node.getLinkByNodeId(c.nodeId));
  const whileDown = await d.send(c.nodeId, Buffer.from('while carol is down'));
  c = await peer(net2, 'carol-m', { memoryOnly: 'test' });
  await connect(c, d);
  await c.send(d.nodeId, Buffer.from('carol is back'));
  await waitFor(() => d.events.some((e) => e.type === 'ratchet-session-replaced'));
  const ev = d.events.find((e) => e.type === 'ratchet-session-replaced');
  ok(whileDown.type === 'error' && whileDown.code === 'RatchetNotConnectedError', `while carol is down, dave's send fails by name (${whileDown.code}), nothing queued`);
  ok(ev && ev.reason === 'peer-reset' && JSON.stringify([...ev.unacknowledged].sort()) === JSON.stringify([...dSent].sort()),
    `memory-only: carol re-handshakes; dave's event lists every message he sent and never had acknowledged (${ev ? ev.unacknowledged.length : 0} of ${dSent.length}; no receipts exist yet, R9)`);
  const after = await d.send(c.nodeId, Buffer.from('welcome back'));
  await waitFor(() => c.inbox.some((x) => Buffer.from(x.payloadB64, 'base64').toString() === 'welcome back'));
  ok(after.type === 'ratchet-send-result' && c.inbox.some((x) => Buffer.from(x.payloadB64, 'base64').toString() === 'welcome back'), 'control: the new session carries dave\'s next message');
  await c.stop(); await d.stop();
}

// ── 4. not connected ──────────────────────────────────────────────────────
console.log('\n=== 4. not connected → a named error, nothing queued ===');
{
  const network = new MemoryNetwork();
  const a = await peer(network, 'alice-nc', { memoryOnly: 'test' });
  const b = await peer(network, 'bob-nc', { memoryOnly: 'test' });
  const r = await a.send(b.nodeId, Buffer.from('nobody home'));
  await delay(200);
  ok(r.type === 'error' && r.code === 'RatchetNotConnectedError' && b.inbox.length === 0, `not connected: ${r.code}; nothing arrives later`);
  await connect(a, b);
  await delay(300);
  ok(b.inbox.length === 0, 'and connecting afterwards delivers nothing from the failed send (no silent queue)');
  const r2 = await a.send(b.nodeId, Buffer.from('now connected'));
  await waitFor(() => b.inbox.length === 1);
  ok(r2.type === 'ratchet-send-result' && Buffer.from(b.inbox[0].payloadB64, 'base64').toString() === 'now connected', 'control: once connected the same send is delivered');
  const bad = await a.request({ type: 'ratchet-send', to: b.nodeId, payloadB64: 'not base64!' });
  ok(bad.type === 'error' && bad.code === 'INVALID_PAYLOAD', `a payload that is not base64 is refused (${bad.code})`);
  await a.stop(); await b.stop();
}

// ── 5. padding on the wire ────────────────────────────────────────────────
console.log('\n=== 5. padding on the wire: direct frames and relayed records ===');
{
  const SIZES = [0, 1, 200, 900, 3000];
  const capture = async (padding) => {
    const network = new MemoryNetwork();
    const a = await peer(network, `alice-pad-${padding}`, { memoryOnly: 'test' }, { ratchetPadding: padding });
    const b = await peer(network, `bob-pad-${padding}`, { memoryOnly: 'test' });
    await connect(a, b);
    await delay(200);
    const frames = [];
    const orig = MemoryConnection.prototype.write;
    MemoryConnection.prototype.write = function (data, cb) { const buf = Buffer.from(data); if (buf.length >= 5 && buf[4] === 0x03) frames.push(buf.length); return orig.call(this, data, cb); };
    try {
      for (const n of SIZES) { await a.send(b.nodeId, randomBytes(n, `pad${n}`)); await delay(30); }   // first: kind 0x02
      await b.send(a.nodeId, Buffer.from('ack')); await delay(100);
      for (const n of SIZES) { await a.send(b.nodeId, randomBytes(n, `pad2${n}`)); await delay(30); } // then kind 0x01
    } finally { MemoryConnection.prototype.write = orig; }
    await waitFor(() => b.inbox.length === 10);
    const intact = b.inbox.length === 10;
    await a.stop(); await b.stop();
    return { frames, intact };
  };
  const padded = await capture(true);
  ok(padded.intact && padded.frames.length === 11 && padded.frames.every((l) => [253, 1021, 4093].includes(l)),
    `direct link, padded: ${padded.frames.length} DATA frames, lengths ${[...new Set(padded.frames)].join(' / ')} — only 253 / 1021 / 4093 (= one 272 / 1040 / 4112 relay record each)`);
  const bare = await capture(false);
  ok(bare.intact && new Set(bare.frames).size >= 8, `control: padding off → ${new Set(bare.frames).size} different frame lengths (${[...new Set(bare.frames)].sort((x, y) => x - y).join(', ')})`);

  // Relayed: A dials B through a relay; the relay sees only [circuitId u32][sealed record].
  const network = new MemoryNetwork();
  const mk = async (seed, cfg = {}) => { const node = createGMPNode({ config: { ...DEFAULTS, ...cfg }, dataDir: dirOf(seed), port: 0, transport: new MemoryTransport(network) }); node.on('error', () => {}); await node.loadIdentity(`r7 relay ${seed}`); return node; };
  const relay = await mk('relay', { GMP_RELAY_ENABLED: true }); await relay.listen();
  const A = await mk('alice'), B = await mk('bob');
  const records = [];
  const origHandle = relay.relayServer.handleFrame.bind(relay.relayServer);
  relay.relayServer.handleFrame = (link, type, plaintext) => { if (type === 0x0F && plaintext.length > 4) records.push(plaintext.length - 4); return origHandle(link, type, plaintext); };
  const res = await B.reserveRelay({ address: 'memory', port: relay.port });
  const incoming = new Promise((resolve) => B.on('connection', (e) => { if (e.link.socket && e.link.socket.isRelayed) resolve(e); }));
  const out = await A.dialRelayed({ address: 'memory', port: relay.port }, res.voucherId, B.identity.staticPubKey);
  const inc = await incoming;
  const sa = S.memoryOnlyRatchetStore('test relay A', { identity: A.identity }), sb = S.memoryOnlyRatchetStore('test relay B', { identity: B.identity });
  const deps = { rng: (k) => new Uint8Array(crypto.randomBytes(k)), now: () => Date.now() };
  const got = [];
  B.on('ratchet-data', ({ message }) => { const r = sb.receive(A.identity.nodeIdHex, message, deps, { peerStaticPub: A.identity.staticPubKey }); if (r.ok) got.push(W.unpadContent(r.plaintext).length); });
  await delay(200);
  records.length = 0;
  sa.initiate(B.identity.nodeIdHex, { peerStaticPub: B.identity.staticPubKey }, deps);
  for (const n of SIZES) {
    const kind = sa.sessionInfo(B.identity.nodeIdHex).sessions.find((x) => x.sending).initPending ? 2 : 1;
    await out.link.send(W.toData(sa.send(B.identity.nodeIdHex, W.padContent(randomBytes(n, `r${n}`), kind), deps)));
    await delay(50);
  }
  await waitFor(() => got.length === SIZES.length);
  const dataRecords = records.filter((l) => l > 64);
  ok(JSON.stringify(got) === JSON.stringify(SIZES) && dataRecords.length === SIZES.length && dataRecords.every((l) => [272, 1040, 4112].includes(l)),
    `relayed: ${dataRecords.length} records carrying the messages, sizes ${[...new Set(dataRecords)].join(' / ')} — only 272 / 1040 / 4112; all ${got.length} decrypt at B`);
  for (const n of [A, B, relay]) n.close();
}

// ── 6. factory: refuse to start ───────────────────────────────────────────
console.log('\n=== 6. a ratchet-capable node with no store and no memory-only mode refuses to START ===');
{
  const network = new MemoryNetwork();
  const m = new GMPNodeManager({ ...base, seedPhrase: 'r7 refuse seed phrase', transport: new MemoryTransport(network), dataDir: dirOf('refuse'), ratchetCapable: true });
  let err = null; try { await m.start(); } catch (e) { err = e; }
  ok(err?.name === 'RatchetStoreRequiredError' && !m.node, `start() refuses (${err?.name}); no node is left running`);
  const ok2 = new GMPNodeManager({ ...base, seedPhrase: 'r7 refuse seed phrase 2', transport: new MemoryTransport(network), dataDir: dirOf('refuse-ok'), ratchetCapable: true, ratchets: { memoryOnly: 'test: explicit' } });
  const started = await ok2.start();
  ok(!!started.nodeId && ok2.ratchetStatus().mode === 'memory-only', 'control: the same node with an explicit memory-only spec starts');
  await ok2.stop();
  const { electronManagerOptions } = await import('../dist/entry-points.js');
  const eo = electronManagerOptions({ seedPhrase: 'x' });
  ok(eo.ratchetCapable === true && !('ratchets' in eo), 'the Electron entry point is ratchet-capable, so main.js must supply ratchets');
}

// ── 6b. the unacknowledged-cap WARN: once per contact, not per message ────
console.log('\n=== 6b. the unacknowledged-list cap logs once per contact; every drop is still an event ===');
{
  const { x25519 } = await import('@noble/curves/ed25519');
  const { sha512 } = await import('@noble/hashes/sha512');
  const id = (l) => { const priv = new Uint8Array(crypto.createHash('sha256').update(`r7 cap ${l}`).digest()); const pub = x25519.getPublicKey(priv); return { staticPrivKey: priv, staticPubKey: pub, nodeIdHex: Buffer.from(sha512(pub)).toString('hex') }; };
  const me = id('me'), p1 = id('p1'), p2 = id('p2');
  const drops = [];
  const st = S.memoryOnlyRatchetStore('test: cap', { identity: me, on: { 'ratchet-unacknowledged-dropped': (i) => drops.push(i) } });
  const deps = { rng: (k) => new Uint8Array(crypto.randomBytes(k)), now: () => Date.now() };
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => { const t = a.join(' '); if (t.includes('"event":"ratchet-unacknowledged-dropped"')) lines.push(JSON.parse(t)); else orig(...a); };
  try {
    for (const p of [p1, p2]) {
      st.initiate(p.nodeIdHex, { peerStaticPub: p.staticPubKey }, deps);
      for (let i = 0; i < S.MAX_UNACKED + 4; i++) st.send(p.nodeIdHex, new Uint8Array(4), deps);      // no receipts at all
    }
  } finally { console.warn = orig; }
  const perPeer = (p) => drops.filter((d) => d.peer === p.nodeIdHex).length;
  ok(perPeer(p1) === 4 && perPeer(p2) === 4, `${drops.length} drop events: 4 per contact, one per message that left the list`);
  ok(lines.length === 2 && lines.every((l) => l.level === 'WARN') && new Set(lines.map((l) => l.meta.peerPrefix)).size === 2,
    `${lines.length} WARN lines for 2 contacts × 4 drops: once per contact, not per message`);
}

// ── 7. no sealPayload on the ratchet path ─────────────────────────────────
console.log('\n=== 7. the ratchet send path never touches the old sealPayload path ===');
{
  const bridgeSrc = fs.readFileSync(path.join(pkg, 'src', 'gmp-bridge.ts'), 'utf8');
  const mgrSrc = fs.readFileSync(path.join(pkg, 'src', 'gmp-node-manager.ts'), 'utf8');
  const block = (src, start, end) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, src.indexOf(end, i + start.length)); };
  const paths = [block(bridgeSrc, "case 'ratchet-send'", 'break;'), block(mgrSrc, 'async ratchetSend(', '\n  }\n'), block(mgrSrc, 'private _onRatchetData(', '\n  }\n')];
  const legacy = /sealPayload|encryptWithPublicKey|sendMessage\(|sendDirect\(|storeForwardSend|_sf\b|_getOrConnect/;
  assertAbsent({
    channel: 'the legacy sealPayload / string send / mailbox calls on the ratchet path (bridge ratchet-send, ratchetSend, _onRatchetData)',
    controlMessage: 'the matcher finds a planted sealPayload( call',
    control: () => legacy.test('const blob = sealPayload(peerKey, text);'),
    absent: () => paths.every((p) => p.length > 100) && paths.every((p) => !legacy.test(p)),
    message: `none in ${paths.map((p) => p.length).join(' + ')} characters of the ratchet path`,
  });
}

done();
