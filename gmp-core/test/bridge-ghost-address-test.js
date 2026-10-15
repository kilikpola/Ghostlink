/**
 * Bridge ↔ frontend contract for identity-based connection, as index.html uses it:
 *
 *   start        → 'started' carries nodeId AND ghostAddress
 *   resolve      → 'resolve-result' with the requestId echoed back
 *   connectNode  → 'connect-result' for a peer identified only by NodeID
 *
 * Two bridges with different seeds find each other by address, not by IP.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { WebSocket } from 'ws';
import { startBridge } from '../dist/gmp-bridge.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { ghostAddressFromNodeId, GHOST_ADDRESS_PATTERN } from '../dist/ghost-address.js';

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal stand-in for the browser's GMPBridgeConnector request plumbing. */
class BridgeClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.events = [];
    this.seq = 0;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { origin: 'http://localhost' });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch (e) { return; }
        this.events.push(msg);
        const entry = msg.requestId && this.pending.get(msg.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(msg.requestId);
          entry.resolve(msg);
        }
        for (const [key, waiter] of this.waiters || []) {
          if (waiter.match(msg)) {
            this.waiters.delete(key);
            waiter.resolve(msg);
          }
        }
      });
      this.waiters = new Map();
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  request(payload, timeoutMs = 25000) {
    const requestId = `t-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`request ${payload.type} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.send({ ...payload, requestId });
    });
  }

  waitForEvent(match, timeoutMs = 25000) {
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const key = Symbol('waiter');
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error('event timed out'));
      }, timeoutMs);
      this.waiters.set(key, { match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

(async () => {
  console.log('=== Bridge Ghost Address Contract ===\n');

  const hubPort = 49760;
  const hub = new GMPNodeManager({ seedPhrase: 'bridge test hub seed phrase alpha', GMP_PORT: hubPort });

  const aliceManager = new GMPNodeManager({ seedPhrase: 'bridge test alice seed phrase beta', GMP_PORT: hubPort + 1 });
  const bobManager = new GMPNodeManager({ seedPhrase: 'bridge test bob seed phrase gamma', GMP_PORT: hubPort + 2 });

  let aliceBridge, bobBridge, aliceClient, bobClient;

  try {
    await hub.start();

    // Bridges are handed a pre-built manager, the same way Electron does it.
    aliceBridge = await startBridge(aliceManager, 3102, '127.0.0.1', { allowTokenless: true });
    bobBridge = await startBridge(bobManager, 3103, '127.0.0.1', { allowTokenless: true });

    aliceClient = new BridgeClient('ws://127.0.0.1:3102');
    bobClient = new BridgeClient('ws://127.0.0.1:3103');
    await aliceClient.open();
    await bobClient.open();

    console.log('[1] start → started');

    aliceClient.send({ type: 'start', port: hubPort + 1 });
    bobClient.send({ type: 'start', port: hubPort + 2 });

    const aliceStarted = await aliceClient.waitForEvent((m) => m.type === 'started');
    const bobStarted = await bobClient.waitForEvent((m) => m.type === 'started');

    assert(typeof aliceStarted.nodeId === 'string' && aliceStarted.nodeId.length === 128,
      'started carries a full NodeID');
    assert(GHOST_ADDRESS_PATTERN.test(aliceStarted.ghostAddress || ''),
      `started carries a Ghost Address (${aliceStarted.ghostAddress})`);
    assert(aliceStarted.ghostAddress === ghostAddressFromNodeId(aliceStarted.nodeId),
      'the address the bridge sends matches the address derived from the NodeID');
    assert(aliceStarted.ghostAddress !== bobStarted.ghostAddress,
      'the two nodes advertise different addresses');

    console.log('\n[2] resolve');

    // Nothing is on the mesh yet, so the address is genuinely unknown.
    const early = await aliceClient.request({ type: 'resolve', address: bobStarted.ghostAddress });
    assert(early.type === 'resolve-result', 'resolve replies with resolve-result');
    assert(early.reason === 'not-found', 'an address nobody has announced is not-found');

    const bad = await aliceClient.request({ type: 'resolve', address: 'hello world' });
    assert(bad.reason === 'invalid-address', 'malformed input is rejected, not guessed at');

    // Join both nodes to the shared hub, as bootstrapping to a public peer does.
    await aliceManager.connectToPeer('127.0.0.1', hubPort);
    await bobManager.connectToPeer('127.0.0.1', hubPort);

    let resolved = null;
    for (let i = 0; i < 40 && !resolved; i++) {
      const r = await aliceClient.request({ type: 'resolve', address: bobStarted.ghostAddress });
      if (r.reason === 'ok') resolved = r;
      else await delay(250);
    }

    assert(resolved !== null, "alice resolves bob's address once both are on the mesh");
    assert(resolved && resolved.nodeId === bobStarted.nodeId, 'resolve returns the right NodeID');

    console.log('\n[3] connectNode');

    const connected = await aliceClient.request({ type: 'connectNode', nodeId: bobStarted.nodeId });
    assert(connected.type === 'connect-result', 'connectNode replies with connect-result');
    assert(connected.connected === true, `alice connects to bob by NodeID (transport: ${connected.transport})`);

    // Both sides must see the peer, otherwise only one of them shows a chat.
    const bobSaw = await bobClient.waitForEvent(
      (m) => m.type === 'peer-connected' && m.nodeId === aliceStarted.nodeId, 10000
    ).catch(() => null);
    assert(bobSaw !== null, 'bob is told about the incoming peer');

    console.log('\n[4] connect by address in one step');

    const byAddress = await aliceClient.request({ type: 'connectNode', address: bobStarted.ghostAddress });
    assert(byAddress.connected === true, 'connectNode accepts a Ghost Address directly');

    console.log('\n[5] messages flow over the address-established session');

    const delivered = bobClient.waitForEvent(
      (m) => m.type === 'message' && String(m.payload || '').includes('hello-from-alice'), 10000
    ).catch(() => null);
    aliceClient.send({
      type: 'send',
      destinationNodeId: bobStarted.nodeId,
      payload: JSON.stringify({ type: 'chat', body: 'hello-from-alice' })
    });
    assert((await delivered) !== null, 'a message addressed by NodeID reaches the other bridge');
  } finally {
    if (aliceClient) aliceClient.close();
    if (bobClient) bobClient.close();
    for (const b of [aliceBridge, bobBridge]) {
      try { b && b.wss && b.wss.close(); } catch (e) {}
    }
    await Promise.all([aliceManager.stop(), bobManager.stop(), hub.stop()].map((p) => p.catch(() => {})));
  }

  console.log(`\n=== ${testsPassed}/${testsRun} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
