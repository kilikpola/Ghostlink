/**
 * Self-hosted storage peer, end to end over real TCP: `node dist/cli.js
 * storage-peer` plus two GMPNodeManagers configured with GMP_SF_STORAGE_PEER.
 *
 *  1. the storage peer starts, prints its port and NodeID, needs no bridge
 *  2. A and B meet once directly and learn each other's keys and mailboxes
 *  3. B goes offline; A sends: SENT (stored) from the storage peer's ACK
 *  4. B comes back and polls on "foreground": the message arrives, via mailbox
 *  5. B's next poll deposits a sealed receipt; A polls on "network": DELIVERED
 *  6. the storage peer never saw A's or B's NodeID; status says self-hosted,
 *     separated
 *
 * Run: node test/storage-selfhost-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { spawn } from 'child_process';
import crypto from 'crypto';
import { PeerCache } from '../dist/peer-cache.js';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';

let testsPassed = 0;
let testsFailed = 0;
function assert(condition, message) {
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); } else { testsFailed++; console.error(`  ✗ ${message}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-selfhost-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const once = (em, ev, pred = () => true, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { em.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = (e) => { if (pred(e)) { clearTimeout(t); em.off(ev, h); resolve(e); } };
  em.on(ev, h);
});

const STORAGE_SEED = 'storage peer self host test one two three four five six seven';
let child = null;
const managers = [];
process.on('exit', () => {
  try { if (child) child.kill('SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function startStoragePeer() {
  const port = await freePort();
  const env = {
    ...process.env,
    GMP_SEED_PHRASE: STORAGE_SEED,
    GMP_PORT: String(port),
    GMP_DATA_DIR: path.join(tmp, 'storage-peer'),
    GMP_METRICS_PORT: String(await freePort()),
    GMP_LOG_TO_CONSOLE: 'false',
  };
  child = spawn(process.execPath, [path.join(here, '..', 'dist', 'cli.js'), 'storage-peer'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/NodeID [0-9a-f]{128}/.test(out); i++) await delay(100);
  const nodeId = (/NodeID ([0-9a-f]{128})/.exec(out) || [])[1];
  return { port, nodeId, out };
}

async function manager(name, spec) {
  const m = new GMPNodeManager({
    seedPhrase: `self host test ${name} seed phrase words`,
    dataDir: path.join(tmp, name),
    GMP_PORT: 0,
    GMP_LAN_DISCOVERY: false,
    GMP_METRICS_PORT: await freePort(),
    GMP_SF_STORAGE_PEER: spec,
    GMP_PUBLIC_PEERS_PATH: path.join(tmp, 'no-public-peers.json'),
    disableBootstrap: true,
  });
  managers.push(m);
  await m.start();
  return m;
}

async function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GM-N2-6 — Self-hosted Storage Peer (real TCP) Test        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    console.log('\n=== 1. gmp storage-peer ===');
    const sp = await startStoragePeer();
    assert(!!sp.nodeId && /listening on port/.test(sp.out) && /GMP_SF_STORAGE_PEER=/.test(sp.out),
      `started, printed its port, NodeID and the client setting:\n${sp.out.split('\n').filter((l) => /^(GMP|NodeID|bucket|Clients)/.test(l)).map((l) => '      ' + l).join('\n')}`);
    const spec = `127.0.0.1:${sp.port}#${sp.nodeId}`;

    console.log('\n=== 2. A and B meet once ===');
    const A = await manager('alice', spec);
    let B = await manager('bob', spec);
    const aId = A.node.identity.nodeIdHex;
    const bId = B.node.identity.nodeIdHex;
    A.setMailboxContacts([bId]);
    B.setMailboxContacts([aId]);
    await A.connectToPeer('127.0.0.1', B.node.port);
    await delay(300);
    const mb = A.storeForward.state?.contacts?.[bId]?.mailbox ?? JSON.parse(JSON.stringify(A.storeForward))?.state?.contacts?.[bId]?.mailbox;
    assert(mb && mb.port === sp.port && mb.nodeId === sp.nodeId, `B told A its mailbox end to end (${mb ? `${mb.address}:${mb.port}` : 'none'})`);

    console.log('\n=== 3. B offline; A sends ===');
    await B.stop();
    const stored = once(A, 'sf-stored', (e) => e.localId === 'offline-1');
    const payload = JSON.stringify({ type: 'queued-message', sealed: 'opaque-app-layer', blockHash: 'h1' });
    await A.storeForwardSend(bId, payload, 'offline-1');
    const s = await stored;
    assert(s.destNodeId === bId, 'SENT (stored): the storage peer acknowledged the deposit');

    console.log('\n=== 4. B returns and polls on foreground ===');
    B = await manager('bob', spec);
    B.setMailboxContacts([aId]);
    let m = null;
    B.on('message', (x) => { if (x.via === 'mailbox') m = x; });
    // A poll covers 4 buckets; one rotation of B's fetch set reaches A's channel.
    const rotation = (mgr) => Math.ceil(mgr.storeForward.fetchSet().length / mgr.storeForward.fetchBuckets) + 1;
    for (let i = 0; i < rotation(B) && !m; i++) await B.pollMailbox('foreground');
    assert(m && m.fromNodeId === aId && m.payload === payload, 'the message arrives via the mailbox, attributed to A');

    console.log('\n=== 5. B sends its receipt; A polls on network change ===');
    await B.pollMailbox('network');   // the receipt goes out at B's next poll
    let d = null;
    A.on('sf-delivered', (e) => { if (e.localId === 'offline-1') d = e; });
    for (let i = 0; i < rotation(A) && !d; i++) await A.pollMailbox('network');
    assert(d && d.localId === 'offline-1', 'DELIVERED, from B\'s sealed receipt in A\'s own mailbox (no delete: GM-N2b)');

    console.log('\n=== 6. status ===');
    const st = A.getStatus().storage;
    assert(st.selfHosted === true && st.separation === 'separated' && st.pending === 0, `self-hosted, separated, nothing pending (${JSON.stringify(st)})`);
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }
  for (const m of managers) { try { await m.stop(); } catch { /* stopped */ } }
  if (child) {
    child.kill('SIGTERM');
    await delay(300);
    const dir = path.join(tmp, 'storage-peer');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const claims = files.filter((f) => f.startsWith('nonce-claims')).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    let cached = [];
    if (files.includes('peer-cache.json')) {
      const pc = new PeerCache({ filePath: path.join(dir, 'peer-cache.json') });
      pc.setEncryptionKey(crypto.pbkdf2Sync(STORAGE_SEED, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256'));
      pc.load();
      cached = pc.cache;
    }
    assert(claims === 0 && cached.length === 0,
      `the storage peer persisted no session claim and no peer (claims ${claims} B, peer cache ${cached.length} entries): every visitor was a throwaway hop`);
  }
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
