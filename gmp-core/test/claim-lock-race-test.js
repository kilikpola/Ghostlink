/**
 * Claim log at-most-once across processes: races real processes on one log
 * and checks for
 *
 *   double claim  a fingerprint more than one process was told it won
 *   lost claim    a fingerprint someone won that is not on disk afterwards
 *
 * Runs against ../dist; CLAIM_RACE_DIST points it at another build.
 *
 * Run with: node test/claim-lock-race-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.env.CLAIM_RACE_DIST || path.join(here, '..', 'dist'));
const child = path.join(here, 'helpers', 'claim-race-child.mjs');
const { NonceStore } = await import(pathToFileURL(path.join(dist, 'nonce-store.js')).href);
const SEED = 'claim lock race seed';
const PROCS = Number(process.env.CLAIM_RACE_PROCS || 16);
const COUNT = Number(process.env.CLAIM_RACE_COUNT || 300);
const ROUNDS = Number(process.env.CLAIM_RACE_ROUNDS || 4);

console.log(`dist: ${dist}`);

async function round(r) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-claimrace-'));
  const stateFile = path.join(dir, 'nonce-state.json');
  const startAt = Date.now() + 3000; // every child has derived its key by then
  const outs = await Promise.all(Array.from({ length: PROCS }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [child, dist, stateFile, SEED, String(startAt), String(COUNT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { e += d; });
    p.on('close', (code) => resolve({ code, o, e }));
  })));

  const winners = new Map();
  for (const out of outs) {
    const line = out.o.split('\n').find((l) => l.startsWith('WON '));
    for (const fp of (line ? line.slice(4).split(',').filter(Boolean) : [])) winners.set(fp, (winners.get(fp) || 0) + 1);
  }
  const doubles = [...winners.values()].filter((n) => n > 1).length;
  const unclaimed = COUNT - winners.size;

  // What survived on disk: a fresh store must refuse every fingerprint anyone won.
  const verifier = new NonceStore({ stateFile, seedPhrase: SEED });
  const peer = Buffer.alloc(64, 7);
  let lost = 0;
  for (const fp of winners.keys()) if (verifier.claimSessionKey(peer, fp).valid) lost++;
  verifier.close?.();

  const errs = outs.filter((o) => o.code !== 0).length;
  const count = (ev) => outs.reduce((n, o) => n + (o.o + o.e).split('\n').filter((l) => l.includes(`"${ev}"`)).length, 0);
  const mismatches = count('claim-log-offset-mismatch');
  const broken = count('stale-lock-broken');
  console.log(`  round ${r}: ${PROCS} processes x ${COUNT} fingerprints: ${doubles} claimed twice or more, ${lost} lost from disk, ${unclaimed} refused by all | locks broken as stale ${broken}, offset-mismatch ${mismatches}, child errors ${errs}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { doubles, lost, errs, broken };
}

console.log('\n=== processes racing on one claim log ===');
const results = [];
for (let r = 1; r <= ROUNDS; r++) results.push(await round(r));
const doubles = results.reduce((n, x) => n + x.doubles, 0);
const lost = results.reduce((n, x) => n + x.lost, 0);
const broken = results.reduce((n, x) => n + x.broken, 0);
console.log(`  locks broken as stale over all rounds: ${broken} (nothing here crashes, so every one of these broke a LIVE holder's lock)`);
assert(results.every((x) => x.errs === 0), 'every contender ran to completion');
assert(broken === 0, `no live lock was broken as stale (${broken})`);
assert(doubles === 0, `no session key was accepted by two processes (${doubles} over ${ROUNDS} rounds)`);
assert(lost === 0, `no acknowledged claim was missing from disk afterwards (${lost} over ${ROUNDS} rounds)`);

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
