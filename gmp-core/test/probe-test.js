/**
 * `gmp probe` — the deploy verification step.
 *
 * Against a locally started `gmp public-peer` (a real process, real TCP):
 *   1. a completed handshake: exit 0, the peer's full NodeID (the one the
 *      public peer printed at start-up) and its Ghost Address, TCP connect
 *      time, bytes both ways;
 *   2. --expect: the right NodeID passes; a wrong one exits 4, loudly;
 *   3. failures exit non-zero by stage: nothing listening -> 2; a TCP server
 *      that never speaks GMP -> 3; bad arguments -> 1;
 *   4. the throwaway identity leaves nothing: the process-wide data dir the
 *      probe runs with is byte-identical afterwards, the temporary dir is
 *      gone, and no seed phrase is printed.
 *
 * Run: node test/probe-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { generateSeedPhrase } from '../dist/seed-phrase.js';
import { ghostAddressFromNodeId } from '../dist/ghost-address.js';
import { findSeedPhrase } from '../dist/seed-guard.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const { assertAbsent } = absenceAsserter(assert);

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-probe-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** The process-wide data dir the probe runs with: it must come out byte-identical. */
const realDir = path.join(tmp, 'real-node-data');
fs.mkdirSync(realDir);
fs.writeFileSync(path.join(realDir, 'marker'), 'the real node\'s state lives here');
function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    out[f] = `${st.size}|${st.mtimeMs}|${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
  }
  return JSON.stringify(out);
}

function gmpProbe(...args) {
  const r = spawnSync(process.execPath, [cli, 'probe', ...args], {
    env: { ...process.env, GMP_DATA_DIR: realDir, GMP_LOG_LEVEL: 'ERROR' }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const field = (out, name) => { const m = out.match(new RegExp(`^\\s+${name}\\s+(.*)$`, 'm')); return m ? m[1].trim() : null; };

// ── a real public peer ───────────────────────────────────────────────────
const port = await freePort();
const peerDir = path.join(tmp, 'public-peer');
const peers = path.join(tmp, 'peers.json');
fs.writeFileSync(peers, '[]');
const child = spawn(process.execPath, [cli, 'public-peer'], {
  env: {
    ...process.env, GMP_SEED_PHRASE: generateSeedPhrase(), GMP_DATA_DIR: peerDir, PORT: String(port),
    GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()),
    GMP_LAN_DISCOVERY: 'false', GMP_PUBLIC_PEERS_PATH: peers, GMP_RESOURCE_LOG_INTERVAL_MS: '0',
  },
});
let peerOut = '';
child.stdout.on('data', (d) => { peerOut += d; });
child.stderr.on('data', (d) => { peerOut += d; });
const peerNodeId = await new Promise((resolve) => {
  const t0 = Date.now();
  const check = () => {
    const m = peerOut.match(/successfully started\. NodeID: ([0-9a-f]{128})/);
    if (m) resolve(m[1]);
    else if (child.exitCode !== null || Date.now() - t0 > 30_000) resolve(null);
    else setTimeout(check, 50);
  };
  check();
});
assert(!!peerNodeId, 'a local public peer is up (its NodeID read from its own start-up line)');

const before = snapshot(realDir);

console.log('\n=== 1. a completed handshake ===');
const ok = gmpProbe('127.0.0.1', String(port));
console.log(ok.out.split('\n').map((l) => `  | ${l}`).join('\n'));
assert(ok.code === 0, `exit 0 (${ok.code})`);
assert(field(ok.out, 'peer NodeID') === peerNodeId, 'prints the peer\'s full NodeID — the one the public peer printed');
assert(field(ok.out, 'Ghost Address') === ghostAddressFromNodeId(peerNodeId), `prints its Ghost Address (${field(ok.out, 'Ghost Address')})`);
assert(/^\d+ ms \(127\.0\.0\.1\)$/.test(field(ok.out, 'TCP connect') || ''), `prints the TCP connect time (${field(ok.out, 'TCP connect')})`);
assert(/^completed in \d+ ms$/.test(field(ok.out, 'handshake') || ''), `prints the handshake result (${field(ok.out, 'handshake')})`);
const bytes = (field(ok.out, 'bytes') || '').match(/sent (\d+), received (\d+)/);
assert(bytes && Number(bytes[1]) > 200 && Number(bytes[2]) > 200, `prints bytes both ways (${field(ok.out, 'bytes')})`);

console.log('\n=== 2. --expect ===');
const right = gmpProbe('127.0.0.1', String(port), '--expect', peerNodeId);
assert(right.code === 0 && /RESULT OK \(NodeID matches --expect\)/.test(right.out), `the right NodeID: exit 0, says it matched (${right.code})`);
const wrongId = crypto.randomBytes(64).toString('hex');
const wrong = gmpProbe('127.0.0.1', String(port), '--expect', wrongId);
assert(wrong.code === 4, `a different NodeID: exit 4 (${wrong.code})`);
assert(/NODEID MISMATCH/.test(wrong.out) && wrong.out.includes(`expected  ${wrongId}`) && wrong.out.includes(`answered  ${peerNodeId}`),
  'loudly, with both NodeIDs in full');

console.log('\n=== 3. failures exit non-zero, by stage ===');
const closedPort = await freePort();
const refused = gmpProbe('127.0.0.1', String(closedPort), '--timeout', '3000');
assert(refused.code === 2 && /CONNECT FAILED/.test(refused.out), `nothing listening: exit 2, CONNECT FAILED (${refused.code})`);
const silent = net.createServer((s) => { s.on('error', () => {}); }); // accepts, never speaks GMP
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const mute = gmpProbe('127.0.0.1', String(silent.address().port), '--timeout', '1500');
silent.close();
assert(mute.code === 3 && /HANDSHAKE FAILED/.test(mute.out) && /^\d+ ms/.test(field(mute.out, 'TCP connect') || ''),
  `a TCP server that never speaks GMP: connect ok, exit 3, HANDSHAKE FAILED (${mute.code})`);
assert(gmpProbe('127.0.0.1').code === 1 && gmpProbe('127.0.0.1', 'x').code === 1 && gmpProbe('127.0.0.1', String(port), '--expect', 'abc').code === 1,
  'bad arguments: exit 1');

console.log('\n=== 4. the throwaway identity leaves nothing ===');
const wrote = Number((field(ok.out, 'throwaway') || '').match(/^(\d+)/)?.[1] || 0);
assertAbsent({
  channel: 'process-wide data dir (GMP_DATA_DIR)',
  control: () => wrote,
  controlMessage: 'the throwaway node did write state — to its temporary dir',
  absent: () => snapshot(realDir) === before,
  message: 'the real data dir is byte-identical after the probes (only its marker file)',
});
const probeDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('gmp-probe-') && !f.startsWith('gmp-probe-test-'));
// Control: while a probe is running (against a mute server, so it waits), its
// temporary dir is visible to the same listing.
const mute2 = net.createServer((s) => { s.on('error', () => {}); });
await new Promise((r) => mute2.listen(0, '127.0.0.1', r));
const running = spawn(process.execPath, [cli, 'probe', '127.0.0.1', String(mute2.address().port), '--timeout', '2000'], { env: { ...process.env, GMP_DATA_DIR: realDir, GMP_LOG_LEVEL: 'ERROR' } });
await new Promise((r) => setTimeout(r, 800));
const duringRun = probeDirs();
await new Promise((r) => running.on('exit', r));
mute2.close();
assertAbsent({
  channel: 'os.tmpdir() gmp-probe-* listing',
  control: () => duringRun,
  controlMessage: 'a running probe\'s temporary dir is listed',
  absent: () => probeDirs().length === 0,
  message: `no temporary probe dir is left behind after seven probes (${probeDirs().join(', ') || 'none'})`,
});
const printed = ok.out + right.out + wrong.out + refused.out + mute.out;
assertAbsent({
  channel: 'seed-phrase detector over probe output',
  control: () => findSeedPhrase(`seed ${generateSeedPhrase()} printed`) >= 0,
  controlMessage: 'the detector finds a phrase when one is printed',
  absent: () => findSeedPhrase(printed) === -1,
  message: 'no seed phrase is printed',
});

child.kill('SIGINT');
await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
