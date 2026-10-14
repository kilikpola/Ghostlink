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
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-ssp-${t}-`)); }
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
  console.log('\n=== Part 1.1/1.3: a SEPARATE storage peer (different NodeID, no operator) works + amber ===');
  const network = new MemoryNetwork();
  const H = await makeNode(network, 'ssp bootstrap host');          // bootstrap peer
  const G = await makeNode(network, 'ssp storage peer', { GMP_STORAGE_ENABLED: true }); // separate storage peer
  const C = await makeNode(network, 'ssp client');

  // The client bootstraps via H (so H is "seen"); it never bootstraps via G.
  await C.dial('memory', H.port);
  await delay(100);

  // Honest storage entry: different NodeID, NO operator field (unknown -> amber).
  const gNoOperator = { address: 'memory', port: G.port, nodeId: G.identity.nodeIdHex };
  // Deposit to the separate storage peer SUCCEEDS (not refused)...
  const peer = await deriveIdentityFromSeedPhrase('ssp offline peer');
  const sf = new StoreForward({ host: C, fetchBuckets: 4, ownMailbox: () => gNoOperator });
  sf.learnContact(peer.nodeIdHex, peer.staticPubKey);
  let okId = null, sendErr = null;
  try { okId = (await sf.send(peer.nodeIdHex, 'hi via separate storage peer')).localId; } catch (e) { sendErr = e; }
  assert(okId && !sendErr, `deposit to the separate storage peer SUCCEEDS (${okId || (sendErr && sendErr.message)})`);
  // ...and it is NOT refused by role separation.
  let chkErr = null; try { C.checkStorageHost(gNoOperator); } catch (e) { chkErr = e; }
  assert(chkErr === null, 'the separate storage peer is NOT refused (different NodeID, never bootstrapped through)');
  // ...and the UI separation is amber "unseparated" (no operator = unknown).
  assert(C.storageSeparation(gNoOperator) === 'unseparated', 'separation is "unseparated" -> the amber "Storage not separated" line shows');

  // POSITIVE CONTROL A: a storage entry pointing at the BOOTSTRAP NodeID is refused.
  const gAtBootstrap = { address: 'memory', port: H.port, nodeId: H.identity.nodeIdHex };
  let ctlErr = null; try { C.checkStorageHost(gAtBootstrap); } catch (e) { ctlErr = e; }
  assert(ctlErr instanceof RoleSeparationError && ctlErr.code === 'STORAGE_ON_BOOTSTRAP_HOST',
    `positive control: a storage entry on the bootstrap NodeID is refused (${ctlErr && ctlErr.code})`);

  // POSITIVE CONTROL B: a storage host with a DISTINCT, known operator (never seen) is "separated" -> no amber.
  const gSeparated = { address: 'memory', port: G.port, nodeId: G.identity.nodeIdHex, operator: 'some-other-operator' };
  assert(C.storageSeparation(gSeparated) === 'separated', 'control: a distinct-operator storage host is "separated" (no amber line)');

  for (const n of nodes) { try { n.close?.(); } catch { /* ignore */ } }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('  ✗ uncaught', e && e.stack ? e.stack : e); console.log(`\nResults: ${passed} passed, ${failed + 1} failed`); process.exit(1); });
