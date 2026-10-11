/**
 * Handshake identity binding: a node must not be able to connect as someone else.
 *
 * The impostor pairs the victim's public NodeID and static key with its own
 * private keys — everything an attacker can learn about the victim. The
 * static<->static term in the session keys plus key confirmation must reject it.
 *
 * Run: node test/handshake-impersonation-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

let run = 0, passed = 0, failed = 0;
function assert(cond, msg) {
  run++;
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');

// The responder gives an unconfirmed handshake 10s before giving up; wait past it.
const CONFIRM_WINDOW_MS = 11000;

/** Messages the honest control delivered: the impostor case's positive control. */
let controlMessages = [];

async function makeTarget() {
  const target = createGMPNode({ port: 0 });
  await target.loadIdentity('handshake impersonation test target');
  const { port } = await target.listen();
  const seen = { connections: [], messages: [], errors: [] };
  target.on('connection', ({ peerNodeId, link }) => {
    seen.connections.push(hex(peerNodeId));
    link.on('message', (m) => seen.messages.push(String(m)));
  });
  target.on('error', ({ err }) => seen.errors.push(err?.message || String(err)));
  return { target, port, seen };
}

async function testHonestPeerConnects(victimSeed) {
  console.log('\n=== Control: the real key holder connects ===');
  const { target, port, seen } = await makeTarget();
  const victim = createGMPNode({ port: 0 });
  const victimId = await victim.loadIdentity(victimSeed);

  let dialed = null;
  try { dialed = await victim.dial('127.0.0.1', port); } catch (e) { dialed = e; }
  await delay(800);

  assert(!(dialed instanceof Error), 'the real victim\'s dial succeeds');
  assert(seen.connections.includes(hex(victimId.nodeId)),
    'the target accepts a connection from the victim\'s NodeID when the victim dials');
  // The control for the impostor case's message channel: the real victim's
  // message is delivered through the same target log.
  try { await dialed?.link?.send?.('message from the victim'); } catch { /* checked in the impostor case */ }
  await delay(300);
  controlMessages = [...seen.messages];

  victim.close();
  target.close();
  return hex(victimId.nodeId);
}

async function testImpostorRejected(victimSeed, victimNodeIdHex) {
  console.log('\n=== Impostor using the victim\'s public identity ===');
  const { target, port, seen } = await makeTarget();

  // Everything public about the victim — NodeID and static public key — is what
  // the victim sends in every HELLO, so an attacker has it.
  const victimPublic = await createGMPNode({ port: 0 }).loadIdentity(victimSeed);

  const impostor = createGMPNode({ port: 0 });
  const own = await impostor.loadIdentity('handshake impersonation test attacker');
  impostor.identity = {
    ...own,                                   // attacker's own private keys
    nodeId: victimPublic.nodeId,              // claims the victim's NodeID
    nodeIdHex: hex(victimPublic.nodeId),
    staticPubKey: victimPublic.staticPubKey,  // and the victim's static public key
  };
  assert(hex(impostor.identity.staticPrivKey) !== hex(victimPublic.staticPrivKey),
    'the impostor does not hold the victim\'s static private key');

  let dialError = null, dialed = null;
  try { dialed = await impostor.dial('127.0.0.1', port); } catch (e) { dialError = e; }

  // Whatever the dial reports, try to speak as the victim.
  const link = dialed?.link || [...(impostor.links?.values?.() || [])][0];
  try { await link?.send?.('message from the impostor'); } catch { /* link may already be gone */ }

  await delay(CONFIRM_WINDOW_MS);

  assert(!seen.connections.includes(victimNodeIdHex),
    'the target never reports a connection from the victim\'s NodeID');
  assert(seen.connections.length === 0, 'the target reports no connection at all from the impostor');
  assertAbsent({
    channel: 'target message log',
    control: () => controlMessages.filter((m) => m === 'message from the victim'),
    controlMessage: 'the real victim\'s message was delivered through it',
    absent: () => !seen.messages.includes('message from the impostor'),
    message: 'nothing the impostor sends is delivered as coming from the victim',
  });
  console.log(`    (dial ${dialError ? 'failed: ' + dialError.message : 'returned'}; target errors: ${seen.errors.length})`);

  impostor.close();
  target.close();
}

async function main() {
  console.log('Handshake impersonation test');
  const victimSeed = 'handshake impersonation test victim';
  const victimNodeIdHex = await testHonestPeerConnects(victimSeed);
  await testImpostorRejected(victimSeed, victimNodeIdHex);

  console.log(`\n=== ${passed}/${run} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
