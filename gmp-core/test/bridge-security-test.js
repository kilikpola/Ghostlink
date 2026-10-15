import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { WebSocket } from 'ws';
import { startBridge } from '../dist/gmp-bridge.js';

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

async function run() {
  console.log('=== Test: GMP Bridge Origin Security ===');

  // Start bridge on test port 3009 (startBridge is async — must be awaited so the
  // listener is bound and `wss` is defined before we connect / tear down).
  const { wss } = await startBridge(null, 3009, '127.0.0.1', { allowTokenless: true });

  // Scenario 1: Allowed local origin (http://localhost:3000)
  const successPromise = new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3009', {
      headers: { origin: 'http://localhost:3000' }
    });
    ws.on('open', () => {
      assert(true, 'Connection allowed for localhost origin');
      ws.close();
      resolve(true);
    });
    ws.on('error', (err) => {
      assert(false, `Connection rejected for localhost origin: ${err.message}`);
      resolve(false);
    });
  });
  await successPromise;

  // Scenario 2: Rejected non-localhost origin (http://malicious.com)
  const rejectPromise = new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3009', {
      headers: { origin: 'http://malicious.com' }
    });
    ws.on('open', () => {
      assert(false, 'Connection allowed for malicious.com origin (VULNERABILITY!)');
      ws.close();
      resolve(false);
    });
    ws.on('error', (err) => {
      assert(err.message.includes('unexpected server response: 403') || err.message.includes('403'), 'Connection rejected with 403 for malicious origin');
      resolve(true);
    });
  });
  await rejectPromise;

  // Scenario 3: Allowed local file:// origin
  const filePromise = new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3009', {
      headers: { origin: 'file://' }
    });
    ws.on('open', () => {
      assert(true, 'Connection allowed for file:// origin');
      ws.close();
      resolve(true);
    });
    ws.on('error', (err) => {
      assert(false, `Connection rejected for file:// origin: ${err.message}`);
      resolve(false);
    });
  });
  await filePromise;

  // Scenario 4: valid JSON that is not an object (`null`) must be answered
  // with an error, and the bridge must keep serving.
  const nullPromise = new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3009');
    ws.on('open', () => ws.send('null'));
    ws.on('message', (data) => {
      const reply = JSON.parse(data.toString());
      if (reply.type !== 'error') return;
      assert(reply.code === 'INVALID_JSON', 'a non-object JSON message is rejected with INVALID_JSON');
      ws.send(JSON.stringify({ type: 'getStatus' }));
      ws.once('message', (d2) => {
        assert(JSON.parse(d2.toString()).type === 'status', 'the bridge keeps serving after a non-object message');
        ws.close();
        resolve(true);
      });
    });
    ws.on('error', (err) => { assert(false, `unexpected error: ${err.message}`); resolve(false); });
  });
  await nullPromise;

  // Close the bridge server
  wss.close();

  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

// Exit non-zero on a throw. `.catch(console.error)` printed the
// error and then let the process exit 0, so a throw before the summary above
// ate every assertion and the run still looked green.
run().catch((e) => { console.error(e); process.exit(1); });
