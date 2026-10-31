/**
 * File transfer under pressure (task FT1): memory, sender reads, and the same
 * scenarios over two wires.
 *
 *   memory   16 transfers from 8 peers, every chunk streamed, none finished:
 *            the receiver holds no more than its byte quota (RSS measured in a
 *            child process, like X1).
 *   sender   a 64 MiB file is read slice by slice with a bounded window (RSS and
 *            in-flight chunks measured); a receiver that stops acknowledging stops
 *            the sender within one window.
 *   wires    each scenario runs over the fake wire and over the GMP bridge path:
 *              - one peer's 16 never-finished transfers do not block another peer
 *              - "sent" only after the receiver's complete ack
 *              - a disconnect mid-transfer frees the receiver's slot and fails the sender
 *            The GMP path is real gmp-core (GMPNodeManager, memory transport, GMP
 *            DATA over authenticated links) and the real renderer connector
 *            (GMPBridgeConnector, extracted from index.html). The bridge glue in
 *            between is restated from gmp-bridge.ts: 'send' -> manager.sendMessage
 *            (:415-422); manager 'message' / 'peer-connected' / 'peer-disconnected'
 *            -> published to the renderer (:292-301).
 *
 * Run: node test/file-transfer-harness.test.mjs
 */
import '../gmp-core/test/helpers/isolate-data.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { webcrypto, randomBytes } from 'crypto';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out: ${what}`); })]);

// ── Renderer pieces, from the shipped files ───────────────────────────────
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ci = html.indexOf('  async encryptWithPublicKey(plaintext, pubKeyHex) {');
const cj = html.indexOf('\n};\nwindow.CryptoEngine = CryptoEngine;', ci);
const CryptoEngine = vm.runInNewContext(`({ ${html.slice(ci, cj)} })`, { crypto: webcrypto, TextEncoder, TextDecoder });
globalThis.window = globalThis;
require('../src/p2p/file-transfer.js');
const { FileTransfer } = globalThis;

async function identity() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  return { keyPair, publicKeyHex: hex(await webcrypto.subtle.exportKey('raw', keyPair.publicKey)) };
}
const header = (pub, size, keyHex) => CryptoEngine.encryptWithPublicKey(
  JSON.stringify({ key: keyHex, meta: { name: 'f.bin', size, type: '', totalChunks: Math.ceil(size / CHUNK) } }), pub);
async function chunkFrame(aesKey, transferId, chunkIndex, bytes) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${transferId}:${chunkIndex}`) }, aesKey, bytes);
  return { type: 'file-chunk', transferId, chunkIndex, iv: hex(iv), data: hex(new Uint8Array(ct)) };
}
const rssMiB = () => process.memoryUsage().rss / MiB;
/** Memory still reachable after a full GC: JS heap plus buffers. RSS also keeps the allocator's high-water mark. */
const liveMiB = () => { global.gc(); const m = process.memoryUsage(); return (m.heapUsed + m.external) / MiB; };

// ── Child: receiver memory ────────────────────────────────────────────────
if (process.argv[2] === '--child=memory') {
  const QUOTA = 16 * MiB;
  const id = await identity();
  const logs = [];
  const B = new FileTransfer({ on: () => {}, sendOnChannel: async () => true }, CryptoEngine,
    { getPrivateKey: () => id.keyPair.privateKey, getPeerPublicKey: () => null },
    { limits: { maxFileBytes: QUOTA / 2, maxIncomingBytesPerPeer: QUOTA / 2, maxIncomingBytes: QUOTA, idleTimeoutMs: 600000, firstChunkTimeoutMs: 600000 }, log: { warn: (e, d) => logs.push({ e, ...d }) } });
  const keyHex = 'ab'.repeat(32);
  const aesKey = await webcrypto.subtle.importKey('raw', Buffer.from(keyHex, 'hex'), 'AES-GCM', false, ['encrypt']);
  const SIZE = 4 * MiB, CHUNKS = SIZE / CHUNK;
  const transfers = [];
  for (let p = 0; p < 8; p++) for (let t = 0; t < 2; t++) transfers.push({ peer: `p${p}`, id: `t${t}` });
  for (const x of transfers) await B._handleFileChunk(x.peer, { type: 'file-meta', transferId: x.id, sealed: await header(id.publicKeyHex, SIZE, keyHex) });
  await sleep(10);
  const live0 = liveMiB(); const rss0 = rssMiB();
  const plain = webcrypto.getRandomValues(new Uint8Array(CHUNK));
  let peak = rss0, livePeak = live0;
  for (let c = 0; c < CHUNKS; c++) {
    for (const x of transfers) await B._handleFileChunk(x.peer, await chunkFrame(aesKey, x.id, c, plain));
    if (c % 16 === 15) { livePeak = Math.max(livePeak, liveMiB()); peak = Math.max(peak, rssMiB()); }
  }
  livePeak = Math.max(livePeak, liveMiB()); peak = Math.max(peak, rssMiB());
  const held = [...B._transfers.values()].reduce((s, st) => s + st.receivedBytes, 0);
  console.log(JSON.stringify({ streamedMiB: transfers.length * SIZE / MiB, quotaMiB: QUOTA / MiB, open: B._transfers.size, heldMiB: held / MiB,
    liveGrowthMiB: +(livePeak - live0).toFixed(1), rssGrowthMiB: +(peak - rss0).toFixed(1), refusalsLogged: logs.filter((l) => l.e.includes('refused')).length }));
  process.exit(0);
}

// ── Child: sender memory and window ───────────────────────────────────────
if (process.argv[2] === '--child=sender') {
  const stopAckingAfter = Number(process.argv[3] || Infinity);
  const SIZE = 64 * MiB, TOTAL = SIZE / CHUNK;
  const reads = { slice: 0, whole: 0 };
  const lazyFile = { name: 'big.bin', type: '', size: SIZE,
    slice: (a, b) => { reads.slice++; return { arrayBuffer: async () => new ArrayBuffer(Math.min(SIZE, b) - a) }; },
    arrayBuffer: async () => { reads.whole++; return new ArrayBuffer(SIZE); } };
  const rcv = await identity();
  let sent = 0, acked = 0, maxInFlight = 0, listener = null, livePeak = 0;
  const deliver = (frame) => setImmediate(() => listener && listener('R', frame));
  // A receiver that speaks v2 and keeps nothing: acks only.
  const pm = {
    on: (ev, fn) => { if (ev === 'file-chunk') listener = fn; },
    sendOnChannel: async (to, ch, f) => {
      if (f.type === 'file-meta') deliver({ type: 'file-ack', transferId: f.transferId, stage: 'accepted', v: 2 });
      else if (f.type === 'file-chunk') {
        sent++;
        if (sent % 64 === 0) livePeak = Math.max(livePeak, liveMiB());
        maxInFlight = Math.max(maxInFlight, sent - acked);
        if ((sent % 8 === 0 || sent === TOTAL) && sent <= stopAckingAfter) { acked = sent; deliver({ type: 'file-ack', transferId: f.transferId, stage: 'progress', received: sent }); }
      } else if (f.type === 'file-done' && sent <= stopAckingAfter) deliver({ type: 'file-ack', transferId: f.transferId, stage: 'complete' });
      return true;
    },
  };
  const A = new FileTransfer(pm, CryptoEngine, { getPeerPublicKey: () => rcv.publicKeyHex }, { limits: { ackTimeoutMs: 500 }, log: { warn: () => {} } });
  const live0 = liveMiB(); livePeak = live0; const rss0 = rssMiB(); let peak = rss0;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMiB()); }, 5);
  let outcome;
  try { await A.sendFile('R', lazyFile); outcome = 'sent'; } catch (e) { outcome = `failed: ${e.message}`; }
  clearInterval(sampler); peak = Math.max(peak, rssMiB());
  console.log(JSON.stringify({ fileMiB: SIZE / MiB, outcome, chunksSent: sent, totalChunks: TOTAL, maxInFlight, reads, livePeakGrowthMiB: +(livePeak - live0).toFixed(1), rssPeakGrowthMiB: +(peak - rss0).toFixed(1) }));
  process.exit(0);
}

// ── Parent ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const child = (...args) => {
  const r = spawnSync(process.execPath, ['--expose-gc', self, ...args], { encoding: 'utf8', timeout: 240000 });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { error: (r.stderr || r.stdout || '').slice(-600) }; }
};

console.log('\n=== memory: 16 never-finished transfers from 8 peers, every chunk streamed ===');
{
  const m = child('--child=memory');
  console.log(`  ${JSON.stringify(m)}`);
  ok(m.streamedMiB === 64, `control: ${m.streamedMiB} MiB were streamed at the receiver`);
  ok(m.heldMiB <= m.quotaMiB, `the receiver holds ${m.heldMiB} MiB, within its ${m.quotaMiB} MiB quota`);
  ok(m.liveGrowthMiB <= m.quotaMiB * 1.5, `live memory after GC grew ${m.liveGrowthMiB} MiB: the ${m.quotaMiB} MiB quota plus per-chunk overhead (RSS, which keeps the allocator's high-water mark, grew ${m.rssGrowthMiB} MiB)`);
  ok(m.refusalsLogged > 0, `headers beyond the quota were refused and logged (${m.refusalsLogged})`);
}

console.log('\n=== sender: a 64 MiB file, read slice by slice, bounded window ===');
{
  const s = child('--child=sender');
  console.log(`  ${JSON.stringify(s)}`);
  ok(s.outcome === 'sent' && s.chunksSent === s.totalChunks, `control: the whole file went out and was confirmed (${s.outcome}, ${s.chunksSent}/${s.totalChunks})`);
  ok(s.reads && s.reads.whole === 0 && s.reads.slice === s.totalChunks, `read with ${s.reads && s.reads.slice} slices and ${s.reads && s.reads.whole} whole-file reads`);
  ok(s.maxInFlight <= 32, `never more than 32 unacknowledged chunks in flight (max ${s.maxInFlight})`);
  ok(s.livePeakGrowthMiB < 16, `live memory after GC peaked ${s.livePeakGrowthMiB} MiB above the start, well under the file's ${s.fileMiB} MiB (RSS peak growth ${s.rssPeakGrowthMiB} MiB)`);
  const st = child('--child=sender', '16');
  console.log(`  ${JSON.stringify(st)}`);
  ok(st.chunksSent <= 16 + 32 && /failed/.test(st.outcome), `a receiver that stops acknowledging after 16 chunks stops the sender within one window (${st.chunksSent} sent, ${st.outcome})`);
}

// ── Two wires ─────────────────────────────────────────────────────────────
/** Fake wire: three endpoints on one hub. drop(frame, from, to) loses a frame. */
async function fakeNet() {
  const pms = {};
  let drop = null;
  const cut = new Set(); // 'X>Y' pairs whose link is down
  for (const name of ['B', 'A', 'M']) {
    const listeners = {};
    pms[name] = {
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      emit: (ev, ...a) => (listeners[ev] || []).forEach((fn) => fn(...a)),
      sendOnChannel: async (to, ch, obj) => {
        const copy = JSON.parse(JSON.stringify(obj));
        if (cut.has(`${name}>${to}`)) return false;
        if (drop && drop(copy, name, to)) return true;
        setImmediate(() => pms[to].emit('file-chunk', name, copy));
        return true;
      },
    };
  }
  return {
    label: 'fake wire', ids: { B: 'B', A: 'A', M: 'M' }, pms,
    setDrop: (fn) => { drop = fn; },
    disconnect: (x, y) => { cut.add(`${x}>${y}`); cut.add(`${y}>${x}`); pms[x].emit('peer-disconnected', y); pms[y].emit('peer-disconnected', x); },
    reconnect: async (x, y) => { cut.delete(`${x}>${y}`); cut.delete(`${y}>${x}`); },
    stop: async () => {},
  };
}

/** GMP bridge path: three GMPNodeManagers, each with a renderer connector. */
async function gmpNet() {
  const { GMPNodeManager } = await import(path.join(root, 'gmp-core', 'dist', 'gmp-node-manager.js'));
  const { MemoryNetwork, MemoryTransport } = await import(path.join(root, 'gmp-core', 'dist', 'transport', 'memory-transport.js'));
  function extract(name) {
    const m = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm').exec(html);
    if (!m) throw new Error(`index.html no longer declares: ${name}`);
    const first = html.slice(m.index, html.indexOf('\n', m.index));
    if (/^const [^\n]*;\s*(\/\/.*)?$/.test(first)) return first;
    const close = html.indexOf('\n}', m.index);
    return html.slice(m.index, close + (html[close + 2] === ';' ? 3 : 2));
  }
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
  globalThis.location = { protocol: 'http:', search: '', hostname: 'localhost', host: 'localhost:3001', pathname: '/' };
  const sockets = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.route = null; sockets.push(this); }
    send(d) { const msg = JSON.parse(d); if (this.route) this.route(msg); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    deliver(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
  }
  const NAMES = ['SecretStore', 'PeerCache', 'GHOST_ADDRESS_ALPHABET', 'GHOST_ADDRESS_LENGTH', 'GHOST_ADDRESS_PATTERN', 'NODE_ID_PATTERN',
    'ghostAddressFromNodeId', 'normalizeGhostAddress', 'isGhostAddress', 'isNodeIdHex', 'KNOWN_PEERS_KEY', 'BLOCKED_PEERS_KEY',
    'KNOWN_PEERS_MAX', 'loadBlockedPeers', 'setPeerBlocked', 'loadKnownPeers', 'rememberKnownPeer', 'forgetKnownPeer',
    'getGmpPort', 'isTrustedBridgeTarget', 'getBridgeWsUrl', 'openBridgeSocket', 'MESH_TRANSPORT_LABELS', 'meshModeLabel', 'GMPBridgeConnector'];
  const lib = new Function('WebSocket', 'window', 'localStorage', `${NAMES.map(extract).join('\n\n')}\nreturn { GMPBridgeConnector };`)(FakeWebSocket, globalThis, localStorage);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ft1-'));
  const network = new MemoryNetwork();
  const base = { disableBootstrap: true, GMP_LAN_DISCOVERY: false, storeForward: false, GMP_METRICS_PORT: 0, GMP_PORT: 0 };
  const managers = {}, pms = {}, ids = {};
  let drop = null;
  for (const name of ['B', 'A', 'M']) {
    const m = new GMPNodeManager({ ...base, seedPhrase: `ft1 file transfer ${name}`, transport: new MemoryTransport(network), dataDir: path.join(tmp, name) });
    const started = await m.start();
    managers[name] = m; ids[name] = m.getNodeId(); m.port = started.port;
    const conn = new lib.GMPBridgeConnector({ name });
    const opened = conn.connect();
    const ws = sockets[sockets.length - 1];
    ws.route = (msg) => {
      // gmp-bridge.ts:415-422
      if (msg.type === 'send' || msg.type === 'sendDirect') {
        if (drop && drop(JSON.parse(msg.payload), name, msg.destinationNodeId)) return;
        m.sendMessage(String(msg.destinationNodeId), String(msg.payload))
          .catch((err) => ws.deliver({ type: 'error', code: err.name || 'SEND_FAILED', message: err.message }));
      }
    };
    ws.open(); await opened;
    ws.deliver({ type: 'started', nodeId: ids[name] });
    // gmp-bridge.ts:292-301
    m.on('peer-connected', ({ nodeId, address, port, transport }) => ws.deliver({ type: 'peer-connected', nodeId, address, port, transport }));
    m.on('peer-disconnected', ({ nodeId }) => ws.deliver({ type: 'peer-disconnected', nodeId }));
    m.on('message', ({ fromNodeId, payload, via }) => ws.deliver({ type: 'message', fromNodeId, payload, ...(via ? { via } : {}) }));
    pms[name] = conn;
  }
  await managers.A.connectToPeer('memory', managers.B.port);
  await managers.M.connectToPeer('memory', managers.B.port);
  await sleep(300);
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return {
    label: 'GMP bridge path', ids, pms,
    setDrop: (fn) => { drop = fn ? (f, from, toId) => fn(f, from, byId[toId]) : null; },
    disconnect: (x, y) => { const link = managers[x].node.getLinkByNodeId(ids[y]); if (link) link.destroy(new Error('FT1 test: disconnect')); },
    reconnect: async (x, y) => { if (!managers[x].node.getLinkByNodeId(ids[y])) await managers[x].connectToPeer('memory', managers[y].port); await sleep(300); },
    stop: async () => { for (const m of Object.values(managers)) await m.stop(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

async function scenarios(net) {
  console.log(`\n=== ${net.label} ===`);
  const keys = {};
  for (const n of ['B', 'A', 'M']) keys[n] = await identity();
  const pubOf = Object.fromEntries(Object.entries(net.ids).map(([n, id]) => [id, keys[n].publicKeyHex]));
  const logsB = [];
  const ft = {};
  const limits = { ackTimeoutMs: 1500 };
  for (const n of ['B', 'A']) {
    ft[n] = new FileTransfer(net.pms[n], CryptoEngine, { getPeerPublicKey: (p) => pubOf[p], getPrivateKey: () => keys[n].keyPair.privateKey },
      { limits, log: { warn: (e, d) => { if (n === 'B') logsB.push({ e, ...d }); } } });
  }
  const B = net.ids.B, A = net.ids.A, M = net.ids.M;
  const fromM = (k) => [...ft.B._transfers.keys()].filter((key) => key.startsWith(M + '\n')).length;
  const mGot = [];
  net.pms.M.on('file-chunk', (from, f) => mGot.push(f));
  const blob = (n) => { const b = new Uint8Array(randomBytes(n)); return { name: 'x.bin', type: '', size: n, slice: (a, z) => new Blob([b.slice(a, z)]), arrayBuffer: async () => b.buffer.slice(0) }; };

  // 1. "sent" only after the receiver's complete ack.
  {
    net.setDrop((f, from) => from === 'B' && f.type === 'file-ack');
    let sentEvent = false, outcome = null;
    const onSent = () => { sentEvent = true; };
    ft.A.on('sent', onSent);
    try { await within(ft.A.sendFile(B, blob(10 * 1024)), 8000, 'send with acks lost'); outcome = 'resolved'; } catch (e) { outcome = e.message; }
    net.setDrop(null);
    ok(!sentEvent && outcome !== 'resolved', `with the receiver's acks lost, nothing says "sent" (${outcome})`);
    const events = [];
    ft.B.on('complete', ({ transferId }) => events.push(['receiver-complete', transferId]));
    ft.A.on('status', (s) => { if (s.status === 'sent') events.push(['sender-sent', s.transferId]); });
    const tid = await within(ft.A.sendFile(B, blob(150 * 1024)), 8000, 'control send');
    await sleep(50);
    const order = events.filter(([, t]) => t === tid).map(([e]) => e).join(',');
    ok(order === 'receiver-complete,sender-sent', `control: delivered, "sent" follows the receiver's completion (${order})`);
  }
  // 2. Disconnect mid-transfer.
  {
    let disconnected = false, outcome = null;
    const onProgress = ({ peerId }) => { if (!disconnected && peerId === A) { disconnected = true; net.disconnect('A', 'B'); } };
    ft.B.on('progress', onProgress);
    try { await within(ft.A.sendFile(B, blob(4 * MiB)), 10000, 'send across a disconnect'); outcome = 'resolved'; } catch (e) { outcome = e.message; }
    await sleep(300);
    const aliceOpen = [...ft.B._transfers.keys()].filter((k) => k.startsWith(A + '\n')).length;
    ok(disconnected, 'control: the link went down mid-transfer');
    ok(aliceOpen === 0, `the receiver freed the disconnected sender's slot (${aliceOpen} open)`);
    ok(outcome !== 'resolved', `the sender reports a failure, not "sent" (${outcome})`);
    ft.B.off('progress', onProgress);
    await net.reconnect('A', 'B');
  }  // 3. One peer's 16 never-finished transfers (last: the old receiver never frees them).
  {
    const keyHex = 'ab'.repeat(32);
    for (let i = 0; i < 16; i++) await net.pms.M.sendOnChannel(B, 'files', { type: 'file-meta', transferId: `m${i}`, sealed: await header(keys.B.publicKeyHex, 8 * CHUNK, keyHex) });
    await sleep(800);
    const open = fromM();
    ok(open >= 1, `control: mallory's headers reach the receiver over the ${net.label} (${open} open)`);
    let got = null, arrived = false;
    ft.B.on('complete', ({ peerId }) => { if (peerId === A) arrived = true; });
    try { await within(ft.A.sendFile(B, blob(100 * 1024)), 8000, 'alice\'s file'); got = 'sent'; } catch (e) { got = e.message; }
    await sleep(100);
    ok(arrived, `alice's file arrives at the receiver while mallory holds her transfers (sender: ${got})`);
    ok(open === 2, `mallory is held to the per-peer cap (${open} open of her 16)`);
    const refusals = mGot.filter((f) => f.type === 'file-refused').length;
    ok(refusals === 14 && logsB.filter((l) => l.e.includes('refused') && l.peerId === M).length === 14, `mallory was told about each of the 14 refusals (${refusals}) and each was logged`);
  }
}

for (const make of [fakeNet, gmpNet]) {
  let net = null;
  try { net = await make(); await scenarios(net); } catch (e) { fail++; console.error(`  ✗ ${make.name}: ${e.stack}`); }
  if (net) await net.stop();
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
