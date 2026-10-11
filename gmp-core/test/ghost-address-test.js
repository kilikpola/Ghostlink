/**
 * Ghost Address Test Suite
 *
 *   1. Derivation: a pure function of the NodeID; user-typed variants
 *      normalise back to it.
 *   2. Resolution and connection between two spokes that see each other only
 *      through a shared public peer, by address alone, over a routed circuit.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import {
  ghostAddressFromNodeId,
  normalizeGhostAddress,
  isGhostAddress,
  findNodeIdsForAddress,
  GHOST_ADDRESS_PATTERN
} from '../dist/ghost-address.js';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `check()` to return truthy, polling until `timeoutMs` elapses. */
async function waitFor(check, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}

function testDerivation() {
  console.log('\n[1] Address derivation');

  const nodeIdA = '52ab56117354cf7d7f12b8f2de7a428f50462f2146a9cf6c246b21b8c67f7ff3' +
                  '57192573bd7944236472b49617edb4e4bff5e7aa8e8eeec1938235caf66afe59';
  const nodeIdB = 'ffee0011223344556677889900aabbccddeeff00112233445566778899aabbcc' +
                  'ddeeff00112233445566778899aabbccddeeff00112233445566778899aabbcc';

  const addrA = ghostAddressFromNodeId(nodeIdA);
  const addrB = ghostAddressFromNodeId(nodeIdB);

  assert(GHOST_ADDRESS_PATTERN.test(addrA), `derives canonical form (${addrA})`);
  assertEqual(ghostAddressFromNodeId(nodeIdA), addrA, 'derivation is deterministic');
  assertEqual(ghostAddressFromNodeId(Buffer.from(nodeIdA, 'hex')), addrA, 'accepts Buffer NodeIDs');
  assertEqual(ghostAddressFromNodeId(nodeIdA.toUpperCase()), addrA, 'case-insensitive on hex input');
  assert(addrA !== addrB, 'distinct NodeIDs give distinct addresses');

  console.log('\n[2] Address normalisation of user input');

  assertEqual(normalizeGhostAddress(addrA), addrA, 'canonical form round-trips');
  assertEqual(normalizeGhostAddress(addrA.toLowerCase()), addrA, 'lower case accepted');
  assertEqual(normalizeGhostAddress(addrA.replace(/-/g, '')), addrA, 'missing dashes accepted');
  assertEqual(normalizeGhostAddress(addrA.slice('GHOST-'.length)), addrA, 'missing GHOST- prefix accepted');
  assertEqual(normalizeGhostAddress(`  ${addrA}  `), addrA, 'surrounding whitespace ignored');

  // The Crockford substitutions: a hand-copied address that turned 0 into O
  // (or 1 into I/L) still has to resolve to the same peer.
  const confusable = addrA.replace(/0/g, 'O').replace(/1/g, 'I');
  assertEqual(normalizeGhostAddress(confusable), addrA, 'O→0 and I→1 confusions are folded');

  assertEqual(normalizeGhostAddress('GHOST-AB-CD'), null, 'rejects a too-short address');
  assertEqual(normalizeGhostAddress('not an address'), null, 'rejects free text');
  assertEqual(normalizeGhostAddress(null), null, 'rejects null');
  assert(isGhostAddress(addrA) && !isGhostAddress('GL-ABC123'), 'isGhostAddress discriminates');

  console.log('\n[3] Candidate scanning');

  assertEqual(findNodeIdsForAddress([nodeIdA, nodeIdB], addrA).length, 1, 'finds the one matching NodeID');
  assertEqual(findNodeIdsForAddress([nodeIdB], addrA).length, 0, 'finds nothing when absent');
  assertEqual(findNodeIdsForAddress([nodeIdA, 'garbage', ''], addrA).length, 1, 'skips unparseable entries');
  // Two NodeIDs sharing the first 48 bits collide, and the scan must surface
  // both rather than returning an arbitrary winner.
  const twin = nodeIdA.slice(0, 12) + 'b'.repeat(116);
  assertEqual(findNodeIdsForAddress([nodeIdA, twin], addrA).length, 2, 'reports colliding NodeIDs together');
}

async function testMeshResolution() {
  console.log('\n[4] Resolution and connection across a hub (no IP exchanged)');

  const basePort = 49700;
  const hub = new GMPNodeManager({ seedPhrase: 'ghost address test hub seed phrase one', GMP_PORT: basePort });
  const alice = new GMPNodeManager({ seedPhrase: 'ghost address test alice seed phrase two', GMP_PORT: basePort + 1 });
  const bob = new GMPNodeManager({ seedPhrase: 'ghost address test bob seed phrase three', GMP_PORT: basePort + 2 });

  try {
    await hub.start();
    await alice.start();
    await bob.start();

    const aliceAddress = alice.getGhostAddress();
    const bobAddress = bob.getGhostAddress();

    assert(GHOST_ADDRESS_PATTERN.test(aliceAddress), `alice has an address (${aliceAddress})`);
    assert(aliceAddress !== bobAddress, 'the two nodes have different addresses');
    assertEqual(alice.getGhostAddress(), aliceAddress, 'address is stable across calls');

    // Both spokes reach only the hub. This is the shape of the real network:
    // everyone dials a public peer, nobody dials each other.
    await alice.connectToPeer('127.0.0.1', basePort);
    await bob.connectToPeer('127.0.0.1', basePort);

    // Nothing is flooded any more: alice asks the mesh for the
    // address she was given, and the hub answers with its signed edge to bob.
    const resolved = await waitFor(async () => {
      const r = await alice.lookupGhostAddress(bobAddress);
      return r.reason === 'ok' ? r : null;
    });

    assert(resolved !== null, "alice resolves bob's address through the mesh");
    if (resolved) {
      assertEqual(resolved.nodeId, bob.getNodeId(), 'resolution yields the correct NodeID');
    }

    // Nothing here mentions an IP or a port — only the address.
    const outcome = await alice.connectByGhostAddress(bobAddress);
    assert(outcome.connected, `alice connects to bob by address alone (transport: ${outcome.transport})`);

    // A second call must reuse the live circuit rather than dialling again.
    const again = await alice.connectByGhostAddress(bobAddress);
    assert(again.connected, 'reconnecting to an already-connected peer succeeds');

    // Traffic actually flows over the circuit that was established by address.
    const received = new Promise((resolve) => {
      const onMessage = ({ fromNodeId, payload }) => {
        if (fromNodeId === alice.getNodeId()) {
          bob.off('message', onMessage);
          resolve(payload);
        }
      };
      bob.on('message', onMessage);
    });
    await alice.sendMessage(bob.getNodeId(), JSON.stringify({ type: 'ghost-address-probe' }));
    const payload = await Promise.race([received, delay(5000).then(() => null)]);
    assert(payload !== null && String(payload).includes('ghost-address-probe'),
      'a message sent over the address-established circuit arrives');

    console.log('\n[5] Failure modes');

    const unknown = alice.resolveGhostAddress('GHOST-ZZZ-ZZZ-ZZZ');
    assertEqual(unknown.reason, 'not-found', 'an unknown address reports not-found, not a wrong peer');
    assertEqual(alice.resolveGhostAddress('nonsense').reason, 'invalid-address', 'malformed input is rejected');

    const self = await alice.connectByNodeId(alice.getNodeId());
    assert(!self.connected, 'a node refuses to connect to itself');
  } finally {
    await Promise.all([alice.stop(), bob.stop(), hub.stop()].map((p) => p.catch(() => {})));
  }
}

(async () => {
  console.log('=== Ghost Address Test Suite ===');
  testDerivation();
  await testMeshResolution();

  console.log(`\n=== ${testsPassed}/${testsRun} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
