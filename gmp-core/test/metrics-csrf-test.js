/**
 * The metrics/control server (with POST /rotate-key) must not be drivable by a
 * web page on the same machine:
 *   - a browser-style request (Origin present) is refused
 *   - a DNS-rebinding request (foreign Host) is refused
 *   - a CORS "simple" POST (text/plain, no preflight) is refused
 *   - the CLI shape (application/json, loopback Host, no Origin) still works
 *
 * Run with: node test/metrics-csrf-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import assert from 'assert';
import http from 'http';

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function main() {
  const metrics = (await import('../dist/metrics.js')).default;

  // Start the server on an ephemeral-ish port. No node is registered, so
  // /rotate-key reaches the handler and returns 503 "Node not running" — which
  // is exactly what we want: it proves the request passed the guard. A blocked
  // request returns 403/415 *before* the handler.
  const PORT = 19099;
  metrics.startServer(PORT);
  await new Promise((r) => setTimeout(r, 150));

  function request({method = 'POST', path = '/rotate-key', headers = {}, body = ''}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {hostname: '127.0.0.1', port: PORT, path, method, headers},
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({status: res.statusCode, body: data}));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const ATTACK_BODY = JSON.stringify({newSeedPhrase: 'attacker chosen twelve word seed phrase goes right here now'});

  test('a browser CSRF (Origin header present) is refused before the handler', async () => {
    const res = await request({
      headers: {'Content-Type': 'application/json', 'Origin': 'https://evil.example', 'Content-Length': Buffer.byteLength(ATTACK_BODY)},
      body: ATTACK_BODY,
    });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}: ${res.body}`);
    assert.ok(/cross-origin/i.test(res.body), `should name the reason: ${res.body}`);
  });

  test('a DNS-rebinding request (foreign Host header) is refused', async () => {
    const res = await request({
      headers: {'Content-Type': 'application/json', 'Host': 'evil.example', 'Content-Length': Buffer.byteLength(ATTACK_BODY)},
      body: ATTACK_BODY,
    });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}: ${res.body}`);
    assert.ok(/host/i.test(res.body), `should name the reason: ${res.body}`);
  });

  test('a CORS-simple POST (text/plain, no preflight) is refused', async () => {
    // This is the request that slips past a naive server: a string body sent
    // by fetch() defaults to text/plain, which is a CORS "simple" request and
    // needs no preflight, yet JSON.parse would still read it.
    const res = await request({
      headers: {'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(ATTACK_BODY)},
      body: ATTACK_BODY,
    });
    assert.strictEqual(res.status, 415, `expected 415, got ${res.status}: ${res.body}`);
  });

  test('the legitimate CLI request shape reaches the handler', async () => {
    // application/json, loopback Host (default), no Origin — exactly what
    // cli.ts postJson sends. It must pass the guard. With no node registered
    // the handler answers 503, which proves it was reached, not blocked.
    const res = await request({
      headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ATTACK_BODY)},
      body: ATTACK_BODY,
    });
    assert.strictEqual(res.status, 503, `expected 503 (reached handler, no node), got ${res.status}: ${res.body}`);
    assert.ok(/not running/i.test(res.body), `should be the handler's own error: ${res.body}`);
  });

  test('GET /metrics from a browser (Origin present) is refused too', async () => {
    const res = await request({method: 'GET', path: '/metrics', headers: {'Origin': 'https://evil.example'}});
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  test('GET /metrics from the CLI shape still works', async () => {
    const res = await request({method: 'GET', path: '/metrics', headers: {}});
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
  });

  test('a failed /ping does not leave its timeout armed (process survives it)', async () => {
    // A registered node whose send always fails (like "No route"): the 500
    // reply must disarm the 10s timeout so it cannot write to a finished response.
    const {EventEmitter} = await import('events');
    const fakeManager = Object.assign(new EventEmitter(), {
      sendMessage: async () => { throw new Error('No route to destination'); },
    });
    metrics.registerNode({connections: new Map(), virtualConnections: new Map()}, fakeManager);
    const body = JSON.stringify({targetNodeId: 'ab'.repeat(64)});
    const res = await request({path: '/ping', headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}, body});
    assert.strictEqual(res.status, 500, `expected 500, got ${res.status}: ${res.body}`);
    assert.strictEqual(fakeManager.listenerCount('message'), 0, 'the pong listener must be removed on failure');
    await new Promise((r) => setTimeout(r, 10500));   // past the ping timeout
  });

  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
  }
  metrics.stopServer();
  if (failures) { console.error(`\n${failures} metrics-csrf test(s) failed`); process.exit(1); }
  console.log('\nAll metrics-csrf tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
