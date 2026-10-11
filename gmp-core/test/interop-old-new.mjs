/**
 * Old <-> new wire interop over real TCP.
 *
 * "Old" is a pinned commit (default: the deployed build; override with
 * GMP_INTEROP_OLD_REF=<commit>), extracted with `git archive`, installed and
 * built once per commit (cached under the OS temp dir or GMP_INTEROP_CACHE).
 * GMP_INTEROP_OLD_DIR=<gmp-core dir with dist/> uses a pre-built tree instead.
 *
 * Pairings (4 checks each: handshake, greeting, three echoes, echoed lengths):
 *   old -> new, new -> old, old -> new public peer, new -> new public peer,
 *   and new -> new / old -> old as controls.
 * Relay pairing, when the old build has relays: each side reserves on the
 * other's relay, and the relay must never see the reserver's real NodeID.
 *
 * Not a run-all suite; CI runs it in the packaging job.
 * Run: node test/interop-old-new.mjs
 */
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { absenceAsserter } from './helpers/assert-absent.mjs';

/** The deployed public peer's build (2026-10-10). Move deliberately, in its own diff. */
export const INTEROP_OLD_REF = '8ba4f3a7c48182cbd33294166633086bb4722d1f';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const repo = path.join(core, '..');
const runner = path.join(here, 'helpers', 'interop-runner.mjs');
const ref = process.env.GMP_INTEROP_OLD_REF || INTEROP_OLD_REF;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();

// ── the old build ────────────────────────────────────────────────────────
function haveCommit(r) {
  try { sh('git', ['cat-file', '-e', `${r}^{commit}`]); return true; } catch { return false; }
}
let sha, oldCore;
if (process.env.GMP_INTEROP_OLD_DIR) {
  oldCore = path.resolve(process.env.GMP_INTEROP_OLD_DIR);
  sha = `dir:${oldCore}`;
} else {
  if (!haveCommit(ref)) {
    // CI clones shallow: fetch just this commit.
    try { sh('git', ['fetch', '--depth=1', 'origin', ref]); } catch { /* reported below */ }
  }
  if (!haveCommit(ref)) {
    console.error(`✗ interop baseline ${ref} is not in this clone and could not be fetched (fetch the history, e.g. fetch-depth: 0)`);
    process.exit(1);
  }
  sha = sh('git', ['rev-parse', `${ref}^{commit}`]);
  const cacheRoot = process.env.GMP_INTEROP_CACHE || path.join(os.tmpdir(), 'gmp-interop-cache');
  const oldRoot = path.join(cacheRoot, sha);
  oldCore = path.join(oldRoot, 'gmp-core');
  if (!fs.existsSync(path.join(oldCore, 'dist', 'link.js'))) {
    console.log(`building old gmp-core at ${sha.slice(0, 12)} in ${oldRoot} …`);
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.mkdirSync(oldRoot, { recursive: true });
    const tar = execFileSync('git', ['archive', sha, 'gmp-core'], { cwd: repo, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', oldRoot], { input: tar });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: oldCore, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: oldCore, stdio: 'inherit' });
  }
}
const builds = { old: oldCore, new: core };
const oldHasRelay = fs.existsSync(path.join(oldCore, 'dist', 'relay', 'relay-client.js'));

// ── processes ────────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-interop-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });
const peers = path.join(scratch, 'empty-peers.json');
fs.writeFileSync(peers, '[]');
let dirN = 0;
const envFor = (extra = {}) => ({
  ...process.env, GMP_DATA_DIR: fs.mkdtempSync(path.join(scratch, `d${dirN++}-`)), GMP_PUBLIC_PEERS_PATH: peers,
  GMP_LAN_DISCOVERY: 'false', GMP_LOG_LEVEL: 'ERROR', GMP_METRICS_PORT: '0', GMP_RESOURCE_LOG_INTERVAL_MS: '0', ...extra,
});

function startListener(build, kind = 'plain') {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [runner, builds[build], 'listen', kind], { env: envFor(kind === 'relay' ? { GMP_RELAY_ENABLED: 'true' } : {}) });
    let out = '';
    const t = setTimeout(() => reject(new Error(`${build} ${kind} listener did not start: ${out.slice(-300)}`)), 30_000);
    p.stdout.on('data', (d) => { out += d; const m = out.match(/PORT (\d+)/); if (m) { clearTimeout(t); resolve({ p, port: Number(m[1]), out: () => out }); } });
    p.stderr.on('data', (d) => { out += d; });
  });
}
function client(build, mode, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [runner, builds[build], mode, String(port)], { env: envFor() });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => { const m = out.match(/RESULT (.*)/); resolve(m ? JSON.parse(m[1]) : { error: out.slice(-300) }); });
  });
}
const stop = (L) => new Promise((r) => { L.p.on('exit', r); L.p.kill('SIGTERM'); });

let pass = 0, total = 0;
const record = (label, checks, detail) => {
  total += checks.length;
  pass += checks.filter(Boolean).length;
  console.log(`${label.padEnd(28)} ${checks.every(Boolean) ? 'OK  ' : 'FAIL'} ${detail}`);
};
const { assertAbsent } = absenceAsserter((ok, msg) => { total++; if (ok) pass++; console.log(`${''.padEnd(28)} ${ok ? 'OK  ' : 'FAIL'} ${msg}`); });

console.log(`old = ${sha.startsWith('dir:') ? sha : sha.slice(0, 12)}, new = working tree\n`);
for (const [dialer, listener, kind] of [['old', 'new', 'plain'], ['new', 'old', 'plain'], ['old', 'new', 'public'], ['new', 'new', 'public'], ['new', 'new', 'plain'], ['old', 'old', 'plain']]) {
  const L = await startListener(listener, kind);
  const r = await client(dialer, 'dial', L.port);
  await stop(L);
  const strict = (L.out().match(/STRICT \S+ MINPEERS \S+/) || [''])[0];
  record(`${dialer} -> ${listener}${kind === 'public' ? ' public peer' : ''}`, [r.handshake === true, r.helloFromListener === true, r.pongs === r.sent && r.sent === 3, r.lensOk === true], `${JSON.stringify(r)} ${strict}`);
}

if (oldHasRelay) {
  for (const [reserver, relay] of [['new', 'old'], ['old', 'new']]) {
    const L = await startListener(relay, 'relay');
    const r = await client(reserver, 'reserve', L.port);
    await stop(L);
    const seen = [...L.out().matchAll(/^(?:SEEN|LINKED) ([0-9a-f]+)$/gm)].map((m) => m[1]);
    record(`${reserver} reserves on ${relay} relay`, [r.reserved === true], `${JSON.stringify({ reserved: r.reserved, error: r.error, identitiesSeenByRelay: seen.length })}`);
    // The relay emits no 'connection' for relay sessions (this check once
    // passed observing nothing): its control is that it saw the session's
    // throwaway identity.
    assertAbsent({
      channel: `${relay} relay's link identities`,
      control: () => seen.filter((id) => id !== r.me),
      controlMessage: 'the relay saw the reservation\'s throwaway identity',
      absent: () => !!r.me && !seen.includes(r.me),
      message: 'the relay never saw the reserver\'s real NodeID',
    });
  }
} else {
  console.log(`relay pairing               N/A  ${sha.slice(0, 12)} has no relay code (dist/relay absent); applies once a build with relays is the pinned baseline (24 -> 30)`);
}

const expected = oldHasRelay ? 30 : 24; // relay pairings: reserved, control, absence (3 each)
console.log(`\ninterop: ${pass}/${total} checks (expected ${expected} against this baseline)`);
process.exit(pass === total && total === expected ? 0 : 1);
