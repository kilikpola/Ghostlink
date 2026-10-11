/**
 * Startup claim-log diagnostic:
 *
 *  1. finds duplicate claims in a real sealed log; skips a log sealed under
 *     another identity
 *  2. strictly read-only: every fs mutation is trapped and must record zero
 *     calls; every file is byte-, size-, mtime- and inode-identical after
 *  3. `gmp public-peer` logs the verdict before the node starts, then its
 *     first resource sample
 *
 * Run: node test/claim-log-diagnostic-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { inspectClaimLogs, describeClaimLogReport } from '../dist/claim-log-diagnostic.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-cldiag-'));
const SEED = 'claim log diagnostic seed phrase one two three four five six';
const OTHER = 'claim log diagnostic another identity entirely seven eight nine';

/** Seal claim records exactly as claim-log.ts does. */
function sealLog(seed, fingerprints) {
  const key = crypto.pbkdf2Sync(seed, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const parts = fingerprints.map((f, i) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from('gmp-nonce-claim-v1'));
    const ct = Buffer.concat([c.update(JSON.stringify({ f, p: 'peer', t: 1_790_000_000_000 + i })), c.final()]);
    const body = Buffer.concat([iv, c.getAuthTag(), ct]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
  });
  const id = crypto.createHash('sha256').update('gmp-claim-log-id').update(key).digest('hex').slice(0, 16);
  return { name: `nonce-claims.${id}.log`, bytes: Buffer.concat(parts) };
}

const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const fp = (n) => crypto.createHash('sha256').update(`fp ${n}`).digest('hex');
const mine = sealLog(SEED, [fp(1), fp(2), fp(3), fp(2), fp(4), fp(3), fp(3)]); // fp2 x2, fp3 x3
const theirs = sealLog(OTHER, [fp(9)]);
fs.writeFileSync(path.join(dataDir, mine.name), mine.bytes);
fs.writeFileSync(path.join(dataDir, theirs.name), theirs.bytes);
fs.writeFileSync(path.join(dataDir, 'boot-counter'), '7\n');

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[p] = 'dir'; walk(p); continue; }
      const st = fs.statSync(p);
      out[p] = `${st.size}|${st.mtimeMs}|${st.ino}|${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

console.log('\n=== 1 + 2. the check finds duplicates, and touches nothing ===');
{
  const before = snapshot(dataDir);
  const trapped = [];
  const MUTATORS = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'renameSync', 'rename', 'unlinkSync', 'unlink',
    'rmSync', 'rm', 'rmdirSync', 'mkdirSync', 'mkdir', 'mkdtempSync', 'truncateSync', 'ftruncateSync', 'copyFileSync', 'cpSync',
    'linkSync', 'symlinkSync', 'chmodSync', 'chownSync', 'utimesSync', 'writeSync', 'createWriteStream'];
  const saved = {};
  for (const m of MUTATORS) {
    if (typeof fs[m] !== 'function') continue;
    saved[m] = fs[m];
    fs[m] = (...a) => { trapped.push(`${m}(${String(a[0]).slice(0, 60)})`); throw new Error(`read-only diagnostic called fs.${m}`); };
  }
  saved.openSync = fs.openSync;
  fs.openSync = (p, flags = 'r', ...rest) => {
    if (flags !== 'r' && flags !== fs.constants.O_RDONLY) trapped.push(`openSync(${p}, ${flags})`);
    return saved.openSync(p, flags, ...rest);
  };
  let report, err = null;
  try { report = inspectClaimLogs(dataDir, SEED); } catch (e) { err = e; }
  for (const [m, f] of Object.entries(saved)) fs[m] = f;

  assert(!err, `the check ran${err ? ` (${err.message})` : ''}`);
  // The same trap, reinstalled, must catch a real gmp-core writer that
  // imports fs the way the diagnostic does — else "nothing trapped" is vacuous.
  const { writeFileAtomicSync } = await import('../dist/atomic-file.js');
  assertAbsent({
    channel: 'fs mutation trap',
    control: () => {
      const caught = [];
      const keep = {};
      for (const m of MUTATORS) {
        if (typeof fs[m] !== 'function') continue;
        keep[m] = fs[m];
        fs[m] = () => { caught.push(m); throw new Error(`trapped fs.${m}`); };
      }
      keep.openSync = fs.openSync;
      fs.openSync = (p, flags = 'r', ...rest) => { if (flags !== 'r' && flags !== fs.constants.O_RDONLY) caught.push('openSync'); return keep.openSync(p, flags, ...rest); };
      try { writeFileAtomicSync(path.join(os.tmpdir(), `gmp-trap-control-${process.pid}`), 'x'); } catch { /* trapped */ }
      for (const [m, fn] of Object.entries(keep)) fs[m] = fn;
      return caught;
    },
    controlMessage: 'the trap catches writeFileAtomicSync',
    absent: () => trapped.length === 0,
    message: `no fs mutation was attempted (${trapped.length}${trapped.length ? ': ' + trapped.join(', ') : ''})`,
  });
  const after = snapshot(dataDir);
  assert(JSON.stringify(before) === JSON.stringify(after), 'every file is byte-, size-, mtime- and inode-identical afterwards; nothing added or removed');
  if (report) {
    console.log(`  ${describeClaimLogReport(report)}`);
    assert(report.verdict === 'duplicates', `verdict: duplicates (${report.verdict})`);
    const f = report.files[0];
    assert(report.files.length === 1 && f.records === 7 && f.distinct === 4, `records 7, distinct 4 (${f?.records}, ${f?.distinct})`);
    assert(f.duplicates.length === 2 && f.duplicates.some((d) => d.count === 3), `two fingerprints duplicated, one of them three times (${JSON.stringify(f.duplicates.map((d) => d.count))})`);
    assert(report.otherIdentity === 1, `the other identity's log is skipped, not judged (${report.otherIdentity})`);
    assert(report.bootCounter === '7', `boot counter reported (${report.bootCounter})`);
    const named = Array.from({ length: 16 }, (_, i) => fp(i)).filter((x) => f.duplicates.some((d) => x.startsWith(d.prefix)));
    assertAbsent({
      channel: 'report JSON',
      control: () => named.length === 2 && named.every((x) => JSON.stringify(report).includes(x.slice(0, 12))) && named,
      controlMessage: 'the report names the duplicated fingerprints by prefix',
      absent: () => named.every((x) => !JSON.stringify(report).includes(x)) && !JSON.stringify(report).includes(fp(2)),
      message: 'full fingerprints never appear in the report (prefixes only)',
    });
  }
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

console.log('\n=== 3. the real `gmp public-peer` logs both, early ===');
{
  const peers = path.join(tmp, 'peers.json');
  fs.writeFileSync(peers, '[]');
  const env = {
    ...process.env,
    GMP_SEED_PHRASE: SEED,
    GMP_DATA_DIR: dataDir,
    PORT: String(await freePort()),
    GMP_BRIDGE_PORT: String(await freePort()),
    GMP_METRICS_PORT: String(await freePort()),
    GMP_LAN_DISCOVERY: 'false',
    GMP_PUBLIC_PEERS_PATH: peers,
  };
  delete env.GMP_DEBUG_ASSERTS;
  delete env.NODE_ENV;
  const t0 = Date.now();
  const p = spawn(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'public-peer'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = {};
  const lines = [];
  await new Promise((resolve) => {
    const onData = (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        lines.push(line);
        const at = Date.now() - t0;
        if (line.includes('"claim-log-check"') && !seen.check) seen.check = { at, line, idx: lines.length };
        if (line.includes('"resource-sample"') && !seen.resource) seen.resource = { at, line, idx: lines.length };
        if (/GMP Node successfully started/.test(line) && !seen.started) seen.started = { at, idx: lines.length };
      }
      if (seen.check && seen.resource && seen.started) resolve();
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    setTimeout(resolve, 20000);
  });
  p.kill('SIGTERM');
  assert(!!seen.check, `the claim-log verdict is logged (${seen.check ? `${seen.check.at} ms after launch` : 'never'})`);
  assert(!!seen.check && /DUPLICATE CLAIMS FOUND/.test(seen.check.line), 'and says what it found');
  assert(!!seen.check && !!seen.started && seen.check.idx < seen.started.idx, 'it runs before the node starts (before the log can be compacted)');
  assert(!!seen.resource, `a resource sample is logged without waiting for traffic (${seen.resource ? `${seen.resource.at} ms after launch` : 'never'})`);
  assert(!!seen.resource && /distinctAddresses/.test(seen.resource.line), 'and carries the distinct-client-address count');
  if (!seen.check || !seen.resource) console.error(lines.slice(-10).join('\n'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
