/**
 * Bootstrap on a tiny network (the production shape today: ONE bootstrap host
 * plus one storage host), over real TCP on 127.0.0.1.
 *
 * A client with the default minPeers (3) can never reach its target. It used
 * to log "Bootstrap reached no peer … manual entry is the remaining way in"
 * while connected to the host, and re-run the ladder on every health check.
 *
 *  1. connected to every known host: one INFO all-known-connected line, no
 *     bootstrap 'failed', no 'below-target', no repeated health-monitor
 *     re-bootstrap. Control: the same log capture sees 'rung-start' and
 *     'complete' from the first run.
 *  2. a new candidate (peer exchange offers another node) brings the ladder
 *     back and it connects — nothing is weakened for a growing network.
 *     And the external-address line keeps the address out of msg (6a).
 *  3. truthful failure text: connected (to BOOT, and SIDE via exchange) with
 *     an unreachable host listed -> 'below-target' "connected to N, wanted 3", never "reached no
 *     peer"; a client that reaches nobody -> 'failed' "reached no peer".
 *
 * Run: node test/bootstrap-tiny-network-test.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-tiny-net-'));
const listFile = path.join(tmp, 'public-peers.json');
process.env.GMP_PUBLIC_PEERS_PATH = listFile;
fs.writeFileSync(listFile, '[]');

const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const { cliManagerOptions, storagePeerManagerOptions } = await import('../dist/entry-points.js');
const logger = (await import('../dist/logger.js')).default;

// Every log event, tagged with the node it came from where the meta says so.
const events = [];
for (const level of ['info', 'warn']) {
  const orig = logger[level].bind(logger);
  logger[level] = (component, event, msg, meta) => { events.push({ level, component, event, msg, at: Date.now() }); return orig(component, event, msg, meta); };
}
const since = (t) => events.filter((e) => e.at >= t);
const named = (list, component, event) => list.filter((e) => e.component === component && e.event === event);

// Fast clocks: health check every 300 ms, retry backoff from 200 ms.
const fast = { GMP_LAN_DISCOVERY: false, GMP_HOST: '127.0.0.1', GMP_REANNOUNCE_INTERVAL_MS: 600, GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: 200, GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: 1 };
const seed = (n) => `tiny-net-test:${n}:${process.pid}`;
const ports = { boot: await freePort(), storage: await freePort(), side: await freePort(), dead: await freePort() };
const managers = [];
const mk = (opts) => { const m = new GMPNodeManager(opts); managers.push(m); return m; };

const boot = mk({ ...cliManagerOptions({ seedPhrase: seed('boot'), isPublic: true, env: {}, configuredPort: ports.boot }), ...fast, GMP_PORT: ports.boot, dataDir: path.join(tmp, 'boot') });
const storage = mk({ ...storagePeerManagerOptions({ seedPhrase: seed('storage') }), ...fast, GMP_PORT: ports.storage, dataDir: path.join(tmp, 'storage') });
const ids = { boot: await boot.resolveNodeId(), storage: await storage.resolveNodeId() };
const deadId = 'ab'.repeat(64);
const list = (extra = []) => fs.writeFileSync(listFile, JSON.stringify([
  { address: '127.0.0.1', port: ports.boot, tls: false, nodeId: ids.boot, roles: ['bootstrap'], operator: '' },
  { address: '127.0.0.1', port: ports.storage, tls: false, nodeId: ids.storage, roles: ['storage'] },
  ...extra,
]));
list();

try {
  await storage.start();
  await boot.start();

  console.log('=== 1. one bootstrap host: connected, quiet ===');
  const t0 = Date.now();
  const c = mk({ seedPhrase: seed('c'), ...fast, GMP_PORT: 0, dataDir: path.join(tmp, 'c') });
  await c.start();
  assert(await waitFor(() => c.node.bootstrap.getDirectConnectionCount() === 1, 15000), 'client connected to the one bootstrap host');
  await delay(4000); // ~13 health checks
  const run1 = since(t0);
  const controlSeen = named(run1, 'bootstrap', 'rung-start').length > 0 && named(run1, 'bootstrap', 'complete').length > 0;
  assert(controlSeen, 'control: the capture sees the first ladder run (rung-start, complete)');
  assert(named(run1, 'bootstrap', 'all-known-connected').length === 1,
    `one all-known-connected line (saw ${named(run1, 'bootstrap', 'all-known-connected').length}): ${named(run1, 'bootstrap', 'all-known-connected')[0]?.msg}`);
  assertAbsent({ channel: 'bootstrap log', control: () => controlSeen,
    absent: () => named(run1, 'bootstrap', 'failed').length === 0 && named(run1, 'bootstrap', 'below-target').length === 0,
    message: `no bootstrap failed / below-target line while connected (failed ${named(run1, 'bootstrap', 'failed').length}, below-target ${named(run1, 'bootstrap', 'below-target').length})` });
  assertAbsent({ channel: 'health-monitor log', control: () => named(run1, 'bootstrap', 'rung-start').length,
    absent: () => named(run1, 'health-monitor', 'check-trigger-bootstrap').length === 0,
    message: `the health monitor stopped re-running bootstrap (saw ${named(run1, 'health-monitor', 'check-trigger-bootstrap').length})` });
  assert(['sufficient', 'all-known-connected'].includes(c.node.bootstrap.stage), `stage is not 'failed' (${c.node.bootstrap.stage})`);
  assertAbsent({ channel: 'role-blocked-dial log', control: () => controlSeen,
    absent: () => named(run1, 'bootstrap', 'role-blocked-dial').length === 0,
    message: 'the storage host was never even offered for a dial' });

  // 6a: the learned address goes in meta (redacted by the logger), not in msg.
  assert(await waitFor(() => !!c.externalAddress, 5000), `client learned its external address (${c.externalAddress?.address})`);
  const ext = named(since(t0), 'gmp-node-manager', 'external-address');
  assert(ext.length > 0 && ext.every((e) => !e.msg.includes(String(c.externalAddress.address)) && !/\d+\.\d+\.\d+\.\d+/.test(e.msg)),
    `external-address msg carries no address ("${ext[0]?.msg}")`);

  console.log('\n=== 2. a new candidate brings the ladder back ===');
  const side = mk({ seedPhrase: seed('side'), ...fast, disableBootstrap: true, GMP_PORT: ports.side, dataDir: path.join(tmp, 'side') });
  await side.start();
  await boot.connectToPeer('127.0.0.1', ports.side);
  const sideId = await side.resolveNodeId();
  const link = [...c.node.links.values()].find((l) => l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === ids.boot);
  link.sendPeerRequest(32);
  assert(await waitFor(() => !!c.node.getLinkByNodeId(sideId), 8000), 'client dialed the peer exchange offered and now has 2 links');

  console.log('\n=== 3. failure text matches the state ===');
  list([{ address: '127.0.0.1', port: ports.dead, tls: false, nodeId: deadId, roles: ['bootstrap'], operator: '' }]);
  const t3 = Date.now();
  const d = mk({ seedPhrase: seed('d'), ...fast, GMP_PORT: 0, dataDir: path.join(tmp, 'd') });
  await d.start();
  assert(await waitFor(() => named(since(t3), 'bootstrap', 'below-target').length > 0, 20000), 'connected to BOOT with the second host unreachable: a below-target line');
  const bt = named(since(t3), 'bootstrap', 'below-target')[0];
  assert(bt && /connected to [12], wanted 3/.test(bt.msg) && !/reached no peer/.test(bt.msg), `it says "${bt?.msg}"`);
  // Reaching nobody: BOOT gone from the list, only the dead host left.
  fs.writeFileSync(listFile, JSON.stringify([{ address: '127.0.0.1', port: ports.dead, tls: false, nodeId: deadId, roles: ['bootstrap'], operator: '' }]));
  const t4 = Date.now();
  const e = mk({ seedPhrase: seed('e'), ...fast, GMP_PORT: 0, dataDir: path.join(tmp, 'e') });
  await e.start();
  assert(await waitFor(() => named(since(t4), 'bootstrap', 'failed').length > 0, 20000), 'a client that reaches nobody logs bootstrap failed');
  assert(/reached no peer/.test(named(since(t4), 'bootstrap', 'failed')[0]?.msg || ''), `it says "${named(since(t4), 'bootstrap', 'failed')[0]?.msg}"`);
} catch (err) {
  testsFailed++;
  console.error('  ✗ harness error:', (err && err.stack) || err);
}

for (const m of managers.reverse()) { try { await m.stop(); } catch { /* down */ } }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${testsPassed} passed, ${testsFailed} failed ===`);
process.exit(testsFailed ? 1 : 0);
