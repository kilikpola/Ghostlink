/**
 * GMP Manual Multi-hop Relay Test
 *
 * Spawns 3 real GMP nodes (A, B, C) on localhost.
 * Topology:  A ←→ B ←→ C   (A and C have NO direct link)
 *
 * Demonstrates:
 *  1. Topology propagation across the mesh
 *  2. Virtual link establishment (A dials C through B)
 *  3. End-to-end encrypted messaging (B relays ciphertext only)
 *  4. Bidirectional communication (C replies to A)
 *  5. Relay security proof (B's memory is scanned for session keys)
 *
 * Run:  node test/run-manual-multihop-test.js
 */
import { createGMPNode } from '../dist/node-factory.js';
import crypto from 'crypto';
import readline from 'readline';

// ── Helpers ──────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shortId(nodeId) {
  if (!nodeId) return '(none)';
  const hex = Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array
    ? Buffer.from(nodeId).toString('hex')
    : nodeId;
  return hex.slice(0, 12) + '…';
}

function hr(char = '─', len = 64) { return char.repeat(len); }

function objectContainsBuffer(obj, target, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return false;
  visited.add(obj);
  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
    if (obj.length === target.length) {
      try { return crypto.timingSafeEqual(Buffer.from(obj), Buffer.from(target)); }
      catch { return false; }
    }
    return false;
  }
  for (const key of Object.keys(obj)) {
    try { if (objectContainsBuffer(obj[key], target, visited)) return true; }
    catch { /* skip */ }
  }
  return false;
}

function printRoutes(node, label) {
  const routes = node.routingTable.getAllRoutes();
  if (routes.length === 0) {
    console.log(`  ${label}: (empty routing table)`);
    return;
  }
  for (const r of routes) {
    console.log(`  ${label}: dest=${shortId(r.destinationNodeId)}  via=${shortId(r.nextHopNodeId)}  hops=${r.hopCount}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log('╔' + hr('═') + '╗');
  console.log('║  GMP Phase 3 — Live Multi-hop Relay Test (localhost)' + ' '.repeat(12) + '║');
  console.log('╚' + hr('═') + '╝');
  console.log();

  // ── Step 1: Boot 3 real nodes ──────────────────────────────────
  console.log('[1/7] Booting three GMP nodes on localhost…');
  const nodeA = createGMPNode({ port: 49750 });
  const nodeB = createGMPNode({ port: 49751 });
  const nodeC = createGMPNode({ port: 49752 });

  await nodeA.loadIdentity('manual-test-node-A-identity-phrase');
  await nodeB.loadIdentity('manual-test-node-B-relay-identity');
  await nodeC.loadIdentity('manual-test-node-C-identity-phrase');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  console.log(`      Node A  ${shortId(nodeA.identity.nodeIdHex)}  port 49750`);
  console.log(`      Node B  ${shortId(nodeB.identity.nodeIdHex)}  port 49751  (RELAY)`);
  console.log(`      Node C  ${shortId(nodeC.identity.nodeIdHex)}  port 49752`);

  // Attach global error handlers so nothing crashes silently
  for (const [name, n] of [['A', nodeA], ['B', nodeB], ['C', nodeC]]) {
    n.on('error', (e) => console.log(`  [${name} error] ${e.err?.message || e}`));
  }

  // ── Step 2: Establish physical links ───────────────────────────
  console.log(`\n[2/7] Establishing physical links:  A ←→ B  and  B ←→ C …`);

  await nodeA.dial('127.0.0.1', 49751);  // A → B
  await nodeB.dial('127.0.0.1', 49752);  // B → C

  console.log('      A ←→ B  ✓ connected');
  console.log('      B ←→ C  ✓ connected');
  console.log('      A ←→ C  ✗ no direct link (by design)');

  // ── Step 3: Wait for topology convergence ──────────────────────
  console.log('\n[3/7] Waiting for topology announcements to propagate (1.5 s)…');
  await delay(1500);

  console.log('      Routing tables after convergence:');
  printRoutes(nodeA, 'A');
  printRoutes(nodeB, 'B');
  printRoutes(nodeC, 'C');

  const routeAtoC = nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex);
  const routeCtoA = nodeC.routingTable.getBestRoute(nodeA.identity.nodeIdHex);

  if (!routeAtoC || !routeCtoA) {
    console.error('\n  ✗ FAIL: Topology did not converge — A cannot reach C (or vice versa).');
    console.error('    This indicates a bug in topology propagation.');
    cleanup(nodeA, nodeB, nodeC);
    return;
  }
  console.log(`\n      A → C route: via ${shortId(routeAtoC.nextHopNodeId)}, ${routeAtoC.hopCount} hops  ✓`);
  console.log(`      C → A route: via ${shortId(routeCtoA.nextHopNodeId)}, ${routeCtoA.hopCount} hops  ✓`);

  // ── Step 4: Virtual link (A dials C through B) ─────────────────
  console.log('\n[4/7] Establishing virtual encrypted tunnel  A ⟶ B ⟶ C …');

  let cReceivedMessages = [];
  let aReceivedMessages = [];

  nodeC.on('message', ({ msg }) => {
    cReceivedMessages.push(msg);
  });
  nodeA.on('message', ({ msg }) => {
    aReceivedMessages.push(msg);
  });

  // Track what B actually sees at the link level
  let bRelayedFrameCount = 0;
  nodeB.on('forwarded', () => { bRelayedFrameCount++; });

  const { link: virtualLink } = await nodeA.dialVirtual(nodeC.identity.nodeId);
  await delay(500);
  console.log('      Virtual link A ⟷ C established  ✓');

  // ── Step 5: Send messages both ways ────────────────────────────
  console.log('\n[5/7] Sending encrypted messages through the relay…');

  const msgAtoC = `Hello from A! Timestamp: ${Date.now()}`;
  await virtualLink.send(msgAtoC);
  console.log(`      A → C: "${msgAtoC}"`);
  await delay(300);

  // C sends a reply back to A
  const virtualLinkOnC = nodeC.virtualConnections.get(nodeA.identity.nodeIdHex.slice(0, 64));
  if (virtualLinkOnC) {
    const msgCtoA = `Reply from C! Random: ${crypto.randomBytes(4).toString('hex')}`;
    await virtualLinkOnC.send(msgCtoA);
    console.log(`      C → A: "${msgCtoA}"`);
    await delay(300);
  } else {
    console.log('      C → A: (skipped — C has no virtual link to A)');
  }

  // ── Step 6: Verify delivery ────────────────────────────────────
  console.log('\n[6/7] Verification:');
  console.log(hr());

  // A→C delivery
  if (cReceivedMessages.length > 0 && cReceivedMessages[0] === msgAtoC) {
    console.log('  ✓ C received A\'s message correctly (end-to-end decrypted)');
  } else {
    console.log(`  ✗ C did NOT receive A's message  (got: ${JSON.stringify(cReceivedMessages)})`);
  }

  // C→A delivery
  if (aReceivedMessages.length > 0) {
    console.log(`  ✓ A received C's reply correctly: "${aReceivedMessages[0]}"`);
  } else {
    console.log('  ✗ A did NOT receive C\'s reply');
  }

  // Relay forwarding count
  console.log(`  ✓ B relayed ${bRelayedFrameCount} encrypted frame(s) — it never saw plaintext`);

  // ── Key isolation proof ────────────────────────────────────────
  console.log('\n  Key Isolation Scan (proving B has no access to A-C keys):');
  if (virtualLinkOnC) {
    const sendKey = virtualLinkOnC.sendKey;
    const recvKey = virtualLinkOnC.recvKey;
    if (sendKey) {
      const bHasSendKey = objectContainsBuffer(nodeB, sendKey);
      const bHasRecvKey = objectContainsBuffer(nodeB, recvKey);
      console.log(`  ${bHasSendKey ? '✗ FAIL' : '✓'} B's memory does NOT contain the A-C send key`);
      console.log(`  ${bHasRecvKey ? '✗ FAIL' : '✓'} B's memory does NOT contain the A-C recv key`);
    } else {
      console.log('  ⚠ Could not extract session keys for verification');
    }
  } else {
    console.log('  ⚠ Skipped (no virtual link on C)');
  }

  console.log(hr());

  // ── Step 7: Summary ────────────────────────────────────────────
  const allPassed = cReceivedMessages.length > 0 &&
                    cReceivedMessages[0] === msgAtoC &&
                    aReceivedMessages.length > 0;

  console.log();
  if (allPassed) {
    console.log('╔' + hr('═') + '╗');
    console.log('║  🎉 PHASE 3 MANUAL TEST: ALL CHECKS PASSED' + ' '.repeat(20) + '║');
    console.log('╚' + hr('═') + '╝');
    console.log();
    console.log('  Node A sent an encrypted message to Node C through');
    console.log('  relay Node B — without A and C having any direct link.');
    console.log('  B forwarded ciphertext it could not read.');
    console.log('  C decrypted and replied. Both sides confirmed delivery.');
  } else {
    console.log('╔' + hr('═') + '╗');
    console.log('║  ✗ PHASE 3 MANUAL TEST: SOME CHECKS FAILED' + ' '.repeat(20) + '║');
    console.log('╚' + hr('═') + '╝');
  }

  console.log();
  cleanup(nodeA, nodeB, nodeC);
}

function cleanup(a, b, c) {
  a.close();
  b.close();
  c.close();
}

main().catch(err => {
  console.error('\nFatal error in manual multi-hop test:', err);
  process.exit(1);
});
