/**
 * Nonce-reuse regression witness: fails loudly if the boot counter is removed
 * from ephemeral derivation, by producing the actual damage.
 *
 * A host answers a hop session with a reply whose plaintext varies between
 * runs. With a repeating RNG and a replayed recorded session, the same session
 * key is derived and the reply is re-sealed under the same (key, nonce):
 *
 *     C1 ^ C2 == P1 ^ P2        (AES-GCM is CTR mode: C = P ^ keystream)
 *
 * A: RNG pinned to 0x07 and the host's ephemeral source bypassed (harness
 * only). B: the same against the production source.
 *
 *   relay host    RELAY_RESERVATION (plaintext varies: the voucher's expiry)
 *   storage host  FETCH_RESPONSE    (plaintext varies: a new blob arrived)
 *
 * Run: node test/nonce-reuse-witness-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import nodeCrypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createGMPNode } from '../dist/node-factory.js';
import { DEFAULTS } from '../dist/config.js';
import { generateEphemeralKeyPair, generateEphemeralIdentity } from '../dist/identity.js';
import { MESSAGETYPES, FRAME_HEADER_LEN } from '../dist/link/frame.js';
import { openFramePayload, AUTH_TAG_LEN } from '../dist/link/session.js';
import { RelayHop } from '../dist/relay/relay-client.js';
import { StorageSession } from '../dist/storage/storage-client.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { EphemeralKeySource } from '../dist/link/ephemeral-source.js';

// Client sessions get sources with distinct boot values AND a shared sequence,
// so the CLIENT side never repeats even if the counter under test is broken:
// the witness isolates the HOST's ephemeral, which is what §6 is about.
let clientBoot = 0x5157_0000n;
const withSource = () => ({ ephemeralSource: new EphemeralKeySource(clientBoot++) });

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-witness-'));

// ── A broken RNG: every source of randomness returns the same bytes ─────────
const realGRV = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const realRB = nodeCrypto.randomBytes;
function pinRng() {
  globalThis.crypto.getRandomValues = (arr) => { new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).fill(0x07); return arr; };
  nodeCrypto.randomBytes = (n, cb) => { const b = Buffer.alloc(n, 0x07); if (cb) { cb(null, b); return undefined; } return b; };
}
function unpinRng() {
  globalThis.crypto.getRandomValues = realGRV;
  nodeCrypto.randomBytes = realRB;
}

/** HARNESS ONLY: the pre-M3-2' ephemeral path — bare RNG, no counter. */
function bypassCounter(node) {
  node.ephemeralSource = { next: () => generateEphemeralKeyPair(), nextIdentity: () => generateEphemeralIdentity(), boot: 0n, produced: 0n };
}

/** A transport whose connections record every byte both ways. */
function tapped(network, log) {
  const inner = new MemoryTransport(network);
  return {
    dial: async (opts) => {
      const conn = await inner.dial(opts);
      return new Proxy(conn, {
        get(target, prop) {
          if (prop === 'write') return (data, cb) => { log.push({ dir: 'c2s', bytes: Buffer.from(data) }); return target.write(data, cb); };
          if (prop === 'on') return (ev, h) => target.on(ev, ev === 'data' ? (d) => { log.push({ dir: 's2c', bytes: Buffer.from(d) }); h(d); } : h);
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
    listen: (...a) => inner.listen(...a),
    adopt: (...a) => inner.adopt(...a),
    close: () => inner.close(),
  };
}

/** Replay recorded client bytes to a host, chunk by chunk; return what it sent back. */
async function replay(network, port, log) {
  const conn = await new MemoryTransport(network).dial({ port });
  const back = [];
  conn.on('data', (d) => back.push(Buffer.from(d)));
  conn.on('error', () => {});
  for (const e of log) if (e.dir === 'c2s') { conn.write(e.bytes); await delay(60); }
  await delay(300);
  conn.destroy?.();
  return Buffer.concat(back);
}

function frames(stream) {
  const out = [];
  for (let o = 0; o + FRAME_HEADER_LEN <= stream.length;) {
    const len = stream.readUInt32BE(o);
    if (o + FRAME_HEADER_LEN + len > stream.length) break;
    out.push({ header: stream.subarray(o, o + FRAME_HEADER_LEN), type: stream[o + 4], payload: stream.subarray(o + FRAME_HEADER_LEN, o + FRAME_HEADER_LEN + len) });
    o += FRAME_HEADER_LEN + len;
  }
  return out;
}

/** Open a frame with one of `keys` at whichever counter authenticates; null if none. */
function openAt(keys, frame) {
  for (const key of keys) {
    for (let c = 0; c < 64; c++) {
      try { return { key, counter: c, plaintext: openFramePayload(key, c, frame.type, Buffer.from(frame.payload)) }; } catch { /* next */ }
    }
  }
  return null;
}

function xor(a, b) {
  const n = Math.min(a.length, b.length);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = a[i] ^ b[i];
  return out;
}

const nets = new WeakMap();
const netOf = (node) => nets.get(node);

async function host(name, cfg, network, { bypass }) {
  const n = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false, ...cfg }, dataDir: path.join(tmp, name), port: 0, transport: new MemoryTransport(network) });
  n.on('error', () => {});
  await n.loadIdentity(`nonce reuse witness ${name}`);
  if (bypass) bypassCounter(n);
  await n.listen();
  nets.set(n, network);
  return n;
}

/** Watch a host's links and keep every session send key seen (links leave the map on close). */
function keyWatch(node) {
  const keys = new Map();
  const grab = () => { for (const l of node.links.values()) if (l.sendKey) keys.set(hex(l.sendKey), Buffer.from(l.sendKey)); };
  const t = setInterval(grab, 2);
  return { get: () => { grab(); clearInterval(t); return [...keys.values()]; } };
}

/**
 * Run 1: a genuine client session, recorded; the host's reply captured.
 * Restart the host (same identity, same data dir, RNG still broken).
 * Run 2: the recording replayed; the host's reply captured again.
 */
async function scenario(opts) {
  try {
    return await scenarioInner(opts);
  } catch (e) {
    unpinRng();
    // A witness reports; it does not crash. The run is counted as failed.
    assert(false, `${opts.name}: the scenario itself failed: ${e && e.message}`);
    return { r1: null, r2: null, key1: [], key2: [], crashed: true };
  }
}

async function scenarioInner({ name, cfg, bypass, replyType, client, between }) {
  const network = new MemoryNetwork();
  const log = [];
  pinRng();
  const h1 = await host(name, cfg, network, { bypass });
  let key1 = [];
  try {
    const w1 = keyWatch(h1);
    await client(tapped(network, log), { address: 'memory', port: h1.port }, h1);
    await delay(100);
    key1 = w1.get();
  } finally {
    h1.close();
  }
  await delay(50);
  const h2 = await host(name, cfg, network, { bypass });
  if (between) await between(h2, network);
  const w2 = keyWatch(h2);
  const back = await replay(network, h2.port, log);
  const key2 = w2.get();
  h2.close();
  unpinRng();

  const s2c1 = Buffer.concat(log.filter((e) => e.dir === 's2c').map((e) => e.bytes));
  const r1 = frames(s2c1).find((f) => f.type === replyType);
  const r2 = frames(back).find((f) => f.type === replyType);
  return { r1, r2, key1, key2 };
}

function witness(label, { r1, r2, key1, key2, crashed }) {
  if (crashed) return;
  assert(!!r1, `${label}: run 1 — the host sent its reply (${r1 ? r1.payload.length : 0} bytes)`);
  assert(!!r2, `${label}: run 2 — the replayed session got a SECOND reply from the restarted host`);
  if (!r1 || !r2) return;
  const o1 = openAt(key1, r1);
  const o2 = o1 ? openAt([o1.key], r2) : null;
  assert(!!o1 && key2.some((k) => k.equals(o1.key)), `${label}: the restarted host derived the same session key as run 1 (${o1 ? hex(o1.key).slice(0, 16) : '?'}…)`);
  assert(!!o1 && !!o2 && o1.counter === o2.counter, `${label}: both replies open under that one key at the same counter (${o1?.counter}, ${o2?.counter}) — one (key, nonce), two ciphertexts`);
  if (!o1 || !o2) return;
  const c1 = Buffer.from(r1.payload.subarray(AUTH_TAG_LEN)), c2 = Buffer.from(r2.payload.subarray(AUTH_TAG_LEN));
  const differs = !o1.plaintext.equals(o2.plaintext);
  assert(differs && !c1.equals(c2), `${label}: the plaintexts differ, so the ciphertexts differ`);
  const cx = xor(c1, c2), px = xor(o1.plaintext, o2.plaintext);
  assert(cx.equals(px), `${label}: C1 ^ C2 == P1 ^ P2 over all ${cx.length} bytes — the keystream was reused`);
  const diffAt = [...px].map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  console.log(`    C1[0..32]      ${hex(c1.subarray(0, 32))}`);
  console.log(`    C2[0..32]      ${hex(c2.subarray(0, 32))}`);
  console.log(`    C1^C2 = P1^P2  nonzero at ${diffAt.length} byte(s), e.g. offsets ${diffAt.slice(0, 8).join(', ')}`);
  console.log(`    P1 there       ${JSON.stringify(o1.plaintext.subarray(Math.max(0, diffAt[0] - 12), diffAt[0] + 16).toString('latin1'))}`);
  console.log(`    P2 there       ${JSON.stringify(o2.plaintext.subarray(Math.max(0, diffAt[0] - 12), diffAt[0] + 16).toString('latin1'))}`);
}

function refused(label, { r2, key1, key2, crashed }) {
  if (crashed) return;
  assert(!r2, `${label}: the replayed session got NO reply from the restarted host`);
  const shared = key1.filter((k) => key2.some((k2) => k2.equals(k)));
  assert(key1.length > 0 && shared.length === 0, `${label}: the restarted host derived none of run 1's session keys (${key1.length} in run 1, ${key2.length} in run 2, ${shared.length} shared), so the recorded frames did not authenticate`);
}

// ── Relay: RELAY_RESERVATION ────────────────────────────────────────────────
const relayCfg = { GMP_RELAY_ENABLED: true };
const relayClient = async (transport, addr) => {
  const hop = await RelayHop.open(transport, addr, withSource());
  await hop.reserve();
  await delay(50);
  hop.close();
};

console.log('\n=== relay host, RELAY_RESERVATION ===');
console.log('  A — broken RNG, counter bypassed (the pre-M3-2\' path):');
witness('relay A', await scenario({ name: 'relay-a', cfg: relayCfg, bypass: true, replyType: MESSAGETYPES.RELAY_RESERVATION, client: relayClient }));
console.log('  B — broken RNG, production source (boot counter + sequence):');
refused('relay B', await scenario({ name: 'relay-b', cfg: relayCfg, bypass: false, replyType: MESSAGETYPES.RELAY_RESERVATION, client: relayClient }));

// ── Storage: FETCH_RESPONSE ─────────────────────────────────────────────────
const storageCfg = { GMP_STORAGE_ENABLED: true, GMP_SF_FETCH_BUCKETS: 1 };
const BUCKET = 0;

async function deposit(node, tag) {
  const s = await StorageSession.open(new MemoryTransport(netOf(node)), { address: 'memory', port: node.port }, withSource());
  await s.store(BUCKET, Buffer.alloc(4096, tag));
  s.close();
  await delay(20);
}

const storageScenario = (name, bypass) => scenario({
  name, cfg: storageCfg, bypass, replyType: MESSAGETYPES.FETCH_RESPONSE,
  client: async (transport, addr, h1) => {
    await deposit(h1, 0x41); // a message waiting in the mailbox
    const sess = await StorageSession.open(transport, addr, withSource());
    await sess.fetch([{ bucket: BUCKET, since: 0 }]); // the victim polls it (recorded)
    await delay(50);
    sess.close();
  },
  // Between the runs a new message arrives: the plaintext varies naturally.
  between: async (h2) => deposit(h2, 0x42),
});

console.log('\n=== storage host, FETCH_RESPONSE ===');
console.log('  A — broken RNG, counter bypassed (the pre-M3-2\' path):');
witness('storage A', await storageScenario('storage-a', true));
console.log('  B — broken RNG, production source (boot counter + sequence):');
refused('storage B', await storageScenario('storage-b', false));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
