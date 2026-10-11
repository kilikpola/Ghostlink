/**
 * strictState by role: unattended hosts default to strict, user clients do
 * not, and an explicit GMP_STRICT_STATE wins. On a strict host with a changed
 * seed, the test runs the command from each refusal message and restarts until
 * the node comes up, counting refusals. Nodes are built as their entry points
 * build them (helpers/production-node-probe.mjs).
 *
 * Run: node test/strict-role-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, 'helpers', 'production-node-probe.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-strictrole-'));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function start(entry, { seed, dataDir, extraEnv = {} }) {
  const env = { ...process.env, PROBE_SEED: seed, GMP_HELLO_TIMEOUT_MS: '500', GMP_HANDSHAKE_TIMEOUT_MS: '500', GMP_LAN_DISCOVERY: 'false', GMP_METRICS_PORT: String(await freePort()), ...extraEnv };
  delete env.GMP_DEBUG_ASSERTS;
  delete env.NODE_ENV;
  delete env.GMP_STRICT_STATE;
  Object.assign(env, extraEnv);
  const port = await freePort();
  if (entry === 'public-peer') env.PORT = String(port); else env.GMP_PORT = String(port);
  if (entry === 'electron') { delete env.GMP_DATA_DIR; env.PROBE_ELECTRON_USERDATA = dataDir; } else env.GMP_DATA_DIR = dataDir;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [probe, entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('PROBE '));
      resolve(line ? JSON.parse(line.slice(6)) : { error: out.slice(-400) });
    });
  });
}

console.log('\n=== 1. role defaults ===');
const cases = [
  ['public-peer', {}, true],
  ['storage-peer', {}, true],
  ['cli', { GMP_RELAY_ENABLED: 'true' }, true],
  ['cli', {}, false],
  ['electron', {}, false],
];
for (const [entry, extraEnv, want] of cases) {
  const r = await start(entry, { seed: `strict role ${entry} ${JSON.stringify(extraEnv)}`, dataDir: path.join(tmp, `role-${entry}-${Object.keys(extraEnv).join('')}`), extraEnv });
  const label = entry + (extraEnv.GMP_RELAY_ENABLED ? ' (relay)' : '');
  assert(!r.error && r.strict === want, `${label}: strict ${want ? 'ON' : 'OFF'} by default (got ${r.strict}${r.error ? `, error ${r.error}` : ''})`);
}

console.log('\n=== 2. an explicit setting beats the role ===');
{
  const r = await start('public-peer', { seed: 'strict role explicit', dataDir: path.join(tmp, 'explicit'), extraEnv: { GMP_STRICT_STATE: 'false' } });
  assert(!r.error && r.strict === false, `public peer with GMP_STRICT_STATE=false runs non-strict (got ${r.strict})`);
}

console.log('\n=== 3. unattended host, seed changed: refuse, then the printed command works ===');
{
  const dir = path.join(tmp, 'seedchange');
  const first = await start('public-peer', { seed: 'strict role original seed', dataDir: dir });
  assert(!first.error, `starts with the original seed${first.error ? ` (${first.error})` : ''}`);
  let r = await start('public-peer', { seed: 'strict role a different seed', dataDir: dir });
  const refusals = [];
  while (r.error && refusals.length < 6) {
    refusals.push(r.error);
    const msg = r.error;
    // The last command offered: the combined one when the refusal lists
    // sibling files sealed under the same seed, else the single-file one.
    const cmds = [...msg.matchAll(/^ {4}(mv '.*)$/gm)].map((m) => m[1]);
    const cmd = cmds[cmds.length - 1];
    if (refusals.length === 1) {
      console.log('  --- first refusal, as the operator sees it ---');
      console.log(msg.split('\n').map((l) => `  | ${l}`).join('\n'));
    }
    assert(/What happened: /.test(msg) && /\nFile: \//.test(msg), `refusal ${refusals.length} says what happened and names the file`);
    assert(/GMP_SEED_PHRASE changed/.test(msg), `refusal ${refusals.length} names the likely cause (seed changed)`);
    assert(/What that gives up: /.test(msg), `refusal ${refusals.length} says what moving it gives up`);
    assert(!!cmd, `refusal ${refusals.length} gives an exact command`);
    if (!cmd) break;
    const sh = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
    assert(sh.status === 0, `running it works: ${cmd.slice(0, 90)}…${sh.status ? ` (${sh.stderr})` : ''}`);
    r = await start('public-peer', { seed: 'strict role a different seed', dataDir: dir });
  }
  assert(!r.error, `after ${refusals.length} refusal(s) and the printed command(s), the node starts${r.error ? ` (still: ${r.error.split('\n')[1]})` : ''}`);
  console.log(`  operator had to act ${refusals.length} time(s)`);
  const moved = fs.readdirSync(dir).filter((f) => f.includes('.refused-'));
  assert(refusals.length === 1, `one refusal covers the whole seed change (${refusals.length})`);
  // peer-cache.json, nonce-state.json, store-forward.state.
  assert(moved.length === 3, `nothing deleted: ${moved.length} file(s) kept aside (${moved.join(', ')})`);
}

console.log('\n=== 3b. one sealed file only: the single-file command, executed verbatim ===');
{
  // Every operator command this code prints is RUN, never string-matched.
  // Section 3 only ever runs the combined command.
  const dir = path.join(tmp, 'single');
  const first = await start('public-peer', { seed: 'strict role single original', dataDir: dir });
  assert(!first.error, 'starts with the original seed');
  for (const f of ['nonce-state.json', 'store-forward.state']) fs.rmSync(path.join(dir, f), { force: true });
  const r = await start('public-peer', { seed: 'strict role single different', dataDir: dir });
  const msg = r.error || '';
  const cmds = [...msg.matchAll(/^ {4}(mv '.*)$/gm)].map((m) => m[1]);
  assert(!/To move them all at once/.test(msg) && cmds.length === 1, `one file, one command (${cmds.length})`);
  const sh = cmds[0] ? spawnSync('sh', ['-c', cmds[0]], { encoding: 'utf8' }) : { status: -1, stderr: 'no command' };
  assert(sh.status === 0, `running it works${sh.status ? ` (${sh.stderr})` : ''}`);
  const again = await start('public-peer', { seed: 'strict role single different', dataDir: dir });
  assert(!again.error, `the node starts${again.error ? ` (still: ${again.error.split('\n')[1]})` : ''}`);
}

console.log('\n=== 3c. fix-access: the diagnostic command, executed verbatim ===');
{
  // A real fix-access refusal needs claims made before the key existed and a
  // failed write; no restart scenario produces it. The command is executed as
  // the real formatter prints it, against a real file whose name needs quoting.
  const { refusalMessage } = await import('../dist/state-refusal.js');
  const dir = path.join(tmp, "fix access, it's here");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nonce-state.json');
  fs.writeFileSync(file, '{}');
  const msg = refusalMessage({ what: 'could not be written.', file, action: 'fix-access' });
  const cmd = (msg.match(/^ {4}(ls -l .*)$/m) || [])[1];
  assert(!!cmd, 'the refusal gives a command');
  const sh = cmd ? spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }) : { status: -1, stdout: '', stderr: 'no command' };
  assert(sh.status === 0, `running it works${sh.status ? ` (${sh.stderr})` : ''}`);
  assert(sh.stdout.includes('nonce-state.json') && /Filesystem|Size|Avail/.test(sh.stdout), 'it lists the file and its volume');
  assert(fs.existsSync(file), 'it moved nothing');
}

console.log('\n=== 4. a user client with a changed seed still starts ===');
{
  const dir = path.join(tmp, 'client-seedchange');
  await start('electron', { seed: 'strict role client original', dataDir: dir });
  const r = await start('electron', { seed: 'strict role client different', dataDir: dir });
  assert(!r.error, `Electron starts after a seed change (strict off)${r.error ? ` (${r.error.split('\n')[0]})` : ''}`);
  // Store-and-forward state holds the outbox: moved aside, never discarded.
  const aside = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /store-forward\.state\.unreadable-/.test(f));
  assert(aside.length === 1, `Electron keeps the unreadable store-and-forward state aside (${aside.join(', ') || 'none'})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
