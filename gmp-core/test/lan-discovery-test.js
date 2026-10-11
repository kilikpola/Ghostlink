/**
 * LAN Discovery test: two nodes, no public peer, no internet.
 *   1. discovery makes a peer's address resolvable
 *   2. discovery does not make a peer connected (privacy)
 *
 * Skips where UDP multicast is blocked (some CI sandboxes and containers).
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { LanDiscovery } from '../dist/lan-discovery.js';
import { ghostAddressFromNodeId } from '../dist/ghost-address.js';

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = check();
    if (v) return v;
    await delay(intervalMs);
  }
  return null;
}

(async () => {
  console.log('=== LAN Discovery ===\n');

  // A dedicated port and group so this never collides with a real GhostLink
  // running on the developer's machine.
  const discoveryPort = 49698;
  const discoveryGroup = '239.255.42.98';
  const basePort = 49810;

  const options = {
    GMP_LAN_DISCOVERY: true,
    GMP_LAN_DISCOVERY_PORT: discoveryPort,
    GMP_LAN_DISCOVERY_GROUP: discoveryGroup
  };

  // A test process defaults LAN discovery off, so a suite never beacons onto the
  // developer's network. Start the discovery services directly, on the dedicated
  // port and group above, so the mechanism itself is what gets tested.
  const alice = new GMPNodeManager({ ...options, seedPhrase: 'lan discovery alice seed phrase', GMP_PORT: basePort });
  const bob = new GMPNodeManager({ ...options, seedPhrase: 'lan discovery bob seed phrase', GMP_PORT: basePort + 1 });

  let aliceDiscovery = null;
  let bobDiscovery = null;

  try {
    await alice.start();
    await bob.start();

    aliceDiscovery = new LanDiscovery(alice.node, { port: discoveryPort, group: discoveryGroup, announceIntervalMs: 500 });
    bobDiscovery = new LanDiscovery(bob.node, { port: discoveryPort, group: discoveryGroup, announceIntervalMs: 500 });

    const aliceUp = await aliceDiscovery.start();
    const bobUp = await bobDiscovery.start();

    if (!aliceUp || !bobUp) {
      console.log('  ~ multicast unavailable on this host — skipping (this is a supported configuration)');
      console.log('\n=== skipped ===');
      process.exit(0);
    }

    alice.node.lanDiscovery = aliceDiscovery;
    bob.node.lanDiscovery = bobDiscovery;

    const bobAddress = ghostAddressFromNodeId(bob.getNodeId());

    console.log('[1] Peers become visible without any configuration');
    const seen = await waitFor(() => aliceDiscovery.getPeer(bob.getNodeId()));
    if (!seen) {
      console.log('  ~ no beacons received (multicast filtered) — skipping');
      console.log('\n=== skipped ===');
      process.exit(0);
    }
    assert(seen.port === basePort + 1, `alice sees bob's beacon (${seen.address}:${seen.port})`);
    assert(!aliceDiscovery.getPeer(alice.getNodeId()), 'a node does not discover itself');

    console.log('\n[2] Discovery makes the address resolvable');
    const resolved = alice.resolveGhostAddress(bobAddress);
    assert(resolved.reason === 'ok', "bob's Ghost Address resolves with no mesh at all");
    assert(resolved.nodeId === bob.getNodeId(), 'it resolves to the right NodeID');

    console.log('\n[3] Discovery does NOT connect anyone');
    // Being on the same Wi-Fi is not consent to open a session.
    assert(alice.node.getLinkByNodeId(bob.getNodeId()) === null,
      'no link exists to a merely-discovered peer');
    assert(alice.getStatus().peers.length === 0, 'the peer list is still empty');

    console.log('\n[4] Connecting is deliberate, and takes the direct LAN route');
    const outcome = await alice.connectByGhostAddress(bobAddress);
    assert(outcome.connected, `alice connects to bob over the LAN (transport: ${outcome.transport})`);
    assert(outcome.transport === 'lan' || outcome.transport === 'direct',
      'the connection is direct, not relayed through a mesh that does not exist');

    console.log('\n[4b] A beacon cannot borrow someone else\'s identity');
    // Beacons are unauthenticated. Plant one claiming an unrelated NodeID but
    // pointing at bob: the handshake proves bob is bob, so no LAN session may
    // be reported for the claimed identity, and the stray link is dropped.
    const impostorId = 'c'.repeat(128);
    aliceDiscovery.peers.set(impostorId, { nodeId: impostorId, address: seen.address, port: seen.port, lastSeen: Date.now() });
    const linksBefore = alice.node.connections.size;
    const spoofed = await alice.connectByNodeId(impostorId);
    assert(!(spoofed.connected && spoofed.transport === 'lan'),
      `a beacon claiming another NodeID does not yield a LAN session (transport: ${spoofed.transport})`);
    assert(await waitFor(() => alice.node.connections.size === linksBefore, 3000),
      'the link to the peer that answered instead is dropped');
    aliceDiscovery.peers.delete(impostorId);

    console.log('\n[5] Beacons are validated');
    const before = aliceDiscovery.peers.size;
    aliceDiscovery._onBeacon(Buffer.from('not json'), { address: '10.0.0.9' });
    aliceDiscovery._onBeacon(Buffer.from(JSON.stringify({ p: 'wrong-protocol', nodeId: 'a'.repeat(128), port: 1 })), { address: '10.0.0.9' });
    aliceDiscovery._onBeacon(Buffer.from(JSON.stringify({ p: 'ghostlink-lan-v1', nodeId: 'nothex', port: 1 })), { address: '10.0.0.9' });
    aliceDiscovery._onBeacon(Buffer.from(JSON.stringify({ p: 'ghostlink-lan-v1', nodeId: 'a'.repeat(128), port: 99999 })), { address: '10.0.0.9' });
    assert(aliceDiscovery.peers.size === before, 'malformed beacons are ignored');

    console.log('\n[6] Stale peers expire');
    const shortLived = new LanDiscovery(alice.node, { port: discoveryPort, group: discoveryGroup, peerTtlMs: 1 });
    shortLived.peers.set('b'.repeat(128), { nodeId: 'b'.repeat(128), address: '10.0.0.5', port: 49500, lastSeen: Date.now() - 5000 });
    assert(shortLived.getNodeIds().length === 0, 'a peer that stopped beaconing is dropped');
    shortLived.close();
  } finally {
    if (aliceDiscovery) aliceDiscovery.close();
    if (bobDiscovery) bobDiscovery.close();
    await Promise.all([alice.stop(), bob.stop()].map((p) => p.catch(() => {})));
  }

  console.log(`\n=== ${testsPassed}/${testsRun} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
