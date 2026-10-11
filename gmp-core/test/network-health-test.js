/**
 * GMP Network Health Test Suite — Phase 4
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

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

const tempCachePath = path.join(__dirname, 'data', 'temp-health-cache.json');

function cleanTempFiles() {
  if (fs.existsSync(tempCachePath)) {
    try { fs.unlinkSync(tempCachePath); } catch (e) {}
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 4 — Network Health Tests                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempFiles();

    await testMetricsTracking();
    await testPeriodicChecksRebootstrap();
    await testRoutingDegradation();

    cleanTempFiles();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempFiles();
    process.exit(1);
  }
}

async function testMetricsTracking() {
  console.log('\n=== Test 1: Metrics Tracking ===');

  const node = createGMPNode({ port: 49970, peerCachePath: tempCachePath, disableBootstrap: true });
  await node.loadIdentity('health metrics');
  await node.listen();

  const reportInit = node.getHealthReport();
  assertEqual(reportInit.status, 'isolated', "Initial health status is isolated");
  assertEqual(reportInit.currentPeerCount, 0, "Initial peer count is 0");
  assertEqual(reportInit.peakPeerCount, 0, "Initial peak peer count is 0");
  assertEqual(reportInit.messagesForwarded, 0, "Initial messagesForwarded is 0");

  // Simulate forward event
  node.emit('forwarded', { payload: 'msg' });
  node.emit('ttl-expired', { payload: 'msg' });
  node.emit('no-route', { payload: 'msg' });

  const reportAfter = node.getHealthReport();
  assertEqual(reportAfter.messagesForwarded, 1, "messagesForwarded incremented");
  assertEqual(reportAfter.messagesDroppedTTL, 1, "messagesDroppedTTL incremented");
  assertEqual(reportAfter.messagesDroppedNoRoute, 1, "messagesDroppedNoRoute incremented");

  node.close();
}

async function testPeriodicChecksRebootstrap() {
  console.log('\n=== Test 2: Periodic Checks and Rebootstrap ===');

  const node = createGMPNode({ port: 49971, peerCachePath: tempCachePath, disableBootstrap: true });
  await node.loadIdentity('health checks');
  await node.listen();

  node.bootstrap.disableBootstrap = false;
  node.bootstrap.minPeers = 3;

  assertEqual(node.bootstrap.isBootstrapping, false, "Not bootstrapping initially");

  // Force health check execution (which checks if peers < minPeers)
  node.healthMonitor.runHealthCheck();

  assertEqual(node.bootstrap.isBootstrapping, true, "Health check triggered bootstrap sequence");

  node.close();
}

async function testRoutingDegradation() {
  console.log('\n=== Test 3: Routing Degradation Check ===');

  const node = createGMPNode({ port: 49972, peerCachePath: tempCachePath, disableBootstrap: true });
  await node.loadIdentity('health degradation');
  await node.listen();

  let warningEmitted = false;
  node.on('routing-degraded', () => {
    warningEmitted = true;
  });

  // Override updatePeerCounts to mock having connected peers
  node.healthMonitor.updatePeerCounts = function() {
    this.metrics.currentPeerCount = 3;
  };

  // Setup: 1 forward, 1 drop (drop rate = 50% which is > 20%)
  node.emit('forwarded', {});
  node.emit('no-route', {});

  // Force health check
  node.healthMonitor.runHealthCheck();

  assertEqual(warningEmitted, true, "'routing-degraded' event was emitted on node");
  assertEqual(node.getHealthReport().status, 'degraded', "Status is degraded due to drop rate");

  node.close();
}

runTests();
