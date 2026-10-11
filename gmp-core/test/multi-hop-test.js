/**
 * GMP Multi-hop Routing Test Suite — Phase 3
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import crypto from 'crypto';
import { absenceAsserter } from './helpers/assert-absent.mjs';
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

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

function objectContainsKey(obj, targetKey, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return false;
  visited.add(obj);

  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
    if (obj.length === targetKey.length && crypto.timingSafeEqual(Buffer.from(obj), Buffer.from(targetKey))) {
      return true;
    }
    return false;
  }

  for (const key of Object.keys(obj)) {
    try {
      if (objectContainsKey(obj[key], targetKey, visited)) {
        return true;
      }
    } catch (e) {
      // Ignore key access errors
    }
  }
  return false;
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 3 — Multi-hop Routing Tests                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testTopologyPropagationAndE2E();
    await testLoopPrevention();
    await testTTLExpiry();
    await testNoRoute();
    await testLinkWithdrawal();
    await testForwardingRateLimit();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    process.exit(1);
  }
}

async function testTopologyPropagationAndE2E() {
  console.log('\n=== Test 1, 2, 3: Topology, E2E Encryption, and Key Isolation ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({ port: 0 });
  const nodeC = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('seed A');
  await nodeB.loadIdentity('seed B');
  await nodeC.loadIdentity('seed C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  // A connects to B, B connects to C
  await nodeA.dial('127.0.0.1', nodeB.port);
  await nodeB.dial('127.0.0.1', nodeC.port);

  await delay(600);

  const hexA = nodeA.identity.nodeIdHex;
  const hexB = nodeB.identity.nodeIdHex;
  const hexC = nodeC.identity.nodeIdHex;

  // Routes beyond a neighbour are found on demand for a named destination;
  // nothing is flooded.
  await nodeA.topologyManager.queryRoute(hexC);
  await nodeC.topologyManager.queryRoute(hexA);

  const routeAtoC = nodeA.routingTable.getBestRoute(hexC);
  const routeCtoA = nodeC.routingTable.getBestRoute(hexA);
  const routeBtoA = nodeB.routingTable.getBestRoute(hexA);
  const routeBtoC = nodeB.routingTable.getBestRoute(hexC);

  assert(routeAtoC !== null, "A's routing table shows C reachable");
  if (routeAtoC) {
    assertEqual(routeAtoC.nextHopNodeId, hexB, "A's path to C is via B");
    assertEqual(routeAtoC.hopCount, 2, "A's path to C is 2 hops");
  }

  assert(routeCtoA !== null, "C's routing table shows A reachable");
  if (routeCtoA) {
    assertEqual(routeCtoA.nextHopNodeId, hexB, "C's path to A is via B");
    assertEqual(routeCtoA.hopCount, 2, "C's path to A is 2 hops");
  }

  assert(routeBtoA !== null, "B's routing table shows A reachable");
  if (routeBtoA) {
    assertEqual(routeBtoA.hopCount, 1, "B's path to A is 1 hop (direct)");
  }
  assert(routeBtoC !== null, "B's routing table shows C reachable");
  if (routeBtoC) {
    assertEqual(routeBtoC.hopCount, 1, "B's path to C is 1 hop (direct)");
  }

  // Test 2: End-to-end encrypted message A -> C through B
  let msgReceivedByC = null;
  nodeC.on('message', ({ msg }) => {
    msgReceivedByC = msg;
  });

  let bReceivedData = [];
  const linkB_A = nodeB.getLinkByNodeId(nodeA.identity.nodeId);
  if (linkB_A) {
    const originalHandleData = linkB_A._handleDATA;
    linkB_A._handleDATA = function(payload) {
      bReceivedData.push(payload);
      return originalHandleData.apply(this, arguments);
    };
  }

  const { link: virtualLinkA } = await nodeA.dialVirtual(nodeC.identity.nodeId);
  await delay(300);

  await virtualLinkA.send("Confidential multi-hop message!");
  await delay(300);

  assertEqual(msgReceivedByC, "Confidential multi-hop message!", "C decrypted and received correct message");

  assert(bReceivedData.length > 0, "B received link-level DATA messages");
  for (const payload of bReceivedData) {
    const payloadStr = payload.toString('utf8');
    assert(!payloadStr.includes("Confidential multi-hop message!"), "B's received data does not contain the plaintext message");
  }

  // Test 3: B cannot derive A-C session key
  const virtualLinkC = nodeC.virtualConnections.get(nodeA.identity.nodeIdHex.slice(0, 64));
  assert(virtualLinkC !== undefined, "C has virtual link connection back to A");
  if (virtualLinkC) {
    const keyAC_send = virtualLinkC.sendKey;
    const keyAC_recv = virtualLinkC.recvKey;

    assert(keyAC_send !== null, "A-C session key exists");
    
    const containsSendKey = objectContainsKey(nodeB, keyAC_send);
    const containsRecvKey = objectContainsKey(nodeB, keyAC_recv);

    assert(!containsSendKey, "B's process has no derived value/variable that equals the A-C send session key");
    assert(!containsRecvKey, "B's process has no derived value/variable that equals the A-C recv session key");
  }

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

async function testLoopPrevention() {
  console.log('\n=== Test 4: Loop Prevention ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({ port: 0 });
  const nodeC = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('loop A');
  await nodeB.loadIdentity('loop B');
  await nodeC.loadIdentity('loop C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  await nodeA.dial('127.0.0.1', nodeB.port); // A-B
  await nodeB.dial('127.0.0.1', nodeC.port); // B-C
  await nodeC.dial('127.0.0.1', nodeA.port); // C-A

  await delay(600);

  // Count TOPOLOGY_ANNOUNCE receptions (TopologyManager emits no 'route-added').
  let announceCount = 0;
  for (const node of [nodeA, nodeB, nodeC]) {
    const original = node.topologyManager.handleReceivedAnnounce.bind(node.topologyManager);
    node.topologyManager.handleReceivedAnnounce = (announce, link) => {
      announceCount++;
      return original(announce, link);
    };
  }

  nodeA.topologyManager.handleLinkEstablished(nodeB.identity.nodeIdHex);

  await delay(500);
  const initialCount = announceCount;
  await delay(500);
  const finalCount = announceCount;

  assert(initialCount > 0, `The re-announce propagated (${initialCount} receptions)`);
  assertEqual(initialCount, finalCount, "Topology propagation terminated successfully (no infinite loops)");

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

async function testTTLExpiry() {
  console.log('\n=== Test 5: TTL Expiry ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({ port: 0 });
  const nodeC = createGMPNode({ port: 0 });
  const nodeD = createGMPNode({ port: 0 });
  const nodeE = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('ttl A');
  await nodeB.loadIdentity('ttl B');
  await nodeC.loadIdentity('ttl C');
  await nodeD.loadIdentity('ttl D');
  await nodeE.loadIdentity('ttl E');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();
  await nodeD.listen();
  await nodeE.listen();

  await nodeA.dial('127.0.0.1', nodeB.port); // A-B
  await nodeB.dial('127.0.0.1', nodeC.port); // B-C
  await nodeC.dial('127.0.0.1', nodeD.port); // C-D
  await nodeD.dial('127.0.0.1', nodeE.port); // D-E

  await delay(800);
  // A asks for E; B and C learn their onward routes by forwarding the query
  //, which is what lets the frame get as far as D.
  assert(await nodeA.topologyManager.queryRoute(nodeE.identity.nodeIdHex), 'A finds a 4-hop route to E on demand');
  
  let ttlExpiredEmitted = false;
  let expiredNode = null;

  const handleTtlExpired = (nodeName) => {
    return () => {
      ttlExpiredEmitted = true;
      expiredNode = nodeName;
    };
  };

  nodeB.on('ttl-expired', handleTtlExpired('B'));
  nodeC.on('ttl-expired', handleTtlExpired('C'));
  nodeD.on('ttl-expired', handleTtlExpired('D'));
  nodeE.on('ttl-expired', handleTtlExpired('E'));

  // A routed frame that reaches E is seen by E's forwarder as local. The mock
  // payload below could never surface as a 'message' (it is not sealed to E),
  // so that event alone cannot see an arrival; this spy can (M6-1c-fix-6d).
  let arrivedAtE = 0;
  const processIncomingE = nodeE.forwarder.processIncoming.bind(nodeE.forwarder);
  nodeE.forwarder.processIncoming = (...a) => {
    const r = processIncomingE(...a);
    if (r && r.local) arrivedAtE++;
    return r;
  };

  const linkA_B = nodeA.getLinkByNodeId(nodeB.identity.nodeId);
  assert(linkA_B !== null, "Link A-B exists");

  if (linkA_B) {
    const destE = nodeE.identity.nodeId.slice(0, 32);
    const mockPayload = Buffer.from("Secret frame");
    linkA_B.sendRoutedDATA(destE, 3, mockPayload, nodeA.identity.nodeId.slice(0, 32));
  }

  await delay(400);

  assertEqual(ttlExpiredEmitted, true, "'ttl-expired' event was emitted");
  assertEqual(expiredNode, 'D', "'ttl-expired' event emitted at the correct node (D)");
  // "Message never reached E" via E's 'message' event is gone: that event
  // cannot fire for this unsealed mock payload, so it could not have seen a
  // failure (M6-1c-fix-6d). The forwarder spy can.
  const arrivedShort = arrivedAtE;
  if (linkA_B) {
    linkA_B.sendRoutedDATA(nodeE.identity.nodeId.slice(0, 32), 8, Buffer.from("Secret frame"), nodeA.identity.nodeId.slice(0, 32));
    await delay(400);
  }
  assertAbsent({
    channel: "E's forwarder (local arrivals)",
    control: () => arrivedAtE - arrivedShort,
    controlMessage: 'the same frame with enough hops reaches E and is counted',
    absent: () => arrivedShort === 0,
    message: 'the TTL-3 frame never reached E',
  });

  nodeA.close();
  nodeB.close();
  nodeC.close();
  nodeD.close();
  nodeE.close();
}

async function testNoRoute() {
  console.log('\n=== Test 6: No Route Handling ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('noroute A');
  await nodeB.loadIdentity('noroute B');

  await nodeA.listen();
  await nodeB.listen();

  await nodeA.dial('127.0.0.1', nodeB.port);
  await delay(200);

  let noRouteEmitted = false;
  nodeA.on('no-route', () => {
    noRouteEmitted = true;
  });

  const linkA_B = nodeA.getLinkByNodeId(nodeB.identity.nodeId);
  assert(linkA_B !== null, "Link A-B exists");

  try {
    const randomDest = crypto.randomBytes(64);
    await nodeA.dialVirtual(randomDest);
  } catch (e) {
    // Expected to reject because of no-route
  }

  await delay(200);
  assertEqual(noRouteEmitted, true, "'no-route' emitted, no crash occurred");

  nodeA.close();
  nodeB.close();
}

async function testLinkWithdrawal() {
  console.log('\n=== Test 7: Link Withdrawal Propagation ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({ port: 0 });
  const nodeC = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('withdraw A');
  await nodeB.loadIdentity('withdraw B');
  await nodeC.loadIdentity('withdraw C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  await nodeA.dial('127.0.0.1', nodeB.port); // A-B
  await nodeB.dial('127.0.0.1', nodeC.port); // B-C

  await delay(600);
  await nodeA.topologyManager.queryRoute(nodeC.identity.nodeIdHex); // on demand
  await nodeC.topologyManager.queryRoute(nodeA.identity.nodeIdHex);

  assert(nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex) !== null, "C is initially reachable from A");

  const { link: virtualLinkA } = await nodeA.dialVirtual(nodeC.identity.nodeId);
  await delay(200);

  nodeC.close();
  await delay(600);

  const route = nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex);
  assertEqual(route, null, "A's routing table no longer shows C reachable");

  let noRouteEmitted = false;
  nodeA.on('no-route', () => {
    noRouteEmitted = true;
  });

  try {
    await virtualLinkA.send("test");
  } catch (e) {
    // Expected to reject because of no-route
  }
  
  await delay(200);
  assertEqual(noRouteEmitted, true, "Attempting to send after withdrawal triggers 'no-route'");

  nodeA.close();
  nodeB.close();
}

async function testForwardingRateLimit() {
  console.log('\n=== Test 8: Forwarding Rate Limit ===');

  const nodeA = createGMPNode({ port: 0 });
  const nodeB = createGMPNode({
    port: 0,
    forwardRateLimitMax: 10,
    forwardRateLimitWindowMs: 5000
  });
  const nodeC = createGMPNode({ port: 0 });

  await nodeA.loadIdentity('ratelimit A');
  await nodeB.loadIdentity('ratelimit B');
  await nodeC.loadIdentity('ratelimit C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  await nodeA.dial('127.0.0.1', nodeB.port); // A-B
  await nodeB.dial('127.0.0.1', nodeC.port); // B-C

  await delay(600);
  await nodeA.topologyManager.queryRoute(nodeC.identity.nodeIdHex); // on demand

  let forwardsCount = 0;
  nodeB.on('forwarded', () => {
    forwardsCount++;
  });

  let rateLimitedEmitted = false;
  nodeB.on('rate-limited', (info) => {
    if (info.type === 'forward') {
      rateLimitedEmitted = true;
    }
  });

  const linkA_B = nodeA.getLinkByNodeId(nodeB.identity.nodeId);
  assert(linkA_B !== null, "Link A-B exists");

  if (linkA_B) {
    for (let i = 0; i < 15; i++) {
      linkA_B.sendRoutedDATA(nodeC.identity.nodeId.slice(0, 32), 16, Buffer.from(`msg ${i}`), nodeA.identity.nodeId.slice(0, 32));
    }
  }

  await delay(300);

  assertEqual(forwardsCount, 10, "B forwarded exactly 10 messages");
  assertEqual(rateLimitedEmitted, true, "Rate-limited event was emitted for forward rate-limiting");

  nodeA.close();
  nodeB.close();
  nodeC.close();
}

runTests();
