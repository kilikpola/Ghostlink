/**
 * The shipped public peer list (read from the package) and local overlays
 * (DATA_DIR/public-peers.json, then public-peers.local.json): per NodeID the
 * higher file wins; exact repeats collapse; one host under several hostnames
 * keeps all of them; revoked NodeIDs are dropped.
 *
 * Run: node test/public-peers-merge-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const repo = path.join(core, '..');
const shipped = path.join(core, 'data', 'public-peers.json');
const RAILWAY = '562c487c1a10a649179dd7b131527344c9f6bd65e7ebc800b6570dd496371f65b25aec43d1d1eb3937de2bf74e3ce45f7777e6375561f26ec26215f31301ea3a';
const REVOKED = '52ab56117354cf7d7f12b8f2de7a428f50462f2146a9cf6c246b21b8c67f7ff357192573bd7944236472b49617edb4e4bff5e7aa8e8eeec1938235caf66afe59';
const id = (c) => c.repeat(128);
const entry = (nodeId, address, extra = {}) => ({ address, port: 49500, tls: false, nodeId, roles: ['bootstrap'], operator: '', provider: 'test', addedAt: 1, ...extra });

console.log('\n=== 1. the shipped list is committed and carries no secret ===');
{
  const tracked = execFileSync('git', ['ls-files', '--', 'gmp-core/data/public-peers.json'], { cwd: repo }).toString().trim();
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', 'gmp-core/data/public-peers.json'], { cwd: repo }); } catch { ignored = false; }
  assert(!ignored, 'gmp-core/data/public-peers.json is not gitignored');
  console.log(`  (tracked now: ${tracked ? 'yes' : 'no — not committed yet; nothing is staged in this task'})`);
  const list = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  assert(list.some((e) => e.nodeId === RAILWAY && e.address === 'hayabusa.proxy.rlwy.net' && e.port === 58516), 'it names the Railway public peer under its current NodeID');
  const { containsSeedPhrase } = await import('../dist/seed-guard.js');
  const allowed = new Set(['address', 'port', 'tls', 'nodeId', 'roles', 'operator', 'provider', 'addedAt', 'lastVerified']);
  assert(list.every((e) => Object.keys(e).every((k) => allowed.has(k))), 'entries hold only public fields');
  assert(!containsSeedPhrase(fs.readFileSync(shipped, 'utf8')), 'no seed phrase in it');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'electron', 'package.json'), 'utf8'));
  const res = JSON.stringify(pkg.build || {});
  assert(res.includes('gmp-core/data/public-peers.json'), 'Electron packages public-peers.json');
  assert(!res.includes('public-peers.example.json'), 'Electron no longer packages the example as its list');
  const example = JSON.parse(fs.readFileSync(path.join(core, 'data', 'public-peers.example.json'), 'utf8'));
  assert(example.every((e) => /\.invalid$/.test(e.address) && /^0+$/.test(e.nodeId)), 'the example documents the schema with an obviously fake entry');
}

// Fresh module state per scenario: paths.ts reads the environment at import.
async function loadWith({ base, dataDir, legacy, local, env = {} }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-pplist-'));
  const dir = dataDir ?? path.join(d, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const baseFile = path.join(d, 'base.json');
  if (base) fs.writeFileSync(baseFile, JSON.stringify(base));
  if (legacy) fs.writeFileSync(path.join(dir, 'public-peers.json'), JSON.stringify(legacy));
  if (local) fs.writeFileSync(path.join(dir, 'public-peers.local.json'), typeof local === 'string' ? local : JSON.stringify(local));
  const script = `
    const { loadPublicPeers } = await import(${JSON.stringify(path.join(core, 'dist', 'public-peer-list.js'))});
    console.log(JSON.stringify(loadPublicPeers()));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, GMP_DATA_DIR: dir, GMP_PUBLIC_PEERS_PATH: base ? baseFile : '', GMP_LOG_LEVEL: 'CRITICAL', ...env },
  }).toString().trim().split('\n').pop();
  fs.rmSync(d, { recursive: true, force: true });
  return JSON.parse(out);
}

console.log('\n=== 2. a node whose state lives elsewhere still sees the shipped list ===');
{
  const list = await loadWith({});
  assert(list.some((e) => e.nodeId === RAILWAY), `GMP_DATA_DIR set, no GMP_PUBLIC_PEERS_PATH: the shipped Railway entry is loaded (${list.length} entr${list.length === 1 ? 'y' : 'ies'})`);
}

console.log('\n=== 3. merge: precedence by NodeID, exact repeats collapse, aliases stay ===');
{
  const A = id('a'), B = id('b'), C = id('c'), E = id('e');
  const list = await loadWith({
    base: [
      entry(A, 'base-a.example'),
      entry(B, 'base-b.example'), entry(B, 'base-b.example'),   // exact repeat
      entry(E, 'e-relay.example', { roles: ['relay'] }), entry(E, 'e-boot.example'),   // one host, two names
    ],
    local: [entry(A.toUpperCase(), 'local-a.example'), entry(C, 'local-c.example')],
  });
  const of = (n) => list.filter((e) => e.nodeId.toLowerCase() === n).map((e) => e.address);
  console.log(`  merged: ${list.map((e) => e.address).join(', ')}`);
  assert(of(A).join() === 'local-a.example', 'the overlay replaces every shipped entry for its NodeID (case-insensitive)');
  assert(of(B).join() === 'base-b.example', 'an exact repeat within one file collapses to one');
  assert(of(E).join() === 'e-relay.example,e-boot.example', 'one host under two hostnames (different roles) keeps both entries');
  assert(of(C).join() === 'local-c.example', 'an overlay-only peer is added');
  assert(list.map((e) => e.nodeId.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).join() === [A, B, E, C].join(), 'order: shipped NodeIDs first, in their order, then additions');
}

console.log('\n=== 4. the old location is an overlay, below .local ===');
{
  const A = id('a'), D = id('d');
  const list = await loadWith({
    base: [entry(A, 'base-a.example')],
    legacy: [entry(A, 'legacy-a.example'), entry(D, 'legacy-d.example')],
    local: [entry(D, 'local-d.example')],
  });
  const by = Object.fromEntries(list.map((e) => [e.nodeId, e]));
  assert(by[A] && by[A].address === 'legacy-a.example', 'DATA_DIR/public-peers.json overrides the shipped entry');
  assert(by[D] && by[D].address === 'local-d.example', '.local overrides DATA_DIR/public-peers.json');
}

console.log('\n=== 5. revoked NodeIDs never load ===');
{
  const list = await loadWith({ base: [entry(id('a'), 'base-a.example')], local: [entry(REVOKED, 'hayabusa.proxy.rlwy.net')] });
  assert(!list.some((e) => e.nodeId.toLowerCase() === REVOKED), 'a revoked NodeID in the overlay is dropped');
  assert(list.length === 1, 'the rest still loads');
}

console.log('\n=== 6. a broken overlay does not cost the shipped list ===');
{
  const list = await loadWith({ base: [entry(id('a'), 'base-a.example')], local: '{ not json' });
  assert(list.length === 1 && list[0].address === 'base-a.example', 'unparseable .local: shipped entries still load');
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
