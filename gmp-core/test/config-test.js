/**
 * Configuration Test
 *
 * 1. Precedence (pure resolveConfig): explicit > env > file > default, with
 *    invalid values reported and skipped
 * 2. loadConfig end to end in a child process: real file, real environment,
 *    malformed file
 * 3. Option matrix: every DEFAULTS key reaches its GMPNode consumer or is
 *    classified as application-level or dead
 * 4. Explicit GMPNode options beat the injected config
 * 5. The factory reads the environment; GMPNode itself never does
 * 6. GMPNodeManager: explicit option > env > default, dataDir forwarded
 * 7. Architecture: only the application layer imports config.js
 *
 * Run: node test/config-test.js
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveConfig, readConfigFile, DEFAULTS } from '../dist/config.js';
import { createGMPNode } from '../dist/node-factory.js';
import { GMPNodeManager } from '../dist/gmp-node-manager.js';
import { MemoryNetwork, MemoryTransport } from '../dist/transport/memory-transport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, actual === expected ? message : `${message} (expected ${expected}, got ${actual})`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-config-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let dirCount = 0;
const freshDir = () => path.join(tmp, `d${dirCount++}`);

// ── 1. precedence ─────────────────────────────────────

function testPrecedence() {
  console.log('\n=== Test 1: precedence (resolveConfig) ===');

  const d = resolveConfig();
  assert(Object.keys(DEFAULTS).every((k) => d.config[k] === DEFAULTS[k]), 'no input: every key is its default');
  assert(Object.keys(DEFAULTS).every((k) => d.sources[k] === 'default'), 'no input: every source is "default"');

  const f = resolveConfig({ file: { GMP_MIN_PEERS: 7 } });
  assertEqual(f.config.GMP_MIN_PEERS, 7, 'file beats default');
  assertEqual(f.sources.GMP_MIN_PEERS, 'file', 'source recorded as file');

  const e = resolveConfig({ file: { GMP_MIN_PEERS: 7 }, env: { GMP_MIN_PEERS: '8' } });
  assertEqual(e.config.GMP_MIN_PEERS, 8, 'env beats file');

  const x = resolveConfig({ file: { GMP_MIN_PEERS: 7 }, env: { GMP_MIN_PEERS: '8' }, overrides: { GMP_MIN_PEERS: 9 } });
  assertEqual(x.config.GMP_MIN_PEERS, 9, 'explicit beats env');
  assertEqual(x.sources.GMP_MIN_PEERS, 'explicit', 'source recorded as explicit');

  assertEqual(resolveConfig({ overrides: { minPeers: 4 } }).config.GMP_MIN_PEERS, 4, 'camelCase alias is an explicit override');
  assertEqual(resolveConfig({ overrides: { port: 1, GMP_PORT: 2 } }).config.GMP_PORT, 2, 'GMP_* key beats its alias when both are given');
  assertEqual(resolveConfig({ overrides: { seedPhrase: 'x', transport: {} } }).issues.length, 0, 'non-config options are ignored, not errors');

  const badEnv = resolveConfig({ file: { GMP_MIN_PEERS: 7 }, env: { GMP_MIN_PEERS: 'many' } });
  assertEqual(badEnv.config.GMP_MIN_PEERS, 7, 'invalid env value falls back to the file value');
  assert(badEnv.issues.some((i) => i.key === 'GMP_MIN_PEERS' && i.source === 'env'), 'invalid env value is reported');

  const emptyEnv = resolveConfig({ env: { GMP_PORT: '' } });
  assertEqual(emptyEnv.config.GMP_PORT, DEFAULTS.GMP_PORT, 'empty env number is refused (was silently 0)');

  const badFile = resolveConfig({ file: { GMP_LOG_TO_FILE: 'yes', GMP_PORT: 'abc' }, env: { GMP_PORT: '5000' } });
  assertEqual(badFile.config.GMP_LOG_TO_FILE, false, 'invalid file boolean is skipped');
  assertEqual(badFile.config.GMP_PORT, 5000, 'env still applies over an invalid file value');
  assertEqual(badFile.issues.filter((i) => i.source === 'file').length, 2, 'both invalid file values are reported');

  const comments = resolveConfig({ file: { '// Network': 'x', GMP_UNKNOWN: 1, GMP_SEED_PHRASE: 'secret words' } });
  assert(comments.issues.length === 0 && !('GMP_UNKNOWN' in comments.config), 'comment and unknown keys are ignored');
  assert(comments.config.GMP_SEED_PHRASE === undefined, 'a seed phrase in the config file is not loaded');

  const types = resolveConfig({
    file: { GMP_TOPOLOGY_TTL: '12', GMP_STRICT_STATE: 'true' },
    env: { GMP_LOG_TO_CONSOLE: '1', GMP_LOG_TO_FILE: 'yes', GMP_LOG_LEVEL: 'debug' },
  });
  assertEqual(types.config.GMP_TOPOLOGY_TTL, 12, 'numeric string in the file is accepted');
  assertEqual(types.config.GMP_STRICT_STATE, true, '"true" string in the file is accepted');
  assertEqual(types.config.GMP_LOG_TO_CONSOLE, true, 'env boolean "1" is true (unchanged)');
  assertEqual(types.config.GMP_LOG_TO_FILE, false, 'env boolean other than true/1 is false (unchanged)');
  assertEqual(types.config.GMP_LOG_LEVEL, 'DEBUG', 'log level is case-insensitive');

  const lan = resolveConfig({ env: { GMP_LAN_DISCOVERY: 'false', GMP_LAN_DISCOVERY_PORT: '50000' } });
  assertEqual(lan.config.GMP_LAN_DISCOVERY, false, 'GMP_LAN_DISCOVERY=false is parsed (was never read)');
  assertEqual(lan.config.GMP_LAN_DISCOVERY_PORT, 50000, 'GMP_LAN_DISCOVERY_PORT is parsed');
  assert(!('GMP_LAN_DISCOVERY' in resolveConfig().config), 'LAN keys are absent unless configured');
}

// ── 2. loadConfig end to end ─────────────────────────

function runLoad(cwd, env) {
  const script = `import('${path.join(DIST, 'config.js')}').then(m => {
    const r = m.loadConfigDetailed({ GMP_TOPOLOGY_TTL: 13 });
    console.log(JSON.stringify({ c: r.config, s: r.sources, i: r.issues, f: r.filePath }));
  });`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { PATH: process.env.PATH, GMP_DATA_DIR: path.join(cwd, 'data-dir'), ...env }, encoding: 'utf8',
  });
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

function testLoadConfig() {
  console.log('\n=== Test 2: loadConfig with a real file and environment ===');

  const cwd = freshDir();
  fs.mkdirSync(cwd, { recursive: true });
  const cfgFile = path.join(cwd, 'my-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ GMP_MIN_PEERS: 5, GMP_ROUTE_EXPIRY_MS: 123456, GMP_TOPOLOGY_TTL: 3 }));

  const r = runLoad(cwd, { GMP_CONFIG_PATH: cfgFile, GMP_MIN_PEERS: '6' });
  assertEqual(r.f, cfgFile, 'the GMP_CONFIG_PATH file is the one read');
  assertEqual(r.c.GMP_ROUTE_EXPIRY_MS, 123456, 'a file-only value takes effect (the file layer was dead before S3)');
  assertEqual(r.c.GMP_MIN_PEERS, 6, 'env beats the file');
  assertEqual(r.c.GMP_TOPOLOGY_TTL, 13, 'explicit option beats the file');
  assertEqual(r.c.GMP_PORT, DEFAULTS.GMP_PORT, 'untouched keys keep their default');

  fs.writeFileSync(cfgFile, '{ not json');
  const bad = runLoad(cwd, { GMP_CONFIG_PATH: cfgFile });
  assert(bad.i.some((i) => i.key === '*' && /unreadable/.test(i.reason)), 'a malformed config file is reported, not silently ignored');
  assertEqual(bad.c.GMP_MIN_PEERS, DEFAULTS.GMP_MIN_PEERS, 'and defaults still apply');

  const none = readConfigFile([path.join(cwd, 'absent.json')]);
  assert(none.filePath === null && none.error === null, 'no config file is not an error');
}

// ── 3. option matrix ─────────────────────────────────

/** Read by the application layer (bridge, CLI, metrics, logger), not GMPNode. */
const APP_LEVEL = {
  GMP_BRIDGE_PORT: 'gmp-bridge / cli',
  GMP_BRIDGE_HOST: 'gmp-bridge / cli',
  GMP_METRICS_PORT: 'gmp-node-manager -> metrics.startServer',
  GMP_LOG_LEVEL: 'logger',
  GMP_LOG_TO_FILE: 'logger',
  GMP_LOG_TO_CONSOLE: 'logger',
  GMP_SF_POLL_INTERVAL_MS: 'gmp-node-manager -> SfPollScheduler',
  GMP_SF_STORAGE_PEER: 'gmp-node-manager -> own mailbox (parseStoragePeer)',
  GMP_SF_DECOY_CHANNELS: 'gmp-node-manager -> StoreForward',
  GMP_SF_CURSOR_QUANTUM_MS: 'gmp-node-manager -> StoreForward',
  GMP_RESOURCE_LOG_INTERVAL_MS: 'gmp-node-manager -> resource-sample log',
  GMP_FD_WARN_FRACTION: 'gmp-node-manager -> fd-pressure WARN in the resource-sample log; link -> live connection-pressure WARN',
  GMP_FD_HEADROOM: 'link.listen -> connection-cap clamp to the fd limit',
  GMP_REFUSAL_LOG_INTERVAL_MS: 'link -> RateLimiter refusal summary',
};

/** No consumer anywhere. Documented, not implemented (would be new behaviour). */
const DEAD = {
  GMP_MAX_PEERS: 'no connection cap exists',
  GMP_MAX_CONNECTIONS: 'no connection cap exists',
  // Capacity is a constant, deliberately not configurable: a knob would let
  // the set be configured to 0.
  GMP_SESSION_KEY_LRU_SIZE: 'SessionKeyLRUSet capacity is the SESSION_KEY_LRU_SIZE constant, deliberately not configurable',
  GMP_MESSAGE_HOP_LIMIT: 'VirtualSocket hard-codes hop count 16',
};

async function testOptionMatrix() {
  console.log('\n=== Test 3: every option reaches its consumer ===');

  const cfg = {
    ...DEFAULTS,
    GMP_PORT: 40123,
    GMP_MIN_PEERS: 7,
    GMP_HELLO_TIMEOUT_MS: 11111,
    GMP_HANDSHAKE_TIMEOUT_MS: 12222,
    GMP_PING_INTERVAL_MS: 31111,
    GMP_PING_TIMEOUT_MS: 9111,
    GMP_TIMESTAMP_WINDOW_MS: 130000,
    GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 10111,
    GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 15111,
    GMP_BOOTSTRAP_LAN_TIMEOUT_MS: 1001,
    GMP_BOOTSTRAP_PX_TIMEOUT_MS: 1002,
    GMP_BOOTSTRAP_DIAL_TIMEOUT_MS: 4001,
    GMP_BOOTSTRAP_DIAL_STAGGER_MS: 501,
    GMP_LAN_BOOTSTRAP_ANY: true,
    GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: 30111,
    GMP_RATE_LIMIT_WINDOW_MS: 61111,
    GMP_RATE_LIMIT_MAX_GLOBAL: 541,
    GMP_INBOUND_RATE_PER_MINUTE: 31,
    GMP_INBOUND_BURST: 257,
    GMP_FORWARD_RATE_LIMIT_PER_SOURCE: 501,
    GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: 61222,
    GMP_SEQUENCE_NUM_LRU_SIZE: 1001,
    GMP_NONCE_PRUNE_AGE_MS: 7776000001,
    GMP_ROUTE_EXPIRY_MS: 300111,
    GMP_TOPOLOGY_TTL: 9,
    GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS: 600001,
    GMP_TOPOLOGY_SAMPLE_SIZE: 7,
    GMP_TOPOLOGY_SAMPLE_EPOCH_MS: 86400001,
    GMP_ROUTE_QUERY_TTL: 4,
    GMP_REANNOUNCE_INTERVAL_MS: 62000,
    GMP_PEER_CACHE_MAX_SIZE: 502,
    GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: 11,
    GMP_PEER_CACHE_PRUNE_AGE_DAYS: 31,
    GMP_STRICT_STATE: true,
    GMP_BAN_DURATION_MS: 86400001,
    GMP_REPUTATION_RECOVERY_INTERVAL_MS: 60111,
    GMP_RELAY_ENABLED: true,
    GMP_RELAY_RESERVATION_TTL_MS: 1800001,
    GMP_RELAY_MAX_RESERVATIONS: 1025,
    GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET: 9,
    GMP_RELAY_RESERVATION_RATE_PER_MINUTE: 31,
    GMP_RELAY_RESERVATION_BURST: 257,
    GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION: 7,
    GMP_RELAY_MAX_CIRCUIT_BYTES: 67108865,
    GMP_RELAY_MAX_CIRCUIT_DURATION_MS: 3600001,
    GMP_RELAY_ROLE_OBSERVATION_MS: 2001,
    GMP_STORAGE_ENABLED: true,
    GMP_SF_TTL_MS: 604800001,
    GMP_SF_BUCKET_MAX_BLOBS: 255,
    GMP_SF_BUCKET_MAX_BYTES: 16777217,
    GMP_SF_FETCH_BUCKETS: 5,
    GMP_SF_FETCH_MAX_BLOBS: 257,
    GMP_SF_DEPOSIT_RATE_PER_MINUTE: 29,
    GMP_SF_DEPOSIT_BURST: 255,
    GMP_SF_POLL_INTERVAL_MS: 900001,
    GMP_SF_STORAGE_PEER: 'mailbox.example:49600',
    GMP_SF_DECOY_CHANNELS: 3,
    GMP_SF_CURSOR_QUANTUM_MS: 60001,
    GMP_LAN_DISCOVERY: false,
    GMP_LAN_DISCOVERY_PORT: 50001,
    GMP_LAN_DISCOVERY_GROUP: '239.255.42.100',
  };
  // isPublicPeer only so the binding rate limiter (the one consumer of the
  // HELLO/handshake timeouts) exists to be inspected.
  const node = createGMPNode({ config: cfg, dataDir: freshDir(), transport: new MemoryTransport(), isPublicPeer: true });

  const consumers = {
    GMP_PORT: [() => node.port],
    GMP_MIN_PEERS: [() => node.bootstrap.minPeers],
    GMP_HELLO_TIMEOUT_MS: [() => node.bindingRateLimiter.helloTimeoutMs, () => node.rateLimiter.helloTimeoutMs],
    GMP_HANDSHAKE_TIMEOUT_MS: [() => node.bindingRateLimiter.handshakeTimeoutMs, () => node.rateLimiter.handshakeTimeoutMs],
    GMP_RATE_LIMIT_MAX_GLOBAL: [() => node.rateLimiter.maxGlobal],
    GMP_INBOUND_RATE_PER_MINUTE: [() => node.rateLimiter.ratePerMinute],
    GMP_INBOUND_BURST: [() => node.rateLimiter.burst],
    GMP_PING_INTERVAL_MS: [() => node.pingIntervalMs],
    GMP_PING_TIMEOUT_MS: [() => node.pongTimeoutMs],
    GMP_TIMESTAMP_WINDOW_MS: [() => node.timestampWindowMs],
    GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: [() => node.bootstrap.stage1TimeoutMs],
    GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: [() => node.bootstrap.stage2TimeoutMs],
    GMP_BOOTSTRAP_LAN_TIMEOUT_MS: [() => node.bootstrap.lanTimeoutMs],
    GMP_BOOTSTRAP_PX_TIMEOUT_MS: [() => node.bootstrap.peerExchangeTimeoutMs],
    GMP_BOOTSTRAP_DIAL_TIMEOUT_MS: [() => node.bootstrap.dialTimeoutMs],
    GMP_BOOTSTRAP_DIAL_STAGGER_MS: [() => node.bootstrap.dialStaggerMs],
    GMP_LAN_BOOTSTRAP_ANY: [() => node.bootstrap.lanAny],
    GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: [() => node.bootstrap.rebootstrapBackoffInitialMs],
    GMP_RATE_LIMIT_WINDOW_MS: [() => node.forwardRateLimitWindowMs],
    GMP_FORWARD_RATE_LIMIT_PER_SOURCE: [() => node.forwardRateLimitMax],
    GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: [() => node.peerExchange.requestIntervalMs],
    GMP_SEQUENCE_NUM_LRU_SIZE: [() => node.topologyManager.seenSequenceNumbers.maxSize],
    GMP_NONCE_PRUNE_AGE_MS: [() => node.nonceStore.pruneAgeMs],
    GMP_ROUTE_EXPIRY_MS: [() => node.routingTable.expiryTimeoutMs],
    GMP_TOPOLOGY_TTL: [() => node.topologyManager.ttl, () => node.keyRotationManager.ttl],
    GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS: [() => node.topologyManager.validityMs],
    GMP_TOPOLOGY_SAMPLE_SIZE: [() => node.topologyManager.sampleSize],
    GMP_TOPOLOGY_SAMPLE_EPOCH_MS: [() => node.topologyManager.sampleEpochMs],
    GMP_ROUTE_QUERY_TTL: [() => node.topologyManager.routeQueryTtl],
    GMP_REANNOUNCE_INTERVAL_MS: [
      () => node.topologyManager.announceIntervalMs,
      () => node.routingTable.pruneIntervalMs,
      () => node.healthMonitor.checkIntervalMs * 2,
    ],
    GMP_PEER_CACHE_MAX_SIZE: [() => node.peerCache.maxSize, () => node.peerExchange.maxPool],
    GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: [() => node.peerCache.pruneFailureThreshold],
    GMP_PEER_CACHE_PRUNE_AGE_DAYS: [() => node.peerCache.pruneAgeDays],
    GMP_STRICT_STATE: [() => node.peerCache.strictState, () => node.nonceStore.strictState, () => node.nonceStore.claimLog.strictState],
    GMP_BAN_DURATION_MS: [() => node.reputation.banDurationMs],
    GMP_REPUTATION_RECOVERY_INTERVAL_MS: [() => node.reputation.recoveryIntervalMs],
    GMP_RELAY_ENABLED: [() => node.relayServer !== null],
    GMP_RELAY_RESERVATION_TTL_MS: [() => node.relayServer.quotas.reservationTtlMs],
    GMP_RELAY_MAX_RESERVATIONS: [() => node.relayServer.quotas.maxReservations],
    GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET: [() => node.relayServer.quotas.maxReservationsPerSubnet],
    GMP_RELAY_RESERVATION_RATE_PER_MINUTE: [() => node.relayServer.quotas.reservationRatePerMinute],
    GMP_RELAY_RESERVATION_BURST: [() => node.relayServer.quotas.reservationBurst],
    GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION: [() => node.relayServer.quotas.maxCircuitsPerReservation],
    GMP_RELAY_MAX_CIRCUIT_BYTES: [() => node.relayServer.quotas.maxCircuitBytes],
    GMP_RELAY_MAX_CIRCUIT_DURATION_MS: [() => node.relayServer.quotas.maxCircuitDurationMs],
    GMP_RELAY_ROLE_OBSERVATION_MS: [() => node.relayRoleObservationMs],
    // Storage host: built when the identity loads; started by hand here.
    GMP_STORAGE_ENABLED: [() => (node._startStorage('config test storage seed'), node.storageServer !== null)],
    GMP_SF_TTL_MS: [() => node.storageServer.store.ttlMs],
    GMP_SF_BUCKET_MAX_BLOBS: [() => node.storageServer.store.maxBlobs],
    GMP_SF_BUCKET_MAX_BYTES: [() => node.storageServer.store.maxBytes],
    GMP_SF_FETCH_BUCKETS: [() => node.storageServer.quotas.fetchBuckets],
    GMP_SF_FETCH_MAX_BLOBS: [() => node.storageServer.quotas.fetchMaxBlobs],
    GMP_SF_DEPOSIT_RATE_PER_MINUTE: [() => node.storageServer.quotas.depositRatePerMinute],
    GMP_SF_DEPOSIT_BURST: [() => node.storageServer.quotas.depositBurst],
  };

  for (const [key, getters] of Object.entries(consumers)) {
    const got = getters.map((g) => g());
    assert(got.every((v) => v === cfg[key]), `${key} reaches ${getters.length} consumer(s) (${JSON.stringify(got)})`);
  }
  assertEqual(node.lanDiscoveryEnabled, false, 'GMP_LAN_DISCOVERY=false turns LAN discovery off');
  assert(node.lanDiscoveryOptions.port === 50001 && node.lanDiscoveryOptions.group === '239.255.42.100',
    'GMP_LAN_DISCOVERY_PORT / _GROUP reach LanDiscovery');
  assert(node.config.GMP_MIN_PEERS === 7 && Object.isFrozen(node.config), 'node.config exposes the resolved config, read-only');

  const classified = new Set([...Object.keys(consumers), ...Object.keys(APP_LEVEL), ...Object.keys(DEAD)]);
  const unclassified = Object.keys(DEFAULTS).filter((k) => !classified.has(k));
  assert(unclassified.length === 0, `every DEFAULTS key is classified${unclassified.length ? ' — missing: ' + unclassified.join(', ') : ''}`);
  assertEqual(classified.size, Object.keys(DEFAULTS).length, `classification has no stray keys (${Object.keys(DEFAULTS).length} keys)`);

  node.close();
}

// ── 4. explicit options beat config ──────────────────

function testExplicitBeatsConfig() {
  console.log('\n=== Test 4: explicit GMPNode options beat the config ===');

  const node = createGMPNode({
    config: { ...DEFAULTS, GMP_PORT: 40001, GMP_MIN_PEERS: 7, GMP_TIMESTAMP_WINDOW_MS: 130000, GMP_FORWARD_RATE_LIMIT_PER_SOURCE: 501 },
    dataDir: freshDir(),
    transport: new MemoryTransport(),
    port: 40002,
    minPeers: 2,
    timestampWindowMs: 60000,
    forwardRateLimitMax: 10,
  });
  assertEqual(node.port, 40002, 'port option beats GMP_PORT');
  assertEqual(node.bootstrap.minPeers, 2, 'minPeers option beats GMP_MIN_PEERS');
  assertEqual(node.timestampWindowMs, 60000, 'timestampWindowMs option beats GMP_TIMESTAMP_WINDOW_MS');
  assertEqual(node.forwardRateLimitMax, 10, 'forwardRateLimitMax option beats GMP_FORWARD_RATE_LIMIT_PER_SOURCE');
  node.close();

  const zero = createGMPNode({ config: { ...DEFAULTS, GMP_PORT: 0 }, dataDir: freshDir(), transport: new MemoryTransport() });
  assertEqual(zero.port, 0, 'GMP_PORT=0 stays 0 (ephemeral), not the default');
  zero.close();
}

// ── 5. one environment reader: the factory ───────────

function testNodeIgnoresEnvironment() {
  console.log('\n=== Test 5: the factory reads the environment; GMPNode itself never does ===');

  process.env.GMP_TOPOLOGY_TTL = '3';
  process.env.GMP_STRICT_STATE = 'true';
  try {
    // Fully explicit config: if anything below the factory re-read the
    // environment, the env values would show up here.
    const explicit = createGMPNode({ config: { ...DEFAULTS }, dataDir: freshDir(), transport: new MemoryTransport() });
    assertEqual(explicit.topologyManager.ttl, DEFAULTS.GMP_TOPOLOGY_TTL, 'explicit config beats env GMP_TOPOLOGY_TTL, and nothing downstream re-reads it');
    assertEqual(explicit.nonceStore.strictState, DEFAULTS.GMP_STRICT_STATE, 'explicit config beats env GMP_STRICT_STATE, and nothing downstream re-reads it');
    explicit.close();

    // No config: the factory applies the environment, as the manager does for
    // every shipped node.
    const fromEnv = createGMPNode({ dataDir: freshDir(), transport: new MemoryTransport() });
    assertEqual(fromEnv.topologyManager.ttl, 3, 'without explicit config, env GMP_TOPOLOGY_TTL reaches the node (same as production)');
    assertEqual(fromEnv.nonceStore.strictState, true, 'without explicit config, env GMP_STRICT_STATE reaches the node (same as production)');
    fromEnv.close();
  } finally {
    delete process.env.GMP_TOPOLOGY_TTL;
    delete process.env.GMP_STRICT_STATE;
  }
}

// ── 6. manager ───────────────────────────────────────

async function testManager() {
  console.log('\n=== Test 6: GMPNodeManager resolves and forwards config ===');

  const dataDir = freshDir();
  process.env.GMP_TOPOLOGY_TTL = '5';
  process.env.GMP_MIN_PEERS = '9';
  let manager;
  try {
    manager = new GMPNodeManager({
      seedPhrase: 'config test manager seed phrase',
      GMP_MIN_PEERS: 6,
      GMP_PORT: 0,
      GMP_METRICS_PORT: 47000 + Math.floor(Math.random() * 1000),
      dataDir,
      transport: new MemoryTransport(new MemoryNetwork()),
    });
  } finally {
    delete process.env.GMP_TOPOLOGY_TTL;
    delete process.env.GMP_MIN_PEERS;
  }
  await manager.start();
  const node = manager.node;
  assertEqual(node.config.GMP_MIN_PEERS, 6, 'manager: explicit option beats env');
  assertEqual(node.bootstrap.minPeers, 6, 'and reaches the bootstrap manager');
  assertEqual(node.config.GMP_TOPOLOGY_TTL, 5, 'manager: env beats default');
  assertEqual(node.topologyManager.ttl, 5, 'and reaches the topology manager');
  assertEqual(node.dataDir, path.resolve(dataDir), 'manager forwards dataDir');
  const inside = (f) => path.resolve(f).startsWith(path.resolve(dataDir) + path.sep);
  assert(inside(node.nonceStore.claimsFile) && inside(node.peerCache.filePath),
    `nonce claim log and peer cache live in the manager's dataDir (${path.basename(node.nonceStore.claimsFile)})`);
  assertEqual(node.isPublicPeer, false, 'isPublicPeer is still not forwarded (unchanged; flagged)');
  await manager.stop();
}

// ── 7. architecture ─────────────────────────────────

function testConfigImports() {
  console.log('\n=== Test 7: architecture — only the application layer imports config.js ===');

  // node-factory.js is composition, like the manager: it resolves the config
  // and hands it to GMPNode. Nothing node-level imports it.
  const allowed = new Set(['config.js', 'logger.js', 'metrics.js', 'cli.js', 'gmp-bridge.js', 'gmp-node-manager.js', 'node-factory.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/from\s+['"](?:\.\.?\/)+config\.js['"]/.test(src) && !allowed.has(path.relative(DIST, full))) {
        offenders.push(path.relative(DIST, full));
      }
    }
  };
  walk(DIST);
  assert(offenders.length === 0, `no node-level module imports config.js${offenders.length ? ' — found ' + offenders.join(', ') : ''}`);
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase S3 — Configuration Test                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    testPrecedence();
    testLoadConfig();
    await testOptionMatrix();
    testExplicitBeatsConfig();
    testNodeIgnoresEnvironment();
    await testManager();
    testConfigImports();
  } catch (err) {
    console.error('\nTest suite error:', err);
    testsFailed++;
  }

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
