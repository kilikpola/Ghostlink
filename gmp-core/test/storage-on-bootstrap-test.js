import './helpers/isolate-data.mjs'; // must stay first
import { createGMPNode } from '../dist/node-factory.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';
import { deriveIdentityFromSeedPhrase } from '../dist/identity.js';
import { StoreForward } from '../dist/storage/store-forward.js';
import { RoleSeparationError } from '../dist/relay/role-separation.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-sob-${t}-`)); }
const nodes = [];
async function makeNode(network, seed, cfg = {}) {
  const node = createGMPNode({ config: cfg, dataDir: tmp(seed.replace(/\W+/g, '-')), port: 0, transport: new MemoryTransport(network), disableBootstrap: true });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  await node.listen();
  return node;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n=== Part 1.1: can a client use its BOOTSTRAP host as storage? ===');
  const network = new MemoryNetwork();
  // H: the Railway-shaped peer — bootstrap AND storage, same NodeID/operator.
  const H = await makeNode(network, 'rc1 bootstrap+storage host', { GMP_STORAGE_ENABLED: true });
  // S: a separate storage host the client never bootstraps through.
  const S = await makeNode(network, 'rc1 separate storage host', { GMP_STORAGE_ENABLED: true });
  const C = await makeNode(network, 'rc1 client');

  // The client bootstraps via H (a normal, non-relayed connection) — exactly
  // what every client does against the single public peer.
  await C.dial('memory', H.port);
  await delay(100);

  const hAddr = { address: 'memory', port: H.port, nodeId: H.identity.nodeIdHex, operator: 'railway' };
  const sAddr = { address: 'memory', port: S.port, nodeId: S.identity.nodeIdHex, operator: 'railway' };

  // checkStorageHost REFUSES the bootstrap host...
  let refusal = null;
  try { C.checkStorageHost(hAddr); } catch (e) { refusal = e; }
  assert(refusal instanceof RoleSeparationError && refusal.code === 'STORAGE_ON_BOOTSTRAP_HOST',
    `using the bootstrap host as storage is REFUSED (${refusal && refusal.code})`);
  // ...yet the UI separation for it is "unseparated" (amber) — the contradiction.
  assert(C.storageSeparation(hAddr) === 'unseparated', 'the UI would show amber "unseparated" for that same host');

  // Positive control: a host the client never bootstrapped through is usable.
  let ctlErr = null;
  try { C.checkStorageHost(sAddr); } catch (e) { ctlErr = e; }
  assert(ctlErr === null, 'positive control: a separate (never-bootstrapped) storage host is NOT refused');

  // End to end through StoreForward: a real deposit to H is refused; to S it is not.
  const peer = await deriveIdentityFromSeedPhrase('rc1 offline peer');
  const sfToH = new StoreForward({ host: C, fetchBuckets: 4, ownMailbox: () => hAddr });
  sfToH.learnContact(peer.nodeIdHex, peer.staticPubKey);
  let sendErr = null;
  try { await sfToH.send(peer.nodeIdHex, 'hello via bootstrap host'); } catch (e) { sendErr = e; }
  assert(sendErr && /STORAGE_ON_BOOTSTRAP_HOST|bootstrap/i.test(sendErr.code || sendErr.message),
    `depositing to the bootstrap host fails end-to-end (${sendErr && (sendErr.code || sendErr.message)})`);

  const sfToS = new StoreForward({ host: C, fetchBuckets: 4, ownMailbox: () => sAddr });
  sfToS.learnContact(peer.nodeIdHex, peer.staticPubKey);
  let okId = null;
  try { okId = (await sfToS.send(peer.nodeIdHex, 'hello via separate host')).localId; } catch (e) { okId = `ERR:${e.message}`; }
  assert(typeof okId === 'string' && !okId.startsWith('ERR:'), `positive control: depositing to a separate storage host succeeds (${okId})`);

  for (const n of nodes) { try { n.close?.(); } catch { /* ignore */ } }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e && e.stack ? e.stack : e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
