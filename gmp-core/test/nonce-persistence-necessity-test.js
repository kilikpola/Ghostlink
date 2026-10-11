/**
 * Does the session-key claim need to be persisted? The same recorded session
 * is replayed against a responder in two modes:
 *
 *   P  persisted claims (the strict NonceStore on disk)
 *   M  in-memory claims only
 *
 * through three scenarios:
 *
 *   1. replay, RNG healthy
 *   2. replay, RNG repeats, same process
 *   3. replay, RNG repeats, after a restart
 *
 * recording whether replayed DATA is dispatched again and whether the
 * responder re-encrypts under a used (key, nonce).
 *
 * Run: node test/nonce-persistence-necessity-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GMPLink } from '../dist/link/link.js';
import { MemoryConnection } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase, generateEphemeralKeyPair } from '../dist/identity.js';
import { NonceStore, deriveNonceStoreKey } from '../dist/nonce-store.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-m21-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const SEED_B = 'm2-1 responder seed phrase';
const openPersisted = () => {
  const s = new NonceStore({ stateFile: path.join(tmp, 'nonce-state.json'), claimsFile: path.join(tmp, 'nonce-claims.log'), strictState: true });
  s.setEncryptionKey(deriveNonceStoreKey(SEED_B));
  return s.load();
};

/** Mode M: claims held in memory for the life of the process, nothing on disk. */
class InMemoryClaims {
  claims = new Set();
  claimSessionKey(_peer, fp) {
    if (this.claims.has(fp)) return { valid: false, reason: 'session key already claimed (in memory)' };
    this.claims.add(fp);
    return { valid: true };
  }
  updateCounters() {}
}

/** A responder link on a fresh connection, every byte it writes recorded. */
function responder(identity, store, ephemeralKeyPair) {
  const [clientConn, serverConn] = MemoryConnection.createPair(5000 + Math.floor(Math.random() * 1000), 6000);
  const out = [];
  const w = serverConn.write.bind(serverConn);
  serverConn.write = (d, cb) => { out.push(Buffer.from(d)); return w(d, cb); };
  const link = new GMPLink({ identity, socket: serverConn, isInitiator: false, ephemeralKeyPair, nonceStore: store, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null });
  const delivered = [];
  const errors = [];
  link.on('message', (m) => delivered.push(m));
  link.on('error', (e) => errors.push(e.message));
  return { link, clientConn, out, delivered, errors };
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  M2-1 — Is a persisted session-key claim necessary?        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  const A = await deriveIdentityFromSeedPhrase('m2-1 initiator seed phrase');
  const B = await deriveIdentityFromSeedPhrase(SEED_B);

  // The original session, recorded. The responder's ephemeral E is kept so a
  // later "RNG repeat" can reuse it exactly.
  const E = generateEphemeralKeyPair();
  const persistedOriginal = openPersisted();
  const memoryOriginal = new InMemoryClaims();
  const originals = {};
  const recorded = {};
  for (const [mode, store] of [['P', persistedOriginal], ['M', memoryOriginal]]) {
    const r = responder(B, store, E);
    const init = new GMPLink({ identity: A, socket: r.clientConn, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(), nonceStore: null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null });
    const sent = [];
    const w = r.clientConn.write.bind(r.clientConn);
    r.clientConn.write = (d, cb) => { sent.push(Buffer.from(d)); return w(d, cb); };
    await init._sendHELLO();
    await delay(40);
    await init.send('pay 100 to carol');
    await delay(40);
    originals[mode] = { ack: r.out.find((f) => f[4] === 0x02), delivered: r.delivered.slice() };
    recorded[mode] = sent;
    init.destroy();
    r.link.destroy();
    await delay(20);
  }
  assert(originals.P.delivered[0] === 'pay 100 to carol' && originals.M.delivered[0] === 'pay 100 to carol', 'original session delivered once in both modes');
  assert(recorded.P.map((f) => f[4]).join() === '1,4,3', `recorded the initiator's HELLO, key-confirmation PING and DATA (${recorded.P.map((f) => '0x0' + f[4]).join(' ')})`);

  /** Replay the recorded initiator frames against a responder with this store and ephemeral. */
  async function replay(mode, store, ephemeral) {
    const r = responder(B, store, ephemeral);
    for (const f of recorded[mode]) { r.clientConn.write(f); await delay(20); }
    await delay(30);
    const ack = r.out.find((f) => f[4] === 0x02);
    const reusedNonce = !!ack && ack.subarray(5, 5 + 216).equals(originals[mode].ack.subarray(5, 5 + 216)) === false
      ? ack.subarray(5 + 168, 5 + 216).equals(originals[mode].ack.subarray(5 + 168, 5 + 216)) : false;
    r.link.destroy();
    await delay(10);
    return { delivered: r.delivered.length, reusedNonce, errors: r.errors };
  }

  const table = [];
  const row = (scenario, mode, res) => table.push({ scenario, mode, replayed: res.delivered, reuse: res.reusedNonce, why: res.errors[0] || '' });

  console.log('\n=== 1. replay, RNG healthy (fresh responder ephemeral) ===');
  const p1 = await replay('P', persistedOriginal, generateEphemeralKeyPair());
  const m1 = await replay('M', memoryOriginal, generateEphemeralKeyPair());
  row('1 healthy RNG', 'P persisted', p1); row('1 healthy RNG', 'M in-memory', m1);
  assert(p1.delivered === 0 && m1.delivered === 0, `both refuse: the recorded PING does not open under the new key (P: ${p1.errors[0]}; M: ${m1.errors[0]})`);
  assert(!p1.reusedNonce && !m1.reusedNonce, 'no (key, nonce) is reused in either mode');

  console.log('\n=== 2. replay, RNG repeats the ephemeral, same process ===');
  const p2 = await replay('P', persistedOriginal, E);
  const m2 = await replay('M', memoryOriginal, E);
  row('2 RNG repeat, same process', 'P persisted', p2); row('2 RNG repeat, same process', 'M in-memory', m2);
  assert(p2.delivered === 0 && m2.delivered === 0, `both refuse the replayed DATA before dispatch: the repeated key's claim is still held (P: ${p2.errors[0]}; M: ${m2.errors[0]})`);

  console.log('\n=== 3. replay, RNG repeats the ephemeral, after a restart ===');
  persistedOriginal.close();
  const p3 = await replay('P', openPersisted(), E);           // re-opened from disk
  const m3 = await replay('M', new InMemoryClaims(), E);      // memory is gone
  row('3 RNG repeat, after restart', 'P persisted', p3); row('3 RNG repeat, after restart', 'M in-memory', m3);
  assert(p3.delivered === 0, `persisted: the claim survives the restart and the replay is refused before dispatch (${p3.errors[0]})`);
  assert(m3.delivered === 1, `in-memory: the replayed "pay 100 to carol" is accepted and dispatched AGAIN (${m3.delivered})`);
  assert(m3.reusedNonce, 'in-memory: the responder re-sent a HELLO_ACK proof under the same (key, nonce) as the original session — AES-GCM nonce reuse');

  console.log('\n  scenario                      | mode         | replayed DATA dispatched | (key, nonce) reused | refused because');
  for (const t of table) console.log(`  ${t.scenario.padEnd(29)} | ${t.mode.padEnd(12)} | ${String(t.replayed).padStart(24)} | ${String(t.reuse).padStart(19)} | ${t.why}`);
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
