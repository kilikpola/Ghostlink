/**
 * The storage peer makes no outbound mesh connections, and nothing turns it
 * into a peer-exchange offer.
 *
 * Local reproduction of the production log (a client's peer-exchange rung was
 * offered the storage peer and role-blocked-dial refused it). Three real TCP
 * nodes on 127.0.0.1, all reading one public-peers list that names a
 * bootstrap host and a storage host (the shipped shape):
 *   BOOT    — a public peer (cliManagerOptions isPublic), roles ["bootstrap"]
 *   STORAGE — storagePeerManagerOptions, roles ["storage"], with a transport
 *             wrapper that counts every outbound dial
 *   A, B    — ordinary clients that connect to BOOT
 *
 *  1. STORAGE dials nobody: not at start, and not when a client connects to
 *     it (each 'connection' used to run discoverExternalAddress, which dials
 *     every listed public peer). Control: the same counter sees A's dials.
 *  2. BOOT never dials STORAGE (its own discoverExternalAddress used to query
 *     every listed peer, which made STORAGE a dialable direct peer in BOOT's
 *     cache — the 24 h peer-exchange set).
 *  3. B's automatic PEER_REQUEST to BOOT returns no STORAGE entry.
 *     Control: an ordinary peer BOOT dialed directly IS returned.
 *  4. clients still learn their external address — from bootstrap-role hosts
 *     only (BOOT, the sole bootstrap host here, no longer queries itself or
 *     the storage host, so it learns none; nothing on a public peer uses it).
 *
 * Run: node test/storage-peer-no-outbound-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { absenceAsserter } from './helpers/assert-absent.mjs';


let testsPassed = 0, testsFailed = 0;
function assert(c, m) { if (c) { testsPassed++; console.log(`  ✓ ${m}`); } else { testsFailed++; console.error(`  ✗ ${m}`); } }
const { assertAbsent } = absenceAsserter(assert);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await delay(100); } return false; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-storage-noout-'));
const listFile = path.join(tmp, 'public-peers.json');
// The list must be in place before any module reads paths.ts.
process.env.GMP_PUBLIC_PEERS_PATH = listFile;
fs.writeFileSync(listFile, '[]');

const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const { cliManagerOptions, storagePeerManagerOptions } = await import('../dist/entry-points.js');
const { TcpTransport } = await import('../dist/transport/tcp-transport.js');

/** TCP transport that records every outbound dial target. */
function countingTransport() {
  const inner = new TcpTransport();
  const dials = [];
  return {
    dials,
    listen: (o, cb) => inner.listen(o, cb),
    dial: (o) => { dials.push(`${o.host}:${o.port}`); return inner.dial(o); },
    close: () => inner.close(),
  };
}

const common = { GMP_LAN_DISCOVERY: false, GMP_HOST: '127.0.0.1', GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: 1 };
const ports = { boot: await freePort(), storage: await freePort(), side: await freePort() };
// Distinct non-phrase seed strings (fixtures never hold phrase-shaped text).
const seeds = Object.fromEntries(['boot', 'storage', 'a', 'b', 'side'].map((n) => [n, `storage-noout-test:${n}:${process.pid}`]));

const bootT = countingTransport();
const storageT = countingTransport();
const aT = countingTransport();
const boot = new GMPNodeManager({ ...cliManagerOptions({ seedPhrase: seeds.boot, isPublic: true, env: {}, configuredPort: ports.boot }), ...common, GMP_PORT: ports.boot, dataDir: path.join(tmp, 'boot'), transport: bootT });
const storage = new GMPNodeManager({ ...storagePeerManagerOptions({ seedPhrase: seeds.storage }), ...common, GMP_PORT: ports.storage, dataDir: path.join(tmp, 'storage'), transport: storageT });
const side = new GMPNodeManager({ seedPhrase: seeds.side, ...common, disableBootstrap: true, GMP_PORT: ports.side, dataDir: path.join(tmp, 'side') });
const ids = { boot: await boot.resolveNodeId(), storage: await storage.resolveNodeId(), side: await side.resolveNodeId() };
fs.writeFileSync(listFile, JSON.stringify([
  { address: '127.0.0.1', port: ports.boot, tls: false, nodeId: ids.boot, roles: ['bootstrap'], operator: '' },
  { address: '127.0.0.1', port: ports.storage, tls: false, nodeId: ids.storage, roles: ['storage'] },
], null, 2));

const managers = [boot, storage, side];
const stopAll = async () => { for (const m of managers) { try { await m.stop(); } catch { /* already down */ } } };

try {
  await storage.start();
  await side.start();
  await boot.start();
  await delay(1500);

  console.log('=== 1. the storage peer dials nobody ===');
  // A client that uses the storage peer connects to it directly (inbound for STORAGE).
  const a = new GMPNodeManager({ seedPhrase: seeds.a, ...common, disableBootstrap: true, GMP_PORT: 0, dataDir: path.join(tmp, 'a'), transport: aT });
  managers.push(a);
  await a.start();
  const aToStorage = await a.connectToPeer('127.0.0.1', ports.storage).then(() => true, () => false);
  assert(aToStorage, 'client A connected to the storage peer (inbound connection at STORAGE)');
  await delay(6000); // > discoverExternalAddress' 5 s query budget
  assert(aT.dials.includes(`127.0.0.1:${ports.storage}`), `control: the counting transport records dials (A dialed ${aT.dials.join(', ')})`);
  assertAbsent({ channel: 'storage transport dials', control: () => aT.dials.slice(),
    absent: () => storageT.dials.length === 0, message: `STORAGE made no outbound dial (saw ${JSON.stringify(storageT.dials)})` });

  console.log('\n=== 2. the bootstrap host never dials the storage peer ===');
  // BOOT dials an ordinary peer directly: that peer becomes a 24 h direct peer (the control for 3).
  await boot.connectToPeer('127.0.0.1', ports.side);
  // Client B connects to BOOT: BOOT's first-connection discoverExternalAddress runs now.
  const b = new GMPNodeManager({ seedPhrase: seeds.b, ...common, GMP_PORT: 0, dataDir: path.join(tmp, 'b') });
  managers.push(b);
  await b.start();
  assert(await waitFor(() => (b.node?.links?.size ?? 0) > 0, 15000), 'client B bootstrapped to BOOT');
  await delay(6000);
  assert(bootT.dials.includes(`127.0.0.1:${ports.side}`), `control: BOOT's counter recorded its dial to the ordinary peer (${bootT.dials.join(', ')})`);
  assertAbsent({ channel: 'BOOT transport dials', control: () => bootT.dials.filter((d) => d === `127.0.0.1:${ports.side}`),
    absent: () => !bootT.dials.includes(`127.0.0.1:${ports.storage}`), message: `BOOT never dialed STORAGE (BOOT dialed ${JSON.stringify(bootT.dials)})` });
  const direct = boot.node.peerCache.getDirectPeers24h().map((p) => p.nodeId);
  assert(direct.includes(ids.side), 'control: the ordinary peer BOOT dialed is in its 24 h direct set');
  assertAbsent({ channel: 'BOOT 24 h direct set', control: () => direct.includes(ids.side),
    absent: () => !direct.includes(ids.storage), message: 'STORAGE is not in BOOT\'s 24 h direct set (the peer-exchange source)' });

  console.log('\n=== 3. peer exchange never offers the storage peer ===');
  // A fresh request from B (rate limit set to 1 ms for the test).
  const bootLink = [...b.node.links.values()].find((l) => l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === ids.boot);
  bootLink.sendPeerRequest(32);
  const gotSide = await waitFor(() => b.node.peerExchange.candidates().some((p) => p.nodeId === ids.side) || !!b.node.getLinkByNodeId(ids.side), 8000);
  assert(gotSide, 'control: B learned the ordinary peer from BOOT\'s peer exchange');
  const offered = b.node.peerExchange.candidates().map((p) => p.nodeId);
  assertAbsent({ channel: 'B peer-exchange pool', control: () => gotSide,
    absent: () => !offered.includes(ids.storage), message: 'B\'s peer-exchange pool holds no STORAGE entry' });

  console.log('\n=== 4. external-address discovery still works, from bootstrap hosts only ===');
  assert(await waitFor(() => !!b.externalAddress, 3000), `client B learned its external address from BOOT (${JSON.stringify(b.externalAddress)})`);
  // A's only dials: its manual connect to STORAGE and its BINDING query to BOOT.
  assert(aT.dials.filter((d) => d === `127.0.0.1:${ports.storage}`).length === 1 && aT.dials.includes(`127.0.0.1:${ports.boot}`),
    `client A queried BOOT, not STORAGE, for its address (A dialed ${JSON.stringify(aT.dials)})`);
} catch (e) {
  testsFailed++;
  console.error('  ✗ harness error:', (e && e.stack) || e);
}

await stopAll();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${testsPassed} passed, ${testsFailed} failed ===`);
process.exit(testsFailed ? 1 : 0);
