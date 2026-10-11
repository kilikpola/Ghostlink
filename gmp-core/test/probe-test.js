/**
 * `gmp probe` — the deploy verification step.
 *
 * Against a locally started `gmp public-peer` (a real process, real TCP):
 *   1. a completed handshake: exit 0, the peer's full NodeID (the one the
 *      public peer printed at start-up) and its Ghost Address, TCP connect
 *      time, bytes both ways;
 *   2. --expect: the right NodeID passes; a wrong one exits 4, loudly;
 *  2b. no --expect (the deploy check): the NodeID must be one the merged peer
 *      list (shipped + .local, revoked excluded) gives for exactly this
 *      host:port — any of several passes and is named; a listed mismatch is
 *      4; nothing listed (wrong host, IP instead of the listed hostname, only
 *      a revoked NodeID) is 5, never a silent pass; --expect overrides; a
 *      16-hex prefix is refused;
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

/** The probe's shipped list for a call (GMP_PUBLIC_PEERS_PATH); [] by default. */
let shipped = [];
let dataDirForCall = null;
function gmpProbe(...args) {
  const listFile = path.join(tmp, `shipped-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(listFile, JSON.stringify(shipped));
  const r = spawnSync(process.execPath, [cli, 'probe', ...args], {
    env: { ...process.env, GMP_DATA_DIR: dataDirForCall || realDir, GMP_PUBLIC_PEERS_PATH: listFile, GMP_LOG_LEVEL: 'ERROR' }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const entry = (address, nodeId, extra = {}) => ({ address, port, tls: false, nodeId, roles: ['bootstrap'], operator: '', provider: 'test', addedAt: 1, ...extra });
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

shipped = [entry('127.0.0.1', peerNodeId)];
const before = snapshot(realDir);

console.log('\n=== 1. a completed handshake ===');
const ok = gmpProbe('127.0.0.1', String(port));
console.log(ok.out.split('\n').map((l) => `  | ${l}`).join('\n'));
assert(ok.code === 0 && /RESULT OK \(NodeID matches the peer list\)/.test(ok.out), `no flags: exit 0, checked against the peer list (${ok.code})`);
assert(/matched\s+peer-list entry 127\.0\.0\.1:\d+, roles bootstrap, provider test/.test(ok.out), 'it says which list entry matched');
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

console.log('\n=== 2b. no --expect: the peer list decides ===');
{
  const other = crypto.randomBytes(64).toString('hex');
  // Two entries for this host:port, the right one only in the .local overlay:
  // shipped + .local are merged, and any match passes.
  const twoDir = fs.mkdtempSync(path.join(tmp, 'two-'));
  fs.writeFileSync(path.join(twoDir, 'public-peers.local.json'), JSON.stringify([entry('127.0.0.1', peerNodeId, { provider: 'local-overlay' })]));
  shipped = [entry('127.0.0.1', other, { provider: 'shipped-decoy' })];
  dataDirForCall = twoDir;
  const two = gmpProbe('127.0.0.1', String(port));
  dataDirForCall = null;
  assert(two.code === 0 && /provider local-overlay \(1 of 2 entries for this host:port\)/.test(two.out),
    `two entries for one host:port (shipped + .local): passes on the one that matches, and says which (${two.code})`);

  shipped = [entry('127.0.0.1', other)];
  const mis = gmpProbe('127.0.0.1', String(port));
  assert(mis.code === 4 && mis.out.includes(`expected  ${other}  (peer list)`) && mis.out.includes(`answered  ${peerNodeId}`),
    `only a different NodeID listed: exit 4, both NodeIDs printed (${mis.code})`);

  shipped = [entry('somewhere.example', peerNodeId)];
  const none = gmpProbe('127.0.0.1', String(port));
  assert(none.code === 5 && /NOT IN PEER LIST/.test(none.out), `host:port not listed: exit 5, NOT IN PEER LIST — never a silent pass (${none.code})`);
  assert(field(none.out, 'peer NodeID') === peerNodeId, 'and it still probed, so the operator sees what answered');

  shipped = [entry('localhost', peerNodeId)];
  const byIp = gmpProbe('127.0.0.1', String(port));
  assert(byIp.code === 5, `listed under a hostname, probed by IP: not the listed host:port, exit 5 (${byIp.code})`);

  const REVOKED = '52ab56117354cf7d7f12b8f2de7a428f50462f2146a9cf6c246b21b8c67f7ff357192573bd7944236472b49617edb4e4bff5e7aa8e8eeec1938235caf66afe59';
  shipped = [entry('127.0.0.1', REVOKED)];
  const rev = gmpProbe('127.0.0.1', String(port));
  assert(rev.code === 5, `an entry with a revoked NodeID does not count as listed: exit 5 (${rev.code})`);

  shipped = [entry('127.0.0.1', other)];
  const over = gmpProbe('127.0.0.1', String(port), '--expect', peerNodeId);
  assert(over.code === 0 && /matches --expect/.test(over.out), `--expect overrides the list (${over.code})`);
  const prefix = gmpProbe('127.0.0.1', String(port), '--expect', peerNodeId.slice(0, 16));
  assert(prefix.code === 1 && /prefixes are refused/.test(prefix.out), `a 16-hex prefix is refused: exit 1 (${prefix.code})`);
  shipped = [entry('127.0.0.1', peerNodeId)];
}

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
