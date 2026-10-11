/**
 * Role separation through the merged peer list (shipped list plus
 * public-peers.local.json). One host R is listed as ["relay"] under
 * relay-a.example and ["bootstrap"] under relay-b.example:
 *   1. both in one file: reserve on R, then dial its bootstrap name
 *      -> BOOTSTRAP_VIA_RELAY_HOST before connecting;
 *   2. the same with the entries in different files;
 *   3. the other order -> RESERVE_ON_BOOTSTRAP_HOST.
 *
 * Run: node test/role-separation-merge-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

// paths.ts reads these at import time: set them before any dist module loads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-rolemerge-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const baseFile = path.join(tmp, 'shipped-public-peers.json');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
const localFile = path.join(dataDir, 'public-peers.local.json');
fs.writeFileSync(baseFile, '[]');
process.env.GMP_PUBLIC_PEERS_PATH = baseFile;
process.env.GMP_DATA_DIR = dataDir;

const { createGMPNode } = await import('../dist/node-factory.js');
const { DEFAULTS } = await import('../dist/config.js');
const { MemoryNetwork, MemoryTransport } = await import('../dist/transport/memory-transport.js');
const { RoleSeparationError } = await import('../dist/relay/role-separation.js');

let n = 0;
async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 50, GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 300, ...cfg },
    dataDir: path.join(tmp, `n${n++}`),
    port: 0,
    transport: new MemoryTransport(network),
  });
  node.on('error', () => {});
  await node.loadIdentity(seed);
  return node;
}
const rejection = (p) => p.then(() => null, (e) => e);

async function scenario(label, { shipped, local }) {
  const network = new MemoryNetwork();
  const R = await makeNode(network, `rolemerge relay ${label}`, { GMP_RELAY_ENABLED: true });
  await R.listen();
  let accepted = 0;
  const accept = R._acceptConnection.bind(R);
  R._acceptConnection = (c) => { accepted++; return accept(c); };
  const id = R.identity.nodeIdHex;
  const relayEntry = { address: 'relay-a.example', port: R.port, nodeId: id, roles: ['relay'], operator: '', addedAt: 0 };
  const bootEntry = { address: 'relay-b.example', port: R.port, nodeId: id, roles: ['bootstrap'], operator: '', addedAt: 0 };
  const pick = (which) => which.map((w) => (w === 'relay' ? relayEntry : bootEntry));
  fs.writeFileSync(baseFile, JSON.stringify(pick(shipped)));
  fs.writeFileSync(localFile, JSON.stringify(pick(local)));
  const N = await makeNode(network, `rolemerge client ${label}`);
  return { R, N, id, accepted: () => accepted };
}

console.log('\n=== 1. one file lists R as relay (relay-a) and bootstrap (relay-b) ===');
{
  const { R, N, id, accepted } = await scenario('one-file', { shipped: ['relay', 'bootstrap'], local: [] });
  await N.reserveRelay({ address: 'relay-a.example', port: R.port, nodeId: id });
  const before = accepted();
  const e = await rejection(N.dial('relay-b.example', R.port));
  assert(e instanceof RoleSeparationError && e.code === 'BOOTSTRAP_VIA_RELAY_HOST', `dial to R's bootstrap name refused: ${e && e.code}`);
  assert(accepted() === before, `before connecting (${accepted() - before} new connections at R)`);
  assert(!N.exposure.hasSeen(null, id), 'R never saw the real identity');
}

console.log('\n=== 2. the two names come from different files (shipped: bootstrap, .local: relay) ===');
{
  const { R, N, id, accepted } = await scenario('split', { shipped: ['bootstrap'], local: ['relay'] });
  await N.reserveRelay({ address: 'relay-a.example', port: R.port, nodeId: id });
  const before = accepted();
  const e = await rejection(N.dial('relay-b.example', R.port));
  assert(e instanceof RoleSeparationError && e.code === 'BOOTSTRAP_VIA_RELAY_HOST', `dial to R's shipped bootstrap name refused: ${e && e.code}`);
  assert(accepted() === before, `before connecting, although .local replaced R's shipped entry (${accepted() - before} new connections at R)`);
  assert(!N.exposure.hasSeen(null, id), 'R never saw the real identity');
}

console.log('\n=== 3. the other order: bootstrap through R first, then reserve on it ===');
{
  const { R, N, id } = await scenario('reverse', { shipped: ['relay'], local: ['bootstrap'] });
  await N.dial('relay-b.example', R.port);
  assert(N.exposure.hasSeen(null, id), 'R has now seen the real identity (bootstrap use)');
  const e = await rejection(N.reserveRelay({ address: 'relay-a.example', port: R.port }));
  assert(e instanceof RoleSeparationError && e.code === 'RESERVE_ON_BOOTSTRAP_HOST', `reserving on R's relay name refused: ${e && e.code}`);
}

console.log('\n=== 4. one NodeID with two roles is flagged at load, and kept ===');
{
  const { loadPublicPeers } = await import('../dist/public-peer-list.js');
  const id = 'f'.repeat(128);
  fs.writeFileSync(baseFile, JSON.stringify([
    { address: 'x-relay.example', port: 1, nodeId: id, roles: ['relay'], addedAt: 0 },
    { address: 'x-boot.example', port: 1, nodeId: id, roles: ['bootstrap'], addedAt: 0 },
  ]));
  fs.writeFileSync(localFile, '[]');
  const lines = [];
  const orig = console.warn;
  console.warn = (l) => lines.push(String(l));
  let list;
  try { list = loadPublicPeers(); loadPublicPeers(); } finally { console.warn = orig; }
  const warns = lines.filter((l) => /"event":"one-host-several-roles"/.test(l));
  assert(warns.length === 1, `WARN once, not on every load (${warns.length})`);
  assert(list.filter((e) => e.nodeId === id).length === 2, 'both entries kept, so the separation rules see both names');
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
