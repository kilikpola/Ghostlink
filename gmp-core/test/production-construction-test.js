/**
 * Production construction: builds a node exactly as each shipped entry point
 * does (`gmp`, `gmp public-peer`, `gmp storage-peer`, Electron) and checks
 * every required security control is present and works:
 *
 *   boot counter     non-zero, and strictly increasing across a restart
 *   nonce store      a claimed session key is refused, in-run and after restart
 *   session-key set  a repeated key is reported as a repeat
 *   rate limiter     present, and a socket that never sends HELLO is closed
 *
 * Each entry point runs twice in its own process (helpers/production-node-probe.mjs),
 * the second run being the restart. Only operator-controlled environment is set.
 *
 * Run with: node test/production-construction-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, 'helpers', 'production-node-probe.mjs');
const HELLO_TIMEOUT_MS = 700;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function runProbe(entry, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [probe, entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('PROBE '));
      const logs = out.split('\n').filter((l) => l.includes('"resource-sample"')).length;
      resolve(line ? { ...JSON.parse(line.slice(6)), resourceSamples: logs } : { error: `no probe output (exit ${code}): ${(err || out).split('\n').filter((l) => !l.startsWith('{"ts')).slice(-3).join(' | ')}` });
    });
  });
}

console.log('\n=== the entry points build their nodes from entry-points.js ===');
{
  const cli = fs.readFileSync(path.join(here, '..', 'src', 'cli.ts'), 'utf8');
  const electron = fs.readFileSync(path.join(here, '..', '..', 'electron', 'src', 'main.js'), 'utf8');
  assert(/cliManagerOptions\(/.test(cli) && /storagePeerManagerOptions\(/.test(cli), 'cli.ts builds node / public-peer / storage-peer options with the shared builders');
  assert(/electronManagerOptions\(/.test(electron) && /electronDataDir\(/.test(electron), 'electron main.js builds its options and data dir with the shared builders');
  assert(!/new GMPNodeManager\(\s*\{/.test(cli + electron), 'no entry point passes an inline options object instead');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-prodctor-'));
const entries = ['cli', 'public-peer', 'storage-peer', 'electron'];

for (const entry of entries) {
  console.log(`\n=== ${entry} ===`);
  const env = {
    ...process.env,
    PROBE_SEED: `production construction ${entry} seed`,
    GMP_HELLO_TIMEOUT_MS: String(HELLO_TIMEOUT_MS),
    GMP_HANDSHAKE_TIMEOUT_MS: String(HELLO_TIMEOUT_MS),
    GMP_LAN_DISCOVERY: 'false',
    GMP_METRICS_PORT: String(await freePort()),
  };
  // Production-shaped: none of the harness's own switches.
  delete env.GMP_DEBUG_ASSERTS;
  delete env.NODE_ENV;
  const port = await freePort();
  if (entry === 'public-peer') env.PORT = String(port); else env.GMP_PORT = String(port);
  let expectDataDir;
  if (entry === 'electron') {
    // A packaged app: main.js derives GMP_DATA_DIR from userData.
    delete env.GMP_DATA_DIR;
    env.PROBE_ELECTRON_USERDATA = path.join(tmp, 'electron-userdata');
    expectDataDir = path.join(env.PROBE_ELECTRON_USERDATA, 'gmp-data');
  } else {
    env.GMP_DATA_DIR = expectDataDir = path.join(tmp, entry);
  }

  // freePort() releases the port before the probe binds it, and in a full
  // run another process's outbound connection can take it in that gap
  // (seen once: EADDRINUSE on the first start). The port number is not what
  // this test checks: on EADDRINUSE only, pick a fresh one and say so.
  const probeWithPortRetry = async () => {
    let r = await runProbe(entry, env);
    if (r.error && /EADDRINUSE/.test(r.error)) {
      console.log(`  (port ${env.PORT || env.GMP_PORT} taken between pick and bind; retrying on a fresh port)`);
      const fresh = String(await freePort());
      if (entry === 'public-peer') env.PORT = fresh; else env.GMP_PORT = fresh;
      r = await runProbe(entry, env);
    }
    return r;
  };
  const first = await probeWithPortRetry();
  const second = await probeWithPortRetry();
  for (const [label, r] of [['start', first], ['restart', second]]) {
    const { entry: _e, options: _o, resourceSamples: _r, ...shown } = r;
    console.log(`  ${label}: ${JSON.stringify(shown)}`);
  }

  assert(!first.error && !second.error, `${entry}: starts both times${first.error || second.error ? ` (${first.error || second.error})` : ''}`);
  assert(first.dataDirEnv === expectDataDir, `${entry}: state lives in ${expectDataDir} (got ${first.dataDirEnv})`);
  const b1 = first.boot === null || first.boot === undefined ? null : BigInt(first.boot);
  const b2 = second.boot === null || second.boot === undefined ? null : BigInt(second.boot);
  assert(b1 !== null && b1 > 0n, `${entry}: boot counter is non-zero (${first.boot})`);
  assert(b1 !== null && b2 !== null && b2 > b1, `${entry}: boot counter increases across the restart (${first.boot} -> ${second.boot})`);
  assert(first.nonceStore === true && second.nonceStore === true, `${entry}: nonce store present`);
  assert(first.claimFirst === true && first.claimAgain === false, `${entry}: nonce store refuses a session key it has just claimed`);
  assert(second.claimFirst === false, `${entry}: after the restart, the claim from the first run is still refused (persisted)`);
  assert(first.sessionKeySet === true && first.setFirst === true && first.setAgain === false, `${entry}: session-key set present and reports a repeated key`);
  assert(first.rateLimiter === true, `${entry}: rate limiter present`);
  if (entry === 'public-peer') {
    assert(first.resourceSamples > 0, `${entry}: logs resource samples to stdout by default (${first.resourceSamples} line(s))`);
  } else {
    assert(first.resourceSamples === 0, `${entry}: no resource sampling unless asked (${first.resourceSamples} line(s))`);
  }
  assert(typeof first.silentClosedMs === 'number' && first.silentClosedMs <= HELLO_TIMEOUT_MS * 2,
    `${entry}: a socket that never sends HELLO is closed (${first.silentClosedMs} ms, timeout ${HELLO_TIMEOUT_MS} ms)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
