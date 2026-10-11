/**
 * GMP Topology Maintenance Test Suite — Phase 3
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { RoutingTable } from '../dist/routing-table.js';

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
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 3 — Topology Maintenance Tests                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testPeriodicReannouncement();
    await testWithdrawalUpdatesRemoteTables();
    await testExpiredRoutesPruned();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    process.exit(1);
  }
}

async function testPeriodicReannouncement() {
  console.log('\n=== Test 1: Periodic Re-announcement Fires on Schedule ===');

  // A needs a second neighbour: the sample a peer is shown excludes the peer
  // itself, so on a lone A-B link there is nothing to refresh.
  // Route expiry shorter than the test, so keeping B's route to C alive has to
  // come from the periodic tick, not from the route simply being young.
  const nodeA = createGMPNode({ port: 0, announceIntervalMs: 200, GMP_ROUTE_EXPIRY_MS: 300 });
  const nodeB = createGMPNode({ port: 0, announceIntervalMs: 200, GMP_ROUTE_EXPIRY_MS: 300 });
  const nodeC = createGMPNode({ port: 0, announceIntervalMs: 200, GMP_ROUTE_EXPIRY_MS: 300 });

  await nodeA.loadIdentity('periodic A');
  await nodeB.loadIdentity('periodic B');
  await nodeC.loadIdentity('periodic C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  // Spy on the A->B link the moment it exists, so the announce of C's edge
  // cannot slip out before it is installed.
  let linkA_B = null;
  let announceCount = 0;
  nodeA.on('connection', ({ link, peerNodeId }) => {
    if (Buffer.from(peerNodeId).toString('hex') !== nodeB.identity.nodeIdHex) return;
    linkA_B = link;
    const originalSend = link.sendTopologyAnnounce;
    link.sendTopologyAnnounce = function(announce) {
      announceCount++;
      return originalSend.apply(this, arguments);
    };
  });

  await nodeB.dial('127.0.0.1', nodeA.port);
  await nodeC.dial('127.0.0.1', nodeA.port);
  await delay(100);

  assert(linkA_B !== null, "Link established");
  const signaturesBefore = nodeA.topologyManager.stats.signatures;

  await delay(1200);

  // What is new reaches B once (C's edge entered B's sample when C joined);
  // unchanged edges are never re-sent.
  assert(announceCount >= 1, `The periodic tick delivered what was new to B (${announceCount} announce(s))`);
  assert(announceCount <= 2, `and did not repeat unchanged edges every 200 ms tick (${announceCount} over ~6 ticks)`);
  const signed = nodeA.topologyManager.stats.signatures - signaturesBefore;
  assert(signed <= 1, `${announceCount} announce(s) cost ${signed} signature(s): signed once, then cached`);
  assert(nodeB.routingTable.getBestRoute(nodeC.identity.nodeIdHex) !== null,
    "B's route to C outlives the 300 ms route expiry: kept alive by B's own tick from a still-fresh signed edge");

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

async function testWithdrawalUpdatesRemoteTables() {
  console.log('\n=== Test 2: Withdrawal on Link Close Updates Remote Tables ===');

  // A learns B-C from B's periodic sample (nothing is pushed per change);
  // a short interval keeps the test quick.
  const nodeA = createGMPNode({ port: 0, announceIntervalMs: 200 });
  const nodeB = createGMPNode({ port: 0, announceIntervalMs: 200 });
  const nodeC = createGMPNode({ port: 0, announceIntervalMs: 200 });

  await nodeA.loadIdentity('maintenance withdraw A');
  await nodeB.loadIdentity('maintenance withdraw B');
  await nodeC.loadIdentity('maintenance withdraw C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  await nodeA.dial('127.0.0.1', nodeB.port); // A-B
  await nodeB.dial('127.0.0.1', nodeC.port); // B-C

  await delay(600);

  assert(nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex) !== null, "C is initially reachable from A");

  nodeC.close();
  await delay(600);

  assertEqual(nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex), null, "Withdrawal (sent to A, which had been shown B-C) updated A's routing table");

  nodeA.close();
  nodeB.close();
}

async function testExpiredRoutesPruned() {
  console.log('\n=== Test 3: Expired Routes are Pruned from Routing Table ===');

  const table = new RoutingTable({
    expiryTimeoutMs: 200,
    pruneIntervalMs: 50
  });

  const destNodeId = 'dest_node_id_hex_string_64_bytes_long_placeholder_1234567890123456';
  const nextHopNodeId = 'next_hop_node_id_hex_string_64_bytes_long_placeholder_12345678901234';

  let routeExpiredEmitted = false;
  table.on('route-expired', () => {
    routeExpiredEmitted = true;
  });

  table.addRoute(destNodeId, nextHopNodeId, 2);

  assert(table.getBestRoute(destNodeId) !== null, "Route successfully added to table");

  await delay(300);

  assertEqual(table.getBestRoute(destNodeId), null, "Expired route is pruned from table");
  assertEqual(routeExpiredEmitted, true, "'route-expired' event was emitted");

  table.close();
}

runTests();
