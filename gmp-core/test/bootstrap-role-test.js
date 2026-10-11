/**
 * Bootstrap minimum by role: unattended hosts default GMP_MIN_PEERS to 0 (try
 * once, never loop); user clients keep 3; an explicit value wins.
 *
 * Every node is a real `cli.js` process with the health check sped up to every
 * 250 ms, so 4 s stands in for 8 minutes of production cadence.
 *
 * Run: node test/bootstrap-role-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { generateSeedPhrase } from '../dist/seed-phrase.js';
import { deriveIdentityFromSeedPhrase, bytesToHex } from '../dist/identity.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-bootrole-'));
const RUN_MS = 4000;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Start `cli.js <cmd>`; resolves once it has started, with a stop() that returns its parsed log. */
async function startNode(name, cmd, { peers = [], extraEnv = {} } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const peersFile = path.join(dir, 'public-peers.json');
  fs.writeFileSync(peersFile, JSON.stringify(peers));
  const seed = generateSeedPhrase();
  const nodeId = bytesToHex((await deriveIdentityFromSeedPhrase(seed)).nodeId);
  const port = await freePort();
  const env = {
    ...process.env, GMP_SEED_PHRASE: seed, GMP_DATA_DIR: dir, PORT: String(port), GMP_PORT: String(port),
    GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()),
    GMP_LAN_DISCOVERY: 'false', GMP_PUBLIC_PEERS_PATH: peersFile, GMP_RESOURCE_LOG_INTERVAL_MS: '0',
    GMP_REANNOUNCE_INTERVAL_MS: '500', GMP_LOG_LEVEL: 'INFO', ...extraEnv,
  };
  const child = spawn(process.execPath, [cli, cmd], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const up = await new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      if (/successfully started/.test(out)) resolve(true);
      else if (child.exitCode !== null || Date.now() - t0 > 30_000) resolve(false);
      else setTimeout(check, 50);
    };
    check();
  });
  const stop = async () => {
    child.kill('SIGINT');
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
    const events = [];
    for (const l of out.split('\n')) { try { const j = JSON.parse(l); events.push(j); } catch { /* console line */ } }
    const count = (ev) => events.filter((e) => `${e.component}/${e.event}` === ev).length;
    return { out, events, count };
  };
  return { up, nodeId, port, stop, entry: { address: '127.0.0.1', port, tls: false, nodeId, roles: ['bootstrap'], operator: '', provider: 'test', addedAt: 1 } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== 1. lone public peer, nobody else listed: serves, no loop ===');
{
  const n = await startNode('lone', 'public-peer');
  assert(n.up, 'starts');
  await wait(RUN_MS);
  const r = await n.stop();
  console.log(`  in ${RUN_MS} ms: ${r.count('bootstrap/failed')} failed WARN(s), ${r.count('health-monitor/check-trigger-bootstrap')} health re-trigger(s), ${r.count('bootstrap/rung-start')} rung start(s)`);
  assert(r.count('bootstrap/failed') === 0, 'no "bootstrap failed" WARN');
  assert(r.count('bootstrap/retry-scheduled') === 0, 'no retry scheduled');
  assert(r.count('health-monitor/check-trigger-bootstrap') === 0, 'the health monitor never re-triggers bootstrap');
  assert(r.count('bootstrap/rung-start') <= 4, `one ladder run at most, at start-up (${r.count('bootstrap/rung-start')} rung starts)`);
}

console.log('\n=== 2. two public peers: the second still links to the first at start-up ===');
{
  const a = await startNode('pair-a', 'public-peer');
  const b = await startNode('pair-b', 'public-peer', { peers: [a.entry] });
  assert(a.up && b.up, 'both start');
  await wait(1500);
  const rb = await b.stop();
  const ra = await a.stop();
  assert(rb.events.some((e) => e.event === 'complete' && /via public/.test(e.msg)), 'B reached A through the public rung');
  assert(rb.count('bootstrap/failed') + ra.count('bootstrap/failed') === 0, 'neither logs a bootstrap failure');
}

console.log('\n=== 3. a user client keeps minPeers 3 (still retries) ===');
{
  const n = await startNode('client', 'start');
  assert(n.up, 'starts');
  await wait(RUN_MS);
  const r = await n.stop();
  assert(r.count('health-monitor/check-trigger-bootstrap') >= 2, `the client keeps trying (${r.count('health-monitor/check-trigger-bootstrap')} re-triggers)`);
}

console.log('\n=== 4. explicit GMP_MIN_PEERS on a public peer wins ===');
{
  const n = await startNode('explicit', 'public-peer', { extraEnv: { GMP_MIN_PEERS: '3' } });
  assert(n.up, 'starts');
  await wait(RUN_MS);
  const r = await n.stop();
  assert(r.count('health-monitor/check-trigger-bootstrap') >= 2, `GMP_MIN_PEERS=3 keeps the retry loop (${r.count('health-monitor/check-trigger-bootstrap')} re-triggers)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
