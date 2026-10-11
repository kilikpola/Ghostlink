/**
 * withFileLock exclusivity under contention:
 *
 *  1. a fresh empty (half-written) lock is not broken
 *  2. an empty lock older than the stale age is broken
 *  3. a stale lock with a dead owner is broken
 *  4. breaking a stale lock never removes a lock someone else just took
 *  5. stress: N processes read-increment-write under the lock, no lost update
 *
 * Run with: node test/file-lock-race-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { withFileLock, LockTimeoutError } from '../dist/file-lock.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-lockrace-'));

console.log('\n=== 1. a fresh, half-written (empty) lock is not broken ===');
{
  const target = path.join(tmp, 'one');
  fs.writeFileSync(`${target}.lock`, ''); // the holder has opened it and not yet written its record
  let ran = false, err = null;
  try { withFileLock(target, () => { ran = true; }, { timeoutMs: 300 }); } catch (e) { err = e; }
  assert(!ran, `the waiter did not enter the critical section (${ran ? 'it broke the lock and ran' : 'it waited'})`);
  assert(err instanceof LockTimeoutError, `it timed out instead (${err ? err.name : 'no error'})`);
  assert(fs.existsSync(`${target}.lock`), 'the holder\'s lock file is still there');
}

console.log('\n=== 2. an empty lock older than the stale age is broken ===');
{
  const target = path.join(tmp, 'two');
  fs.writeFileSync(`${target}.lock`, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${target}.lock`, old, old);
  let ran = false, err = null;
  try { withFileLock(target, () => { ran = true; }, { timeoutMs: 300, staleMs: 1000 }); } catch (e) { err = e; }
  assert(ran && !err, `crash debris (empty, 60 s old) is cleared and the lock taken${err ? ` (${err.message})` : ''}`);
}

console.log('\n=== 3. a stale lock with a dead owner is broken ===');
{
  const target = path.join(tmp, 'three');
  fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), acquiredAt: Date.now() - 60_000 }));
  let ran = false, err = null;
  try { withFileLock(target, () => { ran = true; }, { timeoutMs: 300, staleMs: 1000 }); } catch (e) { err = e; }
  assert(ran && !err, `a dead owner's old lock is broken${err ? ` (${err.message})` : ''}`);
}

console.log('\n=== 3b. a future-stamped lock (clock stepped back) held by a LIVE process is not broken ===');
{
  const target = path.join(tmp, 'three-b');
  // Our own pid: alive by definition. Stamped 60 s ahead, as if the wall clock
  // was stepped back after the holder took the lock.
  fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() + 60_000, token: 'live' }));
  let ran = false, err = null;
  try { withFileLock(target, () => { ran = true; }, { timeoutMs: 300, staleMs: 1000 }); } catch (e) { err = e; }
  assert(!ran && err instanceof LockTimeoutError, `the live holder keeps its lock across a backward clock step (${ran ? 'it was broken' : 'waiter timed out'})`);
  fs.rmSync(`${target}.lock`, { force: true });
}

async function stress(label, { procs, each, seedStale }) {
  const target = path.join(tmp, label, 'counter');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '0');
  if (seedStale) {
    fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 2 ** 22 + 54321, hostname: os.hostname(), acquiredAt: Date.now() - 120_000 }));
  }
  const script = `
    import fs from 'fs';
    import { withFileLock } from ${JSON.stringify(path.join(here, '..', 'dist', 'file-lock.js'))};
    const seen = [];
    // Start together: spin until the shared start time so the processes contend.
    while (Date.now() < ${Date.now() + 600}) {}
    for (let i = 0; i < ${each}; i++) {
      seen.push(withFileLock(${JSON.stringify(target)}, () => {
        const n = Number(fs.readFileSync(${JSON.stringify(target)}, 'utf8')) + 1;
        fs.writeFileSync(${JSON.stringify(target)}, String(n));
        return n;
      }, { timeoutMs: 20000, staleMs: 1000 }));
    }
    console.log(seen.join(','));
  `;
  const outs = await Promise.all(Array.from({ length: procs }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { e += d; });
    p.on('close', (code) => resolve({ code, o: o.trim(), e }));
  })));
  const values = outs.flatMap((r) => (r.o ? r.o.split(',') : []));
  const distinct = new Set(values).size;
  const final = Number(fs.readFileSync(target, 'utf8'));
  for (const r of outs) if (r.code !== 0) console.error(`  child failed: ${r.e.split('\n').filter((l) => !l.startsWith('{"ts')).slice(0, 2).join(' | ')}`);
  console.log(`  ${procs} processes x ${each}: ${values.length} increments returned, ${distinct} distinct, final counter ${final}`);
  return { ok: outs.every((r) => r.code === 0), values: values.length, distinct, final, expected: procs * each };
}

console.log('\n=== 4. racing to break one stale lock never removes a fresh one ===');
for (let round = 0; round < 5; round++) {
  const r = await stress(`stale-${round}`, { procs: 12, each: 5, seedStale: true });
  assert(r.ok && r.distinct === r.expected && r.final === r.expected,
    `round ${round + 1}: no two processes inside at once after the stale lock is broken (${r.expected - r.distinct} duplicates, final ${r.final}/${r.expected})`);
}

console.log('\n=== 5. stress: read-increment-write under the lock loses nothing ===');
{
  const r = await stress('stress', { procs: 10, each: 60, seedStale: false });
  assert(r.ok && r.distinct === r.expected && r.final === r.expected,
    `${r.expected} locked increments: ${r.expected - r.distinct} duplicates, final ${r.final}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
