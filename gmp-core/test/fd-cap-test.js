/**
 * The connection cap refuses visibly before libuv drops silently: effective
 * cap = min(configured cap, soft limit - max(GMP_FD_HEADROOM, start-up fds +
 * 16)); refusals are logged with a reason code; a connection-pressure WARN
 * fires from the live admitted count (periodic sampling is off here).
 *
 * A real `gmp public-peer` under `ulimit -n 128` with 120 silent clients, 4 at
 * a time. "Silently dropped" = closed clients minus refusals in the log.
 *
 * Run: node test/fd-cap-test.js
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-fdcap-'));
const peers = path.join(dir, 'public-peers.json');
fs.writeFileSync(peers, '[]');
const SOFT = 128;
const CLIENTS = 120;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const port = await freePort();
const env = {
  ...process.env, GMP_SEED_PHRASE: generateSeedPhrase(), GMP_DATA_DIR: dir, PORT: String(port),
  GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()),
  GMP_LAN_DISCOVERY: 'false', GMP_PUBLIC_PEERS_PATH: peers,
  GMP_RESOURCE_LOG_INTERVAL_MS: '0', // the live path must not depend on the periodic sample
  GMP_REFUSAL_LOG_INTERVAL_MS: '500',
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
const events = () => out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ev = (name) => events().filter((e) => e.event === name);

const clamp = ev('connection-cap')[0];
console.log(`  clamp: ${clamp ? clamp.msg : 'none logged'}`);
assert(!!clamp && clamp.level === 'WARN', 'the cap line is logged at start-up, at WARN because the clamp bit');
const effective = clamp && clamp.meta ? clamp.meta.effectiveCap : null;
assert(clamp && clamp.meta && clamp.meta.configuredCap === 540 && clamp.meta.fdSoftLimit === SOFT && effective > 0 && effective < 540,
  `it names the configured cap, the soft limit and the effective cap (${clamp && JSON.stringify(clamp.meta)})`);

const socks = [];
let closedByServer = 0;
let pressureAt = -1, firstRefusalAt = -1;
for (let opened = 0; opened < CLIENTS; ) {
  for (let i = 0; i < 4; i++, opened++) {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.on('close', () => { if (!s.byUs) closedByServer++; });
    socks.push(s);
  }
  await wait(150);
  if (pressureAt < 0 && ev('connection-pressure').length) pressureAt = opened;
  if (firstRefusalAt < 0 && closedByServer > 0) firstRefusalAt = opened;
}
await wait(1500); // let the refusal summary for the last window flush

const refusals = ev('connection-refused');
const refusedLogged = refusals.reduce((n, e) => n + ((e.meta && e.meta.count) || 0), 0);
const silent = closedByServer - refusedLogged;
console.log(`  ${CLIENTS} clients: effective cap ${effective}; pressure WARN by ${pressureAt} clients; first close at ${firstRefusalAt}; closed by server ${closedByServer}; refusals in the log ${refusedLogged} over ${refusals.length} line(s)`);
if (refusals[0]) console.log(`  ${JSON.stringify(refusals[0]).slice(0, 240)}`);

assert(closedByServer > 0, 'the flood goes past the cap (the server closed clients)');
assert(refusals.length > 0 && refusals.every((e) => e.level === 'WARN' && e.meta && e.meta.code === 'FD_LIMIT'), 'refusals are logged at WARN with reason code FD_LIMIT');
assert(silent <= 0, `no client is dropped silently (${closedByServer} closed, ${refusedLogged} accounted for by logged refusals)`);
assert(refusals.length <= 6, `refusals are summarised, not one line each (${refusals.length} lines for ${refusedLogged})`);
const pressure = ev('connection-pressure')[0];
assert(!!pressure && pressure.level === 'WARN', 'connection-pressure is logged at WARN, from the live count (periodic sample off)');
assert(pressureAt > 0 && firstRefusalAt > 0 && pressureAt < firstRefusalAt, `before the first refusal (${pressureAt} < ${firstRefusalAt} clients)`);

for (const s of socks) { s.byUs = true; s.destroy(); }
child.kill('SIGINT');
await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));

console.log('\n=== the cap line is logged when the clamp does NOT bite too ===');
{
  // Silence must never be the signal: the same line, at INFO,
  // on a host whose limit is ample.
  const p2 = await freePort();
  const c2 = spawn('bash', ['-c', `ulimit -n 65536 && exec "${process.execPath}" "${cli}" public-peer`], { env: { ...env, PORT: String(p2), GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()), GMP_DATA_DIR: fs.mkdtempSync(path.join(dir, 'ample-')) } });
  let o2 = '';
  c2.stdout.on('data', (d) => { o2 += d; });
  c2.stderr.on('data', (d) => { o2 += d; });
  const t0 = Date.now();
  while (!/successfully started/.test(o2) && c2.exitCode === null && Date.now() - t0 < 30_000) await wait(50);
  c2.kill('SIGINT');
  await new Promise((r) => (c2.exitCode !== null ? r() : c2.on('exit', r)));
  const line = o2.split('\n').find((l) => /"event":"connection-cap"/.test(l)) || '';
  console.log(`  ${line.slice(0, 240)}`);
  let meta = null;
  try { meta = JSON.parse(line).meta; } catch { /* asserted below */ }
  assert(/"level":"INFO"/.test(line), 'one connection-cap line at start-up, at INFO');
  assert(meta && meta.clamped === false && meta.configuredCap === 540 && meta.effectiveCap === 540 && meta.fdSoftLimit === 65536 && meta.fdHardLimit > 0,
    `it names configured cap, soft and hard limits, effective cap, and clamped: false (${meta && JSON.stringify(meta)})`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
