/**
 * Descriptor ground truth in the resource log: the periodic /proc sample
 * reports open fds with soft/hard limits, logs fd-count-mismatch when links do
 * not explain them, and fd-pressure at WARN past GMP_FD_WARN_FRACTION.
 *
 * A real `gmp public-peer` under `ulimit -n 128`, sampling every 100 ms, with
 * helpers/fd-leaker.mjs opening 84 unexplained descriptors.
 *
 * Run: node test/fd-pressure-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { generateSeedPhrase } from '../dist/seed-phrase.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-fdpressure-'));
const peers = path.join(dir, 'public-peers.json');
fs.writeFileSync(peers, '[]');
const SOFT = 128;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const port = await freePort();
const env = {
  ...process.env, NODE_OPTIONS: `--import=${path.join(here, 'helpers', 'fd-leaker.mjs')}`, FD_LEAK_TOTAL: '84', FD_LEAK_STEP: '4', FD_LEAK_DELAY_MS: '1500', GMP_SEED_PHRASE: generateSeedPhrase(), GMP_DATA_DIR: dir, PORT: String(port),
  GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()),
  GMP_LAN_DISCOVERY: 'false', GMP_PUBLIC_PEERS_PATH: peers,
  GMP_RESOURCE_LOG_INTERVAL_MS: '100', GMP_FD_WARN_FRACTION: '0.8',
  GMP_HELLO_TIMEOUT_MS: '60000', GMP_HANDSHAKE_TIMEOUT_MS: '60000',
};
const child = spawn('bash', ['-c', `ulimit -n ${SOFT} && exec "${process.execPath}" "${cli}" public-peer`], { env });
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
assert(up, `public peer starts under ulimit -n ${SOFT}`);
await wait(300);

const sample = out.split('\n').find((l) => /"event":"resource-sample"/.test(l)) || '';
assert(/"fdLimit":128/.test(sample) && /"fdHardLimit":\d+/.test(sample), 'the resource sample carries the soft and hard descriptor limits');

const capWarn = out.split('\n').find((l) => /"event":"connection-cap".*"clamped":true/.test(l)) || '';
assert(/"level":"WARN"/.test(capWarn), 'at start-up: the cap clamped to the soft limit is logged at WARN');

await wait(4500); // the leaker finishes at ~1.5 s + 21 x 100 ms
const lines = out.split('\n');
const mismatch = lines.find((l) => /"event":"fd-count-mismatch"/.test(l)) || '';
const pressure = lines.find((l) => /"event":"fd-pressure"/.test(l)) || '';
console.log(`  ${mismatch.slice(0, 260)}`);
console.log(`  ${pressure.slice(0, 260)}`);
assert(/"level":"WARN"/.test(mismatch), 'fd-count-mismatch: the ground truth disagreeing with the link count is logged at WARN');
assert(/"gap":(\d+)/.test(mismatch) && Number(mismatch.match(/"gap":(\d+)/)[1]) > 16, 'it says how many descriptors no connection explains');
assert(/"level":"WARN"/.test(pressure), 'fd-pressure from the /proc count is logged at WARN');
const socks = [];
for (const s of socks) { s.byUs = true; s.destroy(); }
child.kill('SIGINT');
await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
