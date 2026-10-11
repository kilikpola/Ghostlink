/**
 * Boot counter on the production construction path (no dataDir):
 *
 *  1. manager with no dataDir, started twice -> the boot counter advances
 *  2. an unparseable counter file -> refused, not reset to 0
 *  3. an unreadable counter file -> refused, not reset to 0
 *  4. concurrent processes advancing one counter file -> every value distinct
 *
 * Run with: node test/boot-counter-production-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { advanceBootCounter, BootCounterError } from '../dist/boot-counter.js';
import { MemoryTransport } from '../dist/transport/memory-transport.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-bootctr-'));

async function bootOnce(seed) {
  const manager = new GMPNodeManager({
    seedPhrase: seed,
    GMP_PORT: 0,
    GMP_LAN_DISCOVERY: false,
    GMP_METRICS_ENABLED: false,
    disableBootstrap: true,
    transport: new MemoryTransport(),
  });
  await manager.start();
  const node = manager.node;
  const boot = node.ephemeralSource ? node.ephemeralSource.boot : null;
  const dataDir = node.dataDir;
  await manager.stop();
  return { boot, dataDir };
}

console.log('\n=== 1. production path (manager, no dataDir): the counter advances across restarts ===');
{
  const a = await bootOnce('boot counter production seed');
  const b = await bootOnce('boot counter production seed');
  const c = await bootOnce('boot counter production seed');
  console.log(`  node.dataDir=${a.dataDir}  boots: ${a.boot}, ${b.boot}, ${c.boot}`);
  assert(a.dataDir === null, 'the node really was built without a dataDir (the shipped shape)');
  assert(a.boot !== null && b.boot !== null && c.boot !== null, 'every start has an ephemeral source');
  assert(b.boot > a.boot && c.boot > b.boot, `the boot counter strictly increases across restarts (${a.boot} < ${b.boot} < ${c.boot})`);
}

console.log('\n=== 2. existing counter file that does not parse -> refused ===');
{
  const f = path.join(tmp, 'garbled', 'boot-counter');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'not a number\n');
  let err = null, got = null;
  try { got = advanceBootCounter(f); } catch (e) { err = e; }
  assert(err instanceof BootCounterError, `a garbled counter throws BootCounterError instead of restarting at 0 (got ${err ? err.name : `value ${got}`})`);
  assert(fs.readFileSync(f, 'utf8') === 'not a number\n', 'the garbled file is left untouched for inspection');
}

console.log('\n=== 3. existing counter file that cannot be read -> refused ===');
if (process.getuid && process.getuid() === 0) {
  console.log('  ~ running as root: permission bits do not block reads; skipped');
} else {
  const f = path.join(tmp, 'unreadable', 'boot-counter');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '41\n');
  fs.chmodSync(f, 0o000);
  let err = null, got = null;
  try { got = advanceBootCounter(f); } catch (e) { err = e; }
  fs.chmodSync(f, 0o600);
  assert(err instanceof BootCounterError, `an unreadable counter throws BootCounterError instead of restarting at 0 (got ${err ? err.name : `value ${got}`})`);
  assert(fs.readFileSync(f, 'utf8') === '41\n', 'the unreadable file is left untouched');
}

console.log('\n=== 4. concurrent processes sharing one counter file -> all values distinct ===');
{
  const f = path.join(tmp, 'shared', 'boot-counter');
  const PROCS = 8, EACH = 25;
  const script = `
    import { advanceBootCounter } from ${JSON.stringify(path.join(here, '..', 'dist', 'boot-counter.js'))};
    const out = [];
    for (let i = 0; i < ${EACH}; i++) out.push(String(advanceBootCounter(${JSON.stringify(f)})));
    console.log(out.join(','));
  `;
  const outs = await Promise.all(Array.from({ length: PROCS }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { e += d; });
    p.on('close', (code) => resolve({ code, o: o.trim(), e }));
  })));
  const values = outs.flatMap((r) => (r.o ? r.o.split(',') : []));
  const distinct = new Set(values);
  for (const r of outs) if (r.code !== 0) console.error(`  child failed: ${r.e.split('\n')[0]}`);
  console.log(`  ${values.length} values handed out, ${distinct.size} distinct, final file ${fs.readFileSync(f, 'utf8').trim()}`);
  assert(outs.every((r) => r.code === 0), 'every child process advanced the counter without error');
  assert(values.length === PROCS * EACH && distinct.size === values.length, `no value handed to two processes (${values.length - distinct.size} duplicates)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
