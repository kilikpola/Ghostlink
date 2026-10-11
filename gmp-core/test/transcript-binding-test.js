/**
 * Handshake transcript binding: can a replayed, varied HELLO make a responder
 * with a repeated ephemeral emit a different ciphertext under the same
 * (key, nonce)?
 *
 * Session key (link/session.ts deriveLinkKeys):
 *   IKM  = X25519(e_I, e_R) || X25519(s_I, s_R)
 *   info = label || hex(N_initiator) || hex(N_responder)
 *
 *  1. every HELLO byte is authenticated before key derivation
 *  2. every HELLO_ACK byte likewise (280 bytes)
 *  3. ephemeral, static key and NodeID change the key; version, signing key,
 *     timestamp and nonce do not, but are all signed
 *  4. the only pre-claim ciphertext is the HELLO_ACK proof, whose plaintext a
 *     replay reproduces byte for byte
 *  5. a replay older than the timestamp window is refused before derivation
 *  6. a replayed RELAY_RESERVE on a never-promoted hop session under a
 *     repeated ephemeral; an in-memory claim set refuses it at the handshake
 *
 * Run: node test/transcript-binding-test.js
 */

import crypto from 'crypto';
import { GMPLink } from '../dist/link/link.js';
import { MemoryConnection } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase, generateEphemeralKeyPair, generateEphemeralIdentity } from '../dist/identity.js';
import { buildHello, parseHello, buildHelloAck, parseHelloAck, verifyHandshakeSignature, HELLO_PAYLOAD_LEN, HELLO_ACK_PAYLOAD_LEN } from '../dist/link/handshake.js';
import { deriveLinkKeys, fingerprintKey, SessionKeyLRUSet, decryptAESGCM } from '../dist/link/session.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  M3-1 — Handshake transcript binding                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  const A = await deriveIdentityFromSeedPhrase('m3-1 initiator');
  const B = await deriveIdentityFromSeedPhrase('m3-1 responder');
  const eA = generateEphemeralKeyPair();
  const eB = generateEphemeralKeyPair();
  const now = Date.now();
  const nonce = crypto.randomBytes(32);

  console.log('\n=== 1-2. every byte is authenticated ===');
  const hello = buildHello(A, eA.ephemeralPub, now, nonce);
  assert(hello.length === HELLO_PAYLOAD_LEN, `HELLO is ${HELLO_PAYLOAD_LEN} bytes`);
  const helloOk = (b) => { const p = parseHello(b); return verifyHandshakeSignature(p.signingPubkey, p.signedPortion, p.signature); };
  let unauth = [];
  for (let i = 0; i < hello.length; i++) { const x = Buffer.from(hello); x[i] ^= 0x01; if (helloOk(x)) unauth.push(i); }
  assert(helloOk(hello) && unauth.length === 0, `flipping any one of the ${hello.length} HELLO bytes fails the signature (${unauth.length} bytes accepted)`);
  const ack = buildHelloAck(B, eB.ephemeralPub, now, crypto.randomBytes(48));
  const ackOk = (b) => { const p = parseHelloAck(b); return verifyHandshakeSignature(p.signingPubkey, p.signedPortion, p.signature); };
  unauth = [];
  for (let i = 0; i < ack.length; i++) { const x = Buffer.from(ack); x[i] ^= 0x01; if (ackOk(x)) unauth.push(i); }
  assert(ack.length === HELLO_ACK_PAYLOAD_LEN && ackOk(ack) && unauth.length === 0, `flipping any one of the ${ack.length} HELLO_ACK bytes fails the signature (${unauth.length} accepted)`);

  console.log('\n=== 3. which HELLO fields are bound into the key ===');
  const keyFrom = (h) => {
    const p = parseHello(h);
    return fingerprintKey(deriveLinkKeys({ isInitiator: false, localEphemeralPriv: eB.ephemeralPriv, remoteEphemeralPub: p.ephemeralPubkey,
      localStaticPriv: B.staticPrivKey, remoteStaticPub: p.staticPubkey, localNodeId: B.nodeId, remoteNodeId: p.nodeId }).sendKey);
  };
  const base = keyFrom(hello);
  const C = await deriveIdentityFromSeedPhrase('m3-1 other initiator');
  // Re-signed variants: what only the holder of the signing key could produce.
  const variants = {
    'ephemeral key': buildHello(A, generateEphemeralKeyPair().ephemeralPub, now, nonce),
    'static key + NodeID (another identity)': buildHello(C, eA.ephemeralPub, now, nonce),
    timestamp: buildHello(A, eA.ephemeralPub, now + 1000, nonce),
    nonce: buildHello(A, eA.ephemeralPub, now, crypto.randomBytes(32)),
  };
  const table = [];
  for (const [field, h] of Object.entries(variants)) table.push({ field, bound: keyFrom(h) !== base, signed: helloOk(h) });
  table.push({ field: 'version', bound: false, signed: true, note: 'must equal 0x01; any other value is refused' });
  table.push({ field: 'signing key', bound: false, signed: true, note: 'NodeID = SHA-512(static or signing key); NodeID is bound' });
  table.push({ field: 'signature', bound: false, signed: false, note: 'the authenticator itself' });
  for (const t of table) console.log(`    ${t.field.padEnd(40)} bound into key: ${String(t.bound).padEnd(5)}  under signature: ${t.signed}${t.note ? '  (' + t.note + ')' : ''}`);
  assert(table.find((t) => t.field === 'ephemeral key').bound && table.find((t) => t.field.startsWith('static')).bound, 'ephemeral key, static key and NodeID are bound');
  assert(!table.find((t) => t.field === 'timestamp').bound && !table.find((t) => t.field === 'nonce').bound,
    'timestamp and nonce are NOT bound into the key (same key with different values)');
  assert(table.filter((t) => !t.bound && t.field !== 'signature').every((t) => t.signed),
    'every unbound field is under the initiator\'s signature: an attacker without the signing key cannot vary it');

  console.log('\n=== 4. the only pre-claim ciphertext is the proof of a signed value ===');
  // A real responder, twice, with the SAME ephemeral (RNG repeat), fed the same recorded HELLO.
  const proofs = [];
  for (let k = 0; k < 2; k++) {
    const [client, server] = MemoryConnection.createPair(7001 + k, 7002);
    const out = [];
    const w = server.write.bind(server);
    server.write = (d, cb) => { out.push(Buffer.from(d)); return w(d, cb); };
    const r = new GMPLink({ identity: B, socket: server, isInitiator: false, ephemeralKeyPair: eB, nonceStore: null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: null });
    r.on('error', () => {});
    client.write(Buffer.concat([Buffer.from([0, 0, 1, 9, 0x01]), hello]));
    await delay(30);
    const f = out.find((x) => x[4] === 0x02);
    proofs.push({ proof: parseHelloAck(f.subarray(5)).encryptedProof, key: r.sendKey });
    r.destroy();
  }
  const plain = decryptAESGCM(proofs[0].key, 0, Buffer.from(proofs[0].proof), null);
  assert(plain.equals(nonce), 'the proof plaintext is exactly the HELLO\'s initiator nonce (a signed field)');
  assert(Buffer.from(proofs[0].proof).equals(Buffer.from(proofs[1].proof)),
    'a replay under a repeated responder ephemeral reproduces the proof byte for byte: same (key, nonce), SAME plaintext — equality only, no GHASH-key exposure');

  console.log('\n=== 5. the timestamp window bounds any replay ===');
  {
    const [client, server] = MemoryConnection.createPair(7101, 7102);
    const host = { now: () => now + 121_000, timestampWindowMs: 120_000, emit: () => false, handleIncomingRoutedPayload() {} };
    const r = new GMPLink({ identity: B, socket: server, isInitiator: false, ephemeralKeyPair: eB, nonceStore: null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: host });
    const errs = [];
    r.on('error', (e) => errs.push(e.message));
    client.write(Buffer.concat([Buffer.from([0, 0, 1, 9, 0x01]), hello]));
    await delay(30);
    assert(errs.some((m) => /timestamp out of range/.test(m)) && !r.sendKey, `a recorded HELLO replayed 121 s later is refused before any key is derived (${errs[0]})`);
  }

  console.log('\n=== 6. related: infrastructure replies on a never-promoted session ===');
  // Record a relay-hop session: HELLO, key-confirmation PING, RELAY_RESERVE.
  const hopId = generateEphemeralIdentity();
  const relayHost = (sink) => ({
    now: () => Date.now(), timestampWindowMs: 120_000, emit: () => false, handleIncomingRoutedPayload() {},
    // A relay answers each RESERVE with a fresh voucher: different bytes every time.
    handleRelayFrame: (link, type) => { if (type === 0x0C) { const v = crypto.randomBytes(64); sink.push(v); link.sendRelay(0x0D, v); } },
  });
  const recorded = [];
  {
    const [client, server] = MemoryConnection.createPair(7201, 7202);
    const w = client.write.bind(client);
    client.write = (d, cb) => { recorded.push(Buffer.from(d)); return w(d, cb); };
    const r = new GMPLink({ identity: B, socket: server, isInitiator: false, ephemeralKeyPair: eB, nonceStore: null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: relayHost([]) });
    const i = new GMPLink({ identity: hopId, socket: client, isInitiator: true, ephemeralKeyPair: generateEphemeralKeyPair(), nonceStore: null, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: relayHost([]) });
    r.on('error', () => {}); i.on('error', () => {});
    await i._sendHELLO();
    await delay(30);
    i.sendRelay(0x0C, Buffer.from('{}'));
    await delay(30);
    i.destroy(); r.destroy();
  }
  const replayHop = async (lru) => {
    const [client, server] = MemoryConnection.createPair(7301, 7302);
    const out = [];
    const w = server.write.bind(server);
    server.write = (d, cb) => { out.push(Buffer.from(d)); return w(d, cb); };
    const sent = [];
    const r = new GMPLink({ identity: B, socket: server, isInitiator: false, ephemeralKeyPair: eB, nonceStore: null, sessionKeyLRUSet: lru, pingIntervalMs: 60000, pongTimeoutMs: 60000, node: relayHost(sent) });
    const errs = [];
    r.on('error', (e) => errs.push(e.message));
    for (const f of recorded) { client.write(f); await delay(20); }
    await delay(20);
    const reply = out.find((f) => f[4] === 0x0D);
    r.destroy();
    return { reply: reply ? reply.subarray(5) : null, plain: sent[0] || null, errs };
  };
  // Without a process-wide claim set (today's default: GMPNode builds no LRU; hop sessions keep per-connection claims).
  const r1 = await replayHop(null);
  const r2 = await replayHop(null);
  const sameKeyNonce = r1.reply && r2.reply && r1.reply.length === r2.reply.length;
  const cx = sameKeyNonce ? Buffer.from(r1.reply.subarray(16).map((b, k) => b ^ r2.reply[16 + k])) : null;
  const px = r1.plain && r2.plain ? Buffer.from(r1.plain.map((b, k) => b ^ r2.plain[k])) : null;
  assert(r1.reply && r2.reply && !r1.reply.equals(r2.reply) && cx && px && cx.equals(px),
    'WITHOUT a process-wide claim set: two replays under a repeated ephemeral each got a DIFFERENT relay reply sealed under the same (key, nonce) — ciphertext XOR = plaintext XOR (keystream reuse; with two tags, the GHASH key is recoverable)');
  // With one process-wide in-memory claim set (the mechanism GMPNode supports but does not build by default).
  const lru = new SessionKeyLRUSet(1000);
  const s1 = await replayHop(lru);
  const s2 = await replayHop(lru);
  assert(s1.reply && !s2.reply && s2.errs.some((m) => /Session key reuse/.test(m)),
    `WITH a process-wide in-memory claim set the second replay is refused at the handshake, before the proof or any reply is sealed (${s2.errs[0]})`);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
