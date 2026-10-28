/**
 * An unauthenticatable peer-cache / nonce-state file is reported once per
 * start, not once per re-read.
 *
 * Electron's dev run logged state-authentication-failed for both stores 3x in
 * ~3 s on one launch. It was one node, not a double init: the same key is set
 * in the GMPNode constructor and again by loadIdentity (_sealStateAndStart),
 * and peer-cache save() re-reads the file to merge; each read logged.
 *
 *  1. one start + stop over planted unauthenticatable files: exactly one
 *     state-authentication-failed line per store (control: it IS logged)
 *  2. behaviour unchanged: the bad file is still discarded (the cache starts
 *     empty) and under GMP_STRICT_STATE the node still refuses to start
 *  3. a file that changes (re-planted) is reported again
 *
 * Run: node test/state-auth-log-once-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testsPassed = 0, testsFailed = 0;
function assert(c, m) { if (c) { testsPassed++; console.log(`  ✓ ${m}`); } else { testsFailed++; console.error(`  ✗ ${m}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-auth-once-'));
process.env.GMP_PUBLIC_PEERS_PATH = path.join(tmp, 'pp.json');
fs.writeFileSync(process.env.GMP_PUBLIC_PEERS_PATH, '[]');
const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const { electronManagerOptions } = await import('../dist/entry-points.js');
const logger = (await import('../dist/logger.js')).default;
const lines = [];
const orig = logger.error.bind(logger);
logger.error = (c, e, m, meta) => { lines.push({ c, e }); return orig(c, e, m, meta); };
const count = (comp) => lines.filter((l) => l.c === comp && l.e === 'state-authentication-failed').length;

const junk = () => JSON.stringify({ version: 1, iv: crypto.randomBytes(12).toString('hex'), ciphertext: crypto.randomBytes(64).toString('hex') });
const plant = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'peer-cache.json'), junk()); fs.writeFileSync(path.join(dir, 'nonce-state.json'), junk()); };
const mk = (dir, extra = {}) => new GMPNodeManager({ ...electronManagerOptions({ seedPhrase: `auth-once-test:${process.pid}` }), GMP_LAN_DISCOVERY: false, GMP_PORT: 0, disableBootstrap: true, dataDir: dir, ...extra });

console.log('=== 1. one line per store per start ===');
const dir = path.join(tmp, 'a');
plant(dir);
const m = mk(dir);
await m.start();
const cacheEmpty = m.node.peerCache.getCandidates().length === 0;
await m.stop();
assert(count('peer-cache') >= 1 && count('nonce-store') >= 1, `control: both stores reported the bad file (peer-cache ${count('peer-cache')}, nonce-store ${count('nonce-store')})`);
assert(count('peer-cache') === 1, `peer-cache reported it once (saw ${count('peer-cache')})`);
assert(count('nonce-store') === 1, `nonce-store reported it once (saw ${count('nonce-store')})`);

console.log('\n=== 2. behaviour unchanged ===');
assert(cacheEmpty, 'the unauthenticated peer cache was discarded (no candidates)');
const sdir = path.join(tmp, 's');
plant(sdir);
const strict = mk(sdir, { GMP_STRICT_STATE: true });
const refused = await strict.start().then(() => false, () => true);
try { await strict.stop(); } catch { /* never started */ }
assert(refused, 'GMP_STRICT_STATE still refuses to start on the bad file');

console.log('\n=== 3. a changed file is reported again ===');
lines.length = 0;
const d3 = path.join(tmp, 'c');
plant(d3);
const m3 = mk(d3);
await m3.start();
await m3.stop();
plant(d3);
const m4 = mk(d3);
await m4.start();
await m4.stop();
assert(count('peer-cache') === 2 && count('nonce-store') === 2, `two distinct bad files, two reports each (peer-cache ${count('peer-cache')}, nonce-store ${count('nonce-store')})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${testsPassed} passed, ${testsFailed} failed ===`);
process.exit(testsFailed ? 1 : 0);
