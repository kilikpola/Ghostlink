import './helpers/isolate-data.mjs'; // must stay first
import { createGMPNode } from '../dist/node-factory.js';
import crypto from 'crypto';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-switch-${t}-`)); }
const STRICT = { GMP_STRICT_STATE: true };

async function run() {
  console.log('\n=== item 3: switching identity path on one data dir refuses, operator command recovers ===');
  const dir = tmp('d');
  const phrase = 'identity path switch test seed phrase one';
  const derivedSeed = new Uint8Array(crypto.randomBytes(32));

  // 1) Seal state under the PHRASE path (strict), writing peer-cache.json.
  const n1 = createGMPNode({ seedPhrase: phrase, dataDir: dir, config: STRICT, port: 0, disableBootstrap: true });
  await n1.loadIdentity(phrase);
  n1.peerCache.recordSuccess('c'.repeat(128), '127.0.0.1', 4321, 'd'.repeat(64));
  assert(fs.existsSync(path.join(dir, 'peer-cache.json')), 'phrase path sealed peer-cache.json on disk');

  // 2) Open the SAME data dir via the derivedSeed path (different sealing key),
  //    strict: must refuse with an operator-actionable message, not silently.
  let refusal = null;
  try {
    const n2 = createGMPNode({ derivedSeed, dataDir: dir, config: STRICT, port: 0, disableBootstrap: true });
    n2.loadIdentityFromDerivedSeed();
  } catch (e) {
    refusal = e;
  }
  assert(refusal !== null, 'switching to the derivedSeed path on phrase-sealed state refuses to start');
  assert(refusal && /Refusing to start/.test(refusal.message), 'the refusal is the operator-actionable message');

  // 3) EXECUTE the printed command(s) verbatim (never string-match the action).
  const mvCommands = [...new Set((refusal.message.match(/mv '[^']+' '[^']+'/g) || []))];
  assert(mvCommands.length >= 1, 'the refusal prints at least one mv command to run');
  let ran = 0;
  for (const cmd of mvCommands) {
    try { execSync(cmd, { stdio: 'ignore' }); ran++; } catch { /* a later dup whose source already moved */ }
  }
  assert(ran >= 1, 'ran the printed mv command verbatim');
  assert(!fs.existsSync(path.join(dir, 'peer-cache.json')), 'the printed command moved the un-authenticatable file aside');

  // 4) After running it, the derivedSeed node starts (fresh state), still strict.
  let started = null, startErr = null;
  try {
    const n3 = createGMPNode({ derivedSeed, dataDir: dir, config: STRICT, port: 0, disableBootstrap: true });
    started = n3.loadIdentityFromDerivedSeed();
  } catch (e) { startErr = e; }
  assert(startErr === null && started && started.nodeIdHex, 'the node starts after running the operator command');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e && e.stack ? e.stack : e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
