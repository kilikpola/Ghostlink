import './helpers/isolate-data.mjs'; // must stay first
import { WebSocket } from 'ws';
import { startBridge } from '../dist/gmp-bridge.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { createGMPNode } from '../dist/node-factory.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-bpin-${t}-`)); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal WS client to the bridge, request/response keyed by requestId.
class Client {
  constructor(url) { this.url = url; this.ws = null; this.pending = new Map(); this.seq = 0; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { origin: 'http://localhost' });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        const p = msg.requestId && this.pending.get(msg.requestId);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.requestId); p.resolve(msg); }
      });
    });
  }
  send(payload) { this.ws.send(JSON.stringify(payload)); }
  request(payload) {
    const requestId = `t-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('request timed out')); }, 5000);
      this.pending.set(requestId, { resolve, timer });
      this.send({ ...payload, requestId });
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function run() {
  console.log('\n=== item 1e: contact pin decided in MAIN, over the real bridge channel ===');
  const BRIDGE_PORT = 3211;
  const manager = new GMPNodeManager({ seedPhrase: 'bridge pin test manager seed phrase one', GMP_PORT: 0, disableBootstrap: true, dataDir: tmp('mgr') });
  await manager.start();
  const bridge = await startBridge(manager, BRIDGE_PORT, '127.0.0.1');

  // Capture the main-process mismatch log (family 5).
  const lines = [];
  const origWarn = console.warn;

  try {
    const client = new Client(`ws://127.0.0.1:${BRIDGE_PORT}`);
    await client.open();
    client.send({ type: 'start' }); // attach session to the adopted manager
    await delay(300);

    const pinned = 'a'.repeat(128);
    const other = 'b'.repeat(128);

    // Mismatch: a different NodeID with no verified rotation.
    console.warn = (...a) => lines.push(a.join(' '));
    const mismatch = await client.request({ type: 'pin-check', pinnedNodeId: pinned, presentedNodeId: other, contactId: 'c1' });
    const accept = await client.request({ type: 'pin-check', pinnedNodeId: pinned, presentedNodeId: pinned, contactId: 'c1' });
    const tofu = await client.request({ type: 'pin-check', pinnedNodeId: null, presentedNodeId: other, contactId: 'c2' });
    console.warn = origWarn;

    assert(mismatch.type === 'pin-result' && mismatch.decision === 'mismatch',
      'renderer receives mismatch for a differing key, over the real channel');
    assert(accept.type === 'pin-result' && accept.decision === 'accept',
      'positive control: the pinned NodeID -> accept, same channel');
    assert(tofu.decision === 'accept', 'no prior pin -> accept (TOFU) over the channel');
    assert(lines.some((l) => /"event":"contact-key-mismatch"/.test(l)),
      'the mismatch is logged in the main process (not the renderer)');

    // update-pin: a genuinely verified rotation, decided by gmp-core, over the channel.
    const contact = createGMPNode({ port: 0, disableBootstrap: true, dataDir: tmp('contact') });
    await contact.loadIdentity('bridge pin test contact old seed');
    const oldId = contact.identity.nodeIdHex;
    manager.node.peerCache.recordSuccess(oldId, '127.0.0.1', 59980, contact.identity.signingPubKeyHex);
    const successor = await deriveIdentityFromSeedPhrase('bridge pin test contact new seed');
    const cert = contact.rotateKey(successor);
    manager.node.keyRotationManager.handleReceivedRotation({ cert, sequenceNumber: 1, ttl: 8 }, null);
    const updated = await client.request({ type: 'pin-check', pinnedNodeId: oldId, presentedNodeId: cert.newNodeId, contactId: 'c3' });
    assert(updated.decision === 'update-pin',
      'a gmp-core-verified rotation -> update-pin over the channel');

    client.close();
  } finally {
    console.warn = origWarn;
    await bridge.close?.().catch?.(() => {});
    await manager.stop().catch(() => {});
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e && e.stack ? e.stack : e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
