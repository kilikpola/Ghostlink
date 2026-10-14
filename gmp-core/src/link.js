// @ts-check
/**
 * GMP node — GMPNode and the VirtualSocket used for mesh-routed links.
 *
 * Per-link logic (framing, handshake, session crypto, keepalive) lives in
 * link/. GMPLink, MESSAGETYPES and SessionKeyLRUSet are re-exported here.
 *
 * Port: 49500 (default)
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  deriveIdentityFromSeedPhrase,
  identityFromDerivedSeed,
  signMessage,
  sha512,
  bytesToHex,
  stringToBytes,
} from './identity.js';
import { registerSensitiveValue } from './seed-guard.js';
import { EphemeralKeySource } from './link/ephemeral-source.js';
import { advanceBootCounter } from './boot-counter.js';
import { GMPLink, toHex } from './link/link.js';
import { MESSAGETYPES } from './link/frame.js';
import { SessionKeyLRUSet } from './link/session.js';
import { NonceStore, deriveNonceStoreKey } from './nonce-store.js';
import { RateLimiter } from './rate-limiter.js';
import { detectNATType } from './nat-detector.js';
import { RoutingTable } from './routing-table.js';
import { TopologyManager } from './topology-announce.js';
import { Forwarder } from './forwarder.js';
import { PeerCache } from './peer-cache.js';
import { PeerExchangeManager } from './peer-exchange.js';
import { BootstrapManager } from './bootstrap.js';
import { NetworkHealthMonitor } from './network-health.js';
import { KeyRotationManager } from './key-rotation.js';
import { ReputationManager } from './peer-reputation.js';
import { DEFAULTS } from './config-defaults.js';
import { RelayServer } from './relay/relay-server.js';
import { RelayHop, RelayConnection } from './relay/relay-client.js';
import { RelayError, decodeControl, encodeControl } from './relay/relay-protocol.js';
import { nodeIdMatchesKeys } from './link/handshake.js';
import { SessionExposure, RoleSeparationError, hostKey, SELF_OPERATOR } from './relay/role-separation.js';
import { loadPublicPeers, listedNodeIdsForAddress } from './public-peer-list.js';
import { decodeStorage, encodeStorage } from './storage/storage-protocol.js';
import { BlobStore } from './storage/blob-store.js';
import { StorageServer } from './storage/storage-server.js';
import { DATA_DIR, dataPath } from './paths.js';
import logger from './logger.js';
import { countOpenFds, readFdLimits } from './fd-limits.js';

const requireLocal = createRequire(import.meta.url);

const DEFAULT_PORT = DEFAULTS.GMP_PORT;

// Tests isolate themselves through the environment (GMP_LAN_DISCOVERY=false,
// empty GMP_PUBLIC_PEERS_PATH); there is no test-process detection here.

class VirtualSocket extends EventEmitter {
  constructor({ node, sourceNodeId, destNodeId }) {
    super();
    this.node = node;
    this.sourceNodeId = sourceNodeId;
    this.destNodeId = destNodeId;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 0;
  }

  write(data, callback) {
    const destHex = toHex(this.destNodeId);
    const route = this.node.routingTable.getBestRoute(destHex);
    if (!route) {
      this.node.emit('no-route', { finalDestinationNodeId: Buffer.from(destHex, 'hex').slice(0, 32).toString('hex') });
      const err = new Error('no-route');
      this.emit('error', err);
      if (callback) callback(err);
      return;
    }

    const nextHopLink = this.node.getLinkByNodeId(route.nextHopNodeId);
    if (!nextHopLink || nextHopLink.state !== 'connected') {
      this.node.emit('no-route', { finalDestinationNodeId: Buffer.from(destHex, 'hex').slice(0, 32).toString('hex') });
      const err = new Error('no-route');
      this.emit('error', err);
      if (callback) callback(err);
      return;
    }

    try {
      nextHopLink.sendRoutedDATA(destHex, 16, data, this.node.identity.nodeId.slice(0, 32));
      if (callback) callback();
    } catch (e) {
      this.emit('error', e);
      if (callback) callback(e);
    }
  }

  /** Called by GMPLink's HTTP health-check shim. */
  end() {
    this.destroy();
  }

  destroy() {
    this.emit('close');
  }
}

/**
 * A reservation this node holds on a relay.
 * @typedef {{
 *   hop: RelayHop,
 *   key: string,
 *   relayNodeId: string,
 *   operator: string | null,
 *   current: { voucherId: string, voucher: import('./relay/relay-protocol.js').Voucher },
 *   timer: ReturnType<typeof setTimeout> | null,
 * }} RelayReservationEntry
 */

/** @extends {EventEmitter<import('./events.js').GMPNodeEvents>} */
class GMPNode extends EventEmitter {
  /**
   * - `config`: a resolved GMPConfig; DEFAULTS when omitted. GMPNode never
   *   reads the environment or a config file itself.
   * - Individual options (port, minPeers, ...) beat the config value.
   * - `dataDir`: where this node's state lives; required to differ for two
   *   nodes in one process. Defaults to the paths.ts locations.
   */
  constructor({
    config = null,
    dataDir = null,
    port = null,
    transport = null,
    rateLimiter = null,
    nonceStore = null,
    nonceStorePath = null,
    noncePruneAgeMs = null,
    sessionKeyLRUSet = null,
    isPublicPeer = false,
    establishedPeers = new Set(),
    bindingRateLimiter = null,
    pingIntervalMs = null,
    pongTimeoutMs = null,
    forwardRateLimitMax = null,
    forwardRateLimitWindowMs = null,
    announceIntervalMs = null,
    peerCachePath = null,
    publicPeersPath = null,
    minPeers = null,
    bootstrapParallelCount = 5,
    disableBootstrap = false,
    lanDiscovery = null,
    lanDiscoveryPort = null,
    lanDiscoveryGroup = null,
    seedPhrase = null,
    timestampWindowMs = null,
    reputationBanDurationMs = null,
    reputationRecoveryIntervalMs = null,
    derivedSeed = null,
  } = {}) {
    super();
    const cfg = Object.freeze({ ...DEFAULTS, ...(config || {}) });
    /** The configuration this node runs with (read-only). */
    this.config = cfg;
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    }
    const inDataDir = (name) => (this.dataDir ? path.join(this.dataDir, name) : null);

    // ?? not ||: GMP_PORT=0 asks for an ephemeral port, as it always has
    // through the manager.
    this.port = port ?? cfg.GMP_PORT;
    // Injectable transport; the TCP default is loaded lazily so platforms
    // without `net` can still construct a node with their own transport.
    this.transport = transport || new (requireLocal('./transport/tcp-transport.js').TcpTransport)();
    this.listener = null;
    this.links = new Map();
    this.identity = null;
    // Raw 32-byte seed from the validated `derivedSeed` factory option, or null.
    // Used by loadIdentityFromDerivedSeed(); never derived from env/config.
    this._derivedSeed = derivedSeed ? new Uint8Array(derivedSeed) : null;
    this.connections = new Map();
    // Always built: it owns the HELLO/handshake timeouts, a global concurrent
    // cap and a per-address token bucket. No per-address concurrent cap (CGNAT).
    this.rateLimiter = rateLimiter || new RateLimiter({
      maxGlobal: cfg.GMP_RATE_LIMIT_MAX_GLOBAL,
      ratePerMinute: cfg.GMP_INBOUND_RATE_PER_MINUTE,
      burst: cfg.GMP_INBOUND_BURST,
      helloTimeoutMs: cfg.GMP_HELLO_TIMEOUT_MS,
      handshakeTimeoutMs: cfg.GMP_HANDSHAKE_TIMEOUT_MS,
      warnFraction: cfg.GMP_FD_WARN_FRACTION,
      refusalLogIntervalMs: cfg.GMP_REFUSAL_LOG_INTERVAL_MS,
    });
    this.nonceStore = nonceStore;
    // Defence-in-depth only: entries are inserted before key confirmation, so
    // this is not the replay guard. Ephemeral non-repetition is.
    this.sessionKeyLRUSet = sessionKeyLRUSet || new SessionKeyLRUSet();
    // Set in loadIdentity from the durable boot counter; null until then.
    this.ephemeralSource = null;
    this.isPublicPeer = isPublicPeer;
    this.establishedPeers = establishedPeers;
    this.bindingRateLimiter = bindingRateLimiter || (isPublicPeer ? new RateLimiter({
      // Unchanged in effect: at most 2 binding connections per address per
      // minute (was a 2-per-60 s window; now a bucket of 2 refilling 2/min).
      ratePerMinute: 2,
      burst: 2,
      maxGlobal: 20,
      helloTimeoutMs: cfg.GMP_HELLO_TIMEOUT_MS,
      handshakeTimeoutMs: cfg.GMP_HANDSHAKE_TIMEOUT_MS,
    }) : null);
    // Resolved here rather than in GMPLink so link/ never reads configuration.
    this.pingIntervalMs = pingIntervalMs || cfg.GMP_PING_INTERVAL_MS || 30000;
    this.pongTimeoutMs = pongTimeoutMs || cfg.GMP_PING_TIMEOUT_MS || 10000;

    this.forwardRateLimitMax = forwardRateLimitMax ?? cfg.GMP_FORWARD_RATE_LIMIT_PER_SOURCE;
    this.forwardRateLimitWindowMs = forwardRateLimitWindowMs ?? cfg.GMP_RATE_LIMIT_WINDOW_MS;
    this.timestampWindowMs = timestampWindowMs ?? cfg.GMP_TIMESTAMP_WINDOW_MS;

    // Phase 3 Modules
    this.routingTable = new RoutingTable({
      expiryTimeoutMs: cfg.GMP_ROUTE_EXPIRY_MS,
      pruneIntervalMs: cfg.GMP_REANNOUNCE_INTERVAL_MS,
    });
    this.topologyManager = new TopologyManager(this, {
      announceIntervalMs: announceIntervalMs ?? cfg.GMP_REANNOUNCE_INTERVAL_MS,
      sequenceNumLruSize: cfg.GMP_SEQUENCE_NUM_LRU_SIZE,
      topologyTtl: cfg.GMP_TOPOLOGY_TTL,
      validityMs: cfg.GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS,
      sampleSize: cfg.GMP_TOPOLOGY_SAMPLE_SIZE,
      sampleEpochMs: cfg.GMP_TOPOLOGY_SAMPLE_EPOCH_MS,
      routeQueryTtl: cfg.GMP_ROUTE_QUERY_TTL,
    });
    this.forwarder = new Forwarder(this);
    this.virtualConnections = new Map();

    // Key derivation for at-rest encryption
    let cacheKey = null;
    let nonceKey = null;
    if (seedPhrase) {
      cacheKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
      nonceKey = deriveNonceStoreKey(seedPhrase);
    }

    // Phase 4 Modules
    this.peerCache = new PeerCache({
      filePath: peerCachePath || inDataDir('peer-cache.json'),
      strictState: cfg.GMP_STRICT_STATE,
      maxSize: cfg.GMP_PEER_CACHE_MAX_SIZE,
      pruneAgeDays: cfg.GMP_PEER_CACHE_PRUNE_AGE_DAYS,
      pruneFailureThreshold: cfg.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD,
    });

    // Always build a NonceStore unless one was injected.
    if (!this.nonceStore) {
      const stateFile = nonceStorePath || inDataDir('nonce-state.json');
      this.nonceStore = new NonceStore({
        ...(stateFile ? { stateFile } : {}),
        // A dataDir gets the default layout (nonce-claims.log beside the state
        // file); an explicit nonceStorePath keeps NonceStore's own naming.
        ...(!nonceStorePath && this.dataDir ? { claimsFile: inDataDir('nonce-claims.log') } : {}),
        pruneAgeMs: noncePruneAgeMs || cfg.GMP_NONCE_PRUNE_AGE_MS,
        strictState: cfg.GMP_STRICT_STATE,
      });
    }
    if (cacheKey) {
      this.peerCache.setEncryptionKey(cacheKey);
    }
    if (this.nonceStore && nonceKey) {
      this.nonceStore.setEncryptionKey(nonceKey);
    }

    this.peerExchange = new PeerExchangeManager(this, {
      requestIntervalMs: cfg.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS,
      maxPool: cfg.GMP_PEER_CACHE_MAX_SIZE,
    });
    this.bootstrap = new BootstrapManager(this, {
      minPeers: minPeers ?? cfg.GMP_MIN_PEERS,
      parallelCount: bootstrapParallelCount,
      disableBootstrap,
      publicPeersPath,
      stage1TimeoutMs: cfg.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS,
      stage2TimeoutMs: cfg.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS,
      lanTimeoutMs: cfg.GMP_BOOTSTRAP_LAN_TIMEOUT_MS,
      peerExchangeTimeoutMs: cfg.GMP_BOOTSTRAP_PX_TIMEOUT_MS,
      dialTimeoutMs: cfg.GMP_BOOTSTRAP_DIAL_TIMEOUT_MS,
      dialStaggerMs: cfg.GMP_BOOTSTRAP_DIAL_STAGGER_MS,
      lanAny: cfg.GMP_LAN_BOOTSTRAP_ANY,
      healthFile: inDataDir('public-peer-health.json'),
      rebootstrapBackoffInitialMs: cfg.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS,
    });
    // A directory of peers on this subnet, so a Ghost Address still resolves
    // when there is no public peer to flood announcements through. Built in
    // listen(); see lan-discovery.js for why it never dials anything itself.
    const lanDiscoveryOn = lanDiscovery ?? cfg.GMP_LAN_DISCOVERY !== false;
    this.lanDiscoveryEnabled = !!lanDiscoveryOn;
    this.lanDiscoveryOptions = {
      port: lanDiscoveryPort ?? cfg.GMP_LAN_DISCOVERY_PORT,
      group: lanDiscoveryGroup ?? cfg.GMP_LAN_DISCOVERY_GROUP,
    };
    this.lanDiscovery = null;
    this.healthMonitor = new NetworkHealthMonitor(this, {
      checkIntervalMs: cfg.GMP_REANNOUNCE_INTERVAL_MS / 2,
    });
    this.keyRotationManager = new KeyRotationManager(this, { topologyTtl: cfg.GMP_TOPOLOGY_TTL });
    this.reputation = new ReputationManager(this, {
      banDurationMs: reputationBanDurationMs ?? cfg.GMP_BAN_DURATION_MS,
      recoveryIntervalMs: reputationRecoveryIntervalMs ?? cfg.GMP_REPUTATION_RECOVERY_INTERVAL_MS,
    });

    // Record the peer in the cache. Only outbound peers get an address: an
    // inbound source address is undialable and may be a user's IP.
    this.on('connection', ({ link, peerNodeId }) => {
      // A relayed link has no address to remember (and must not leave one).
      if (link && !link.isVirtual && !link.socket.isRelayed && peerNodeId) {
        const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
        const signingPubKeyHex = link.remoteSigningPubkey ? Buffer.from(link.remoteSigningPubkey).toString('hex') : null;
        if (link.isInitiator) {
          this.peerCache.recordSuccess(peerNodeIdHex, link.socket.remoteAddress, link.socket.remotePort, signingPubKeyHex);
        } else {
          // Its key only: key rotation trusts the cache (key-rotation.ts).
          this.peerCache.recordInbound(peerNodeIdHex, signingPubKeyHex);
        }
      }
    });

    this.on('rate-limited', (info) => {
      // Accept-time limits refuse that one connection and ban nobody (CGNAT).
      if ('ip' in info) return;
      // Forwarding limits name a source NodeID: that node, and only it, is banned.
      if (this.reputation) {
        const sourceNodeId = 'sourceNodeId' in info ? info.sourceNodeId : null;
        const nodeIdHex = sourceNodeId ? Buffer.from(sourceNodeId).toString('hex') : null;
        if (nodeIdHex) this.reputation.ban(nodeIdHex, null, 'Rate limit exceeded');
      }
    });

    this._helloTimeoutHandler = ({ linkId }) => {
      const link = this.links.get(linkId);
      if (link) {
        link.destroy(new Error('HELLO timeout'));
      }
    };
    this._handshakeTimeoutHandler = ({ linkId }) => {
      const link = this.links.get(linkId);
      if (link) {
        link.destroy(new Error('Handshake timeout'));
      }
    };

    if (this.rateLimiter) {
      this._setupRateLimiterTimeoutHandlers(this.rateLimiter);
    }
    if (this.bindingRateLimiter) {
      this._setupRateLimiterTimeoutHandlers(this.bindingRateLimiter);
    }

    // Relay tier. The server only on nodes that opt in; any node can
    // hold reservations on, and dial through, someone else's relay.
    this.relayServer = cfg.GMP_RELAY_ENABLED
      ? new RelayServer(() => this.identity, {
          reservationTtlMs: cfg.GMP_RELAY_RESERVATION_TTL_MS,
          maxReservations: cfg.GMP_RELAY_MAX_RESERVATIONS,
          maxReservationsPerSubnet: cfg.GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET,
          reservationRatePerMinute: cfg.GMP_RELAY_RESERVATION_RATE_PER_MINUTE,
          reservationBurst: cfg.GMP_RELAY_RESERVATION_BURST,
          maxCircuitsPerReservation: cfg.GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION,
          maxCircuitBytes: cfg.GMP_RELAY_MAX_CIRCUIT_BYTES,
          maxCircuitDurationMs: cfg.GMP_RELAY_MAX_CIRCUIT_DURATION_MS,
        })
      : null;
    /** Sealed store-and-forward host; null unless this node offers storage. */
    this.storageServer = null;
    /** How long a relay waits for an inbound session to show it is a hop. */
    this.relayRoleObservationMs = cfg.GMP_RELAY_ROLE_OBSERVATION_MS;
    /** @type {Map<string, RelayReservationEntry>} */
    this.relayReservations = new Map();
    /** Storage hosts used this session: key -> { key, nodeId, operator }. */
    this.storageHosts = new Map();
    /** Hosts and operators that have seen this node's real identity this session. */
    this.exposure = new SessionExposure();

    this.natType = 'UNKNOWN';
  }

  /**
   * Store-and-forward frames (0x11-0x15), hop-decrypted. With no storage
   * server, requests are refused with storage-disabled.
   * @param {GMPLink} link
   * @param {number} type
   * @param {Buffer} plaintext
   */
  handleStorageFrame(link, type, plaintext) {
    if (this.storageServer) {
      this.storageServer.handleFrame(link, type, plaintext);
      return;
    }
    const msg = decodeStorage(plaintext);
    if (!msg) return;
    const requestId = msg.control.requestId;
    if (type === MESSAGETYPES.STORE_REQUEST) {
      link.sendRelay(MESSAGETYPES.STORE_ACK, encodeStorage({ requestId, ok: false, reason: 'storage-disabled' }));
    } else if (type === MESSAGETYPES.FETCH_REQUEST) {
      link.sendRelay(MESSAGETYPES.FETCH_RESPONSE, encodeStorage({ requestId, done: true, error: 'storage-disabled' }));
    }
  }

  handleRelayFrame(link, type, plaintext) {
    if (this.relayServer) {
      this.relayServer.handleFrame(link, type, plaintext);
      return;
    }
    if (type === MESSAGETYPES.RELAY_RESERVE || type === MESSAGETYPES.RELAY_CONNECT) {
      const msg = decodeControl(plaintext) || {};
      link.sendRelay(MESSAGETYPES.RELAY_STOP, encodeControl({
        op: type === MESSAGETYPES.RELAY_RESERVE ? 'reserve' : 'connect',
        requestId: msg.requestId,
        reason: 'relay-disabled',
      }));
    }
  }

  /**
   * Hold a reservation on a relay so contacts can reach this node through it.
   * The hop to the relay uses a throwaway identity; the relay never learns
   * this node's NodeID. Renews at 80% of the voucher's lifetime unless
   * autoRenew is false. Incoming circuits become ordinary 'incoming'
   * connections once the dialer completes the GMP handshake.
   * @param {import('./relay/relay-client.js').RelayAddress} addr
   * @param {{ autoRenew?: boolean }} [options]
   */
  async reserveRelay(addr, { autoRenew = true } = {}) {
    if (!this.identity) throw new Error('Identity not loaded');
    const key = hostKey(addr.address, addr.port);
    const existing = this.relayReservations.get(key);
    if (existing) return this._reservationView(existing);

    // Never reserve on a host (or operator) that has seen this node's real identity.
    const refuse = () => new RoleSeparationError('RESERVE_ON_BOOTSTRAP_HOST',
      `Refusing to reserve on ${addr.address}:${addr.port}: that host (or its operator) has seen this node's identity this session`);
    if (this.exposure.hasSeen(key, addr.nodeId || null)) throw refuse();
    if (addr.operator && this.exposure.operators.has(addr.operator)) throw refuse();
    // Hard rule 4: never reserve on a storage host in use.
    const refuseStorage = () => new RoleSeparationError('RESERVE_ON_STORAGE_HOST',
      `Refusing to reserve on ${addr.address}:${addr.port}: that host (or its operator) is this session's storage host`);
    if (this._storageHost(key, addr.nodeId || null, addr.operator || null)) throw refuseStorage();
    const hop = await RelayHop.open(this.transport, addr, { pingIntervalMs: this.pingIntervalMs, pongTimeoutMs: this.pongTimeoutMs, ephemeralSource: this.ephemeralSource });
    if (this.exposure.hasSeen(null, hop.relayNodeId)) {
      hop.close();
      throw refuse();
    }
    if (this._storageHost(null, hop.relayNodeId, null)) {
      hop.close();
      throw refuseStorage();
    }
    let voucher;
    try {
      voucher = await hop.reserve();
    } catch (e) {
      hop.close();
      throw e;
    }

    /** @type {RelayReservationEntry} */
    const entry = {
      hop,
      key,
      relayNodeId: hop.relayNodeId,
      operator: addr.operator || null,
      current: { voucherId: voucher.voucherId, voucher },
      timer: null,
    };
    hop.on('incoming', (conn) => {
      if (!this.identity) { conn.destroy(); return; }
      conn.setSeparationSource(() => this._separationOf(entry));
      conn.acceptAsCallee(this.identity.staticPrivKey, this.identity.staticPubKey);
      this._acceptConnection(conn);
    });
    hop.on('close', () => {
      if (entry.timer) clearTimeout(entry.timer);
      if (this.relayReservations.get(key) === entry) this.relayReservations.delete(key);
    });

    const scheduleRenewal = () => {
      const ttl = entry.current.voucher.expiresAt - Date.now();
      entry.timer = setTimeout(async () => {
        try {
          const renewed = await hop.reserve(entry.current.voucherId);
          entry.current = { voucherId: renewed.voucherId, voucher: renewed };
          scheduleRenewal();
        } catch (e) {
          logger.warn('relay', 'renewal-failed', `Relay reservation renewal failed: ${e.message}`, { reason: e.reason });
        }
      }, Math.max(0, ttl * 0.8));
      if (entry.timer.unref) entry.timer.unref();
    };
    if (autoRenew) scheduleRenewal();

    this.relayReservations.set(key, entry);
    return this._reservationView(entry);
  }

  /** The current voucher held on a relay (and its separation), or null. */
  relayReservation(addr) {
    const entry = this.relayReservations.get(hostKey(addr.address, addr.port));
    return entry ? this._reservationView(entry) : null;
  }

  /**
   * @param {RelayReservationEntry} entry
   * @returns {{ voucherId: string, voucher: import('./relay/relay-protocol.js').Voucher, readonly separation: 'separated' | 'unseparated' }}
   */
  _reservationView(entry) {
    const node = this;
    return {
      voucherId: entry.current.voucherId,
      voucher: entry.current.voucher,
      get separation() { return node._separationOf(entry); },
    };
  }

  /**
   * Separated only while the relay host itself has never seen the real
   * identity and its operator is known and differs from every operator whose
   * infrastructure has. Computed live, so a later exposure demotes it.
   * @param {{ key: string, relayNodeId: string, operator: string | null }} entry
   * @returns {'separated' | 'unseparated'}
   */
  _separationOf(entry) {
    if (this.exposure.hasSeen(entry.key, entry.relayNodeId)) return 'unseparated';
    return this.exposure.separationFor(entry.operator);
  }

  /**
   * The NodeID public-peers.json gives for this address, or null.
   * @param {string} address
   * @param {number} port
   * @returns {string | null}
   */
  _listedNodeIdFor(address, port) {
    const key = hostKey(address, port);
    const entry = loadPublicPeers(this.bootstrap.publicPeersPath || undefined)
      .find((p) => p.nodeId && hostKey(p.address, p.port) === key);
    return entry ? entry.nodeId.toLowerCase() : null;
  }

  /**
   * True when the host (by key or hex NodeID) holds one of this node's
   * reservations, or — given an operator — one of that operator's hosts does.
   */
  _reservationHost(key, nodeIdHex, operator = null) {
    for (const entry of this.relayReservations.values()) {
      if ((key && entry.key === key) || (nodeIdHex && entry.relayNodeId === nodeIdHex)) return true;
      if (operator && entry.operator === operator) return true;
    }
    return false;
  }

  /** True when the host (by key, hex NodeID or operator) is a storage host this node uses. */
  _storageHost(key, nodeIdHex, operator = null) {
    for (const h of this.storageHosts.values()) {
      if ((key && h.key === key) || (nodeIdHex && h.nodeId === nodeIdHex)) return true;
      if (operator && h.operator && h.operator === operator) return true;
    }
    return false;
  }

  /**
   * May this host serve as storage? Throws RoleSeparationError if it (or its
   * named operator) has seen the real identity or holds a reservation.
   * @param {{ address: string, port: number, nodeId?: string, operator?: string }} addr
   */
  checkStorageHost(addr) {
    const key = hostKey(addr.address, addr.port);
    const nodeId = addr.nodeId ? addr.nodeId.toLowerCase() : null;
    const operator = addr.operator && addr.operator !== SELF_OPERATOR ? addr.operator : null;
    if (this.exposure.hasSeen(key, nodeId) || (operator && this.exposure.operators.has(operator))) {
      throw new RoleSeparationError('STORAGE_ON_BOOTSTRAP_HOST',
        `Refusing to use ${addr.address}:${addr.port} as storage: that host (or its operator) has seen this node's identity this session`);
    }
    if (this._reservationHost(key, nodeId, operator)) {
      throw new RoleSeparationError('STORAGE_ON_RELAY_HOST',
        `Refusing to use ${addr.address}:${addr.port} as storage: that host (or its operator) holds this node's relay reservation`);
    }
  }

  /** Record a storage host as in use this session; later bootstrap/relay use of it is refused. */
  noteStorageHost(addr, nodeIdHex) {
    const key = hostKey(addr.address, addr.port);
    this.storageHosts.set(key, { key, nodeId: (nodeIdHex || addr.nodeId || '').toLowerCase() || null, operator: addr.operator || null });
  }

  /**
   * 'separated' only when the storage host is self-hosted, or its operator is
   * known and differs from every operator of infrastructure that has seen the
   * real identity or holds a reservation, none of which was unnamed.
   */
  storageSeparation(addr) {
    if (addr.operator === SELF_OPERATOR) return 'separated';
    if (!addr.operator) return 'unseparated';
    if (this.exposure.hasSeen(hostKey(addr.address, addr.port), addr.nodeId || null)) return 'unseparated';
    for (const entry of this.relayReservations.values()) if (!entry.operator || entry.operator === addr.operator) return 'unseparated';
    return this.exposure.separationFor(addr.operator);
  }

  /**
   * Reach a peer through a relay using its voucher. The circuit is sealed to
   * the peer's static X25519 key and this hop uses a throwaway identity, so the
   * relay sees neither party. Rejects with a RelayError on refusal.
   * @param {import('./relay/relay-client.js').RelayAddress} addr
   * @param {string} voucherId
   * @param {Uint8Array} peerStaticPubKey
   * @param {{ trafficClass?: 'interactive' | 'bulk' }} [options] padding class for the circuit
   */
  async dialRelayed(addr, voucherId, peerStaticPubKey, { trafficClass = 'interactive' } = {}) {
    if (!this.identity) throw new Error('Identity not loaded');
    const hop = await RelayHop.open(this.transport, addr, { pingIntervalMs: this.pingIntervalMs, pongTimeoutMs: this.pongTimeoutMs, ephemeralSource: this.ephemeralSource });
    let circuitId;
    try {
      circuitId = await hop.connect(voucherId);
    } catch (e) {
      hop.close();
      throw e;
    }
    const conn = RelayConnection.dial(hop, circuitId, peerStaticPubKey, { closeHopWhenDone: true, trafficClass });
    // The dialler cannot choose the callee's relay, so an unseparated one is
    // surfaced rather than refused.
    const via = { key: hostKey(addr.address, addr.port), relayNodeId: hop.relayNodeId, operator: addr.operator || null };
    conn.setSeparationSource(() => this._separationOf(via));
    const result = await this._initiateOver(conn);
    // The circuit layer already proved the peer holds peerStaticPubKey's
    // private key; this pins the NodeID it claimed in the handshake to it.
    if (!nodeIdMatchesKeys(result.peerNodeId, peerStaticPubKey, result.link.remoteSigningPubkey)) {
      result.link.destroy(new Error('Relayed peer NodeID does not match the key it was dialled with'));
      throw new RelayError('wrong-peer');
    }
    return result;
  }

  _setupRateLimiterTimeoutHandlers(limiter) {
    limiter.on('hello-timeout', this._helloTimeoutHandler);
    limiter.on('handshake-timeout', this._handshakeTimeoutHandler);
  }

  _removeRateLimiterTimeoutHandlers(limiter) {
    if (limiter) {
      limiter.off('hello-timeout', this._helloTimeoutHandler);
      limiter.off('handshake-timeout', this._handshakeTimeoutHandler);
    }
  }

  now() {
    return Date.now();
  }

  async detectNATType(publicPeers, timeoutMs = 5000) {
    try {
      this.natType = await detectNATType(this, publicPeers, timeoutMs);
    } catch (e) {
      logger.warn('node', 'nat-detection-failed', `NAT type detection failed: ${e.message}`, { err: e.message });
      this.natType = 'UNKNOWN';
    }
    return this.natType;
  }

  async loadIdentity(seedPhrase) {
    this.identity = await deriveIdentityFromSeedPhrase(seedPhrase);
    // The seed phrase is the sealing material for this node's state files.
    this._sealStateAndStart(seedPhrase);
    return this.identity;
  }

  /**
   * Load identity from a raw 32-byte seed supplied via the validated
   * `derivedSeed` factory option (never from env/config). The seed is the
   * X25519 static private key; every key and the NodeID derive from it exactly
   * as the seed-phrase path does, minus PBKDF2. State files are sealed under
   * the seed bytes (not a phrase), so GMP_STRICT_STATE still applies. Sync:
   * there is no PBKDF2 to await.
   * @param {Uint8Array} [derivedSeed] Defaults to the seed stored at construction.
   */
  loadIdentityFromDerivedSeed(derivedSeed = this._derivedSeed) {
    if (!(derivedSeed instanceof Uint8Array) || derivedSeed.length !== 32) {
      throw new Error('loadIdentityFromDerivedSeed: no 32-byte derivedSeed (pass createGMPNode({ derivedSeed }) or an explicit seed)');
    }
    this.identity = identityFromDerivedSeed(derivedSeed);
    // No phrase and no configured GMP_SEED_PHRASE back this node, so the logger
    // cannot match the seed by its static list. Register every representation of
    // the raw seed (= the X25519 static private key) that could appear in a log
    // line, so any of them is withheld. The logger serialises with
    // JSON.stringify (logger.ts), so a seed reaches a line as hex/base64 when
    // it is a string, or as a decimal byte array when a Buffer/Uint8Array is in
    // meta; util.inspect forms ("<Buffer 1a 2b ..>", "Uint8Array(32) [ 26, .. ]")
    // only arise if app code formats the bytes into the message itself.
    const seedBuf = Buffer.from(derivedSeed);
    const bytes = Array.from(seedBuf);
    for (const form of [
      seedBuf.toString('hex'),                                        // contiguous hex
      bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),    // Buffer inspect body: "1a 2b .."
      seedBuf.toString('base64'),
      seedBuf.toString('base64url'),
      bytes.join(','),                                                // tight decimal array: "26,43,.."
      bytes.join(', '),                                               // util.inspect / toString body: "26, 43, .."
    ]) registerSensitiveValue(form);
    this._sealStateAndStart(seedBuf);
    return this.identity;
  }

  /**
   * Shared post-identity setup for both load paths: seal state files under the
   * node's secret material (a phrase string, or raw seed bytes), bind the
   * ephemeral source to the durable boot counter, start storage if enabled, and
   * assert the mandatory security controls.
   * @param {string|Buffer} sealMaterial
   */
  _sealStateAndStart(sealMaterial) {
    if (this.identity) {
      this.identity.nodeIdHex = Buffer.from(this.identity.nodeId).toString('hex');
    }
    const cacheKey = crypto.pbkdf2Sync(sealMaterial, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
    const nonceKey = deriveNonceStoreKey(sealMaterial);
    if (this.peerCache) {
      this.peerCache.setEncryptionKey(cacheKey);
    }
    if (this.nonceStore) {
      this.nonceStore.setEncryptionKey(nonceKey);
    }
    // Bind every ephemeral to a durable boot counter plus a per-process
    // sequence so a repeated RNG output cannot repeat a scalar. Throws if the
    // counter cannot be persisted.
    const boot = advanceBootCounter(this.dataDir ? path.join(this.dataDir, 'boot-counter') : dataPath('boot-counter'));
    this.ephemeralSource = new EphemeralKeySource(boot);
    if (this.config.GMP_STORAGE_ENABLED && !this.storageServer) this._startStorage(sealMaterial);
    this._assertSecurityControls();
  }

  /** Fail loudly if a mandatory security control is missing. */
  _assertSecurityControls() {
    const missing = [];
    if (!this.nonceStore) missing.push('nonceStore (persisted replay claims)');
    if (!this.sessionKeyLRUSet) missing.push('sessionKeyLRUSet (in-process session-key dedupe)');
    if (!this.ephemeralSource) missing.push('ephemeralSource (ephemeral non-repetition, GM-M3-2\')');
    if (!this.reputation) missing.push('reputation (peer banning)');
    if (!this.rateLimiter) missing.push('rateLimiter (HELLO / handshake timeouts)');
    if (missing.length) {
      throw new Error(`GMPNode refusing to run: missing security control(s): ${missing.join(', ')}`);
    }
    return this.identity;
  }

  /**
   * A fresh ephemeral keypair bound to the boot counter. Throws rather than
   * falling back to a plain RNG keypair.
   */
  nextEphemeralKeyPair() {
    if (!this.ephemeralSource) {
      throw new Error('No ephemeral key source: refusing to derive an ephemeral from the bare RNG (GM-M3-2\'). Call loadIdentity first.');
    }
    return this.ephemeralSource.next();
  }

  /**
   * Become a storage host. Blobs live under <dataDir>/storage, sealed at rest
   * with a key derived from the node's secret material (seed phrase, or raw
   * seed bytes on the derivedSeed path).
   * @param {string|Buffer} sealMaterial
   */
  _startStorage(sealMaterial) {
    const cfg = this.config;
    const store = new BlobStore({
      dir: path.join(this.dataDir || DATA_DIR, 'storage'),
      ttlMs: cfg.GMP_SF_TTL_MS,
      maxBlobsPerBucket: cfg.GMP_SF_BUCKET_MAX_BLOBS,
      maxBytesPerBucket: cfg.GMP_SF_BUCKET_MAX_BYTES,
      encryptionKey: crypto.pbkdf2Sync(sealMaterial, 'ghostlink-storage-at-rest-v1', 100000, 32, 'sha256'),
    }).load();
    this.storageServer = new StorageServer(store, {
      fetchBuckets: cfg.GMP_SF_FETCH_BUCKETS,
      fetchMaxBlobs: cfg.GMP_SF_FETCH_MAX_BLOBS,
      depositRatePerMinute: cfg.GMP_SF_DEPOSIT_RATE_PER_MINUTE,
      depositBurst: cfg.GMP_SF_DEPOSIT_BURST,
    });
  }

  rotateKey(newKeypair) {
    if (!this.identity) throw new Error('Identity not loaded');

    const oldNodeId = this.identity.nodeIdHex;
    const oldSigningPrivKey = this.identity.signingPrivKey;

    const newPublicKey = newKeypair.signingPubKeyHex;
    // Operate under the same NodeID the rotation certificate announces.
    const newNodeIdBytes = newKeypair.nodeId
      ? new Uint8Array(newKeypair.nodeId)
      : sha512(newKeypair.signingPubKey);
    const newNodeId = bytesToHex(newNodeIdBytes);

    const rotationTimestamp = Date.now();
    // newNodeId is signed too: it decides where peers re-point the old NodeID,
    // so leaving it outside the signature let any relay rewrite it in transit.
    const msg = oldNodeId + newPublicKey + newNodeId + rotationTimestamp;
    const signatureBytes = signMessage(oldSigningPrivKey, stringToBytes(msg));
    const signature = bytesToHex(signatureBytes);

    const cert = {
      oldNodeId,
      newPublicKey,
      newNodeId,
      rotationTimestamp,
      signature
    };

    // Flood the rotation certificate
    if (this.keyRotationManager) {
      this.keyRotationManager.floodRotation(cert);
    }

    // Switch node's operating identity
    this.identity.signingPrivKey = newKeypair.signingPrivKey;
    this.identity.signingPubKey = newKeypair.signingPubKey;
    this.identity.signingPubKeyHex = newKeypair.signingPubKeyHex;
    
    // Rotate to newNodeId
    this.identity.nodeId = newNodeIdBytes;
    this.identity.nodeIdHex = newNodeId;

    if (newKeypair.staticPrivKey) this.identity.staticPrivKey = newKeypair.staticPrivKey;
    if (newKeypair.staticPubKey) this.identity.staticPubKey = newKeypair.staticPubKey;
    if (newKeypair.staticPubKeyHex) this.identity.staticPubKeyHex = newKeypair.staticPubKeyHex;

    return cert;
  }

  getLinkByNodeId(nodeId) {
    const targetHex = toHex(nodeId);
    for (const link of this.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex === targetHex) {
          return link;
        }
      }
    }
    return null;
  }

  async listen() {
    if (!this.identity) throw new Error('Identity not loaded');

    const bindHost = this.isPublicPeer ? '0.0.0.0' : '::';
    const onError = (err, stillListening) => {
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      logger.error('link', 'listener-error', `Listener error on port ${this.port}: ${e.message}; ${stillListening ? 'still listening' : 'NO LONGER LISTENING'}`, {
        code: e.code || null, syscall: e.syscall || null, stillListening,
      });
    };
    this.listener = await this.transport.listen({ host: bindHost, port: this.port, onError }, (connection) => {
      this._acceptConnection(connection);
    });
    // port 0 asks the transport for a free port; record the one actually
    // bound so announces, LAN beacons and callers see the real port, not 0.
    this.port = this.listener.port;
    this._clampCapToFdLimit();
    this.bootstrap.start();
    if (this.lanDiscoveryEnabled && !this.lanDiscovery) {
      // Loaded here, not at module load: it needs Node's `dgram`.
      const { LanDiscovery } = requireLocal('./lan-discovery.js');
      this.lanDiscovery = new LanDiscovery(this, this.lanDiscoveryOptions);
      // Fire and forget: discovery failing (no multicast, port in use) must
      // never hold up or fail listen().
      this.lanDiscovery.start().catch(() => {});
    }
    return { port: this.port };
  }

  /**
   * effective cap = min(configured cap, soft fd limit - reserve), reserve =
   * max(GMP_FD_HEADROOM, open fds + 16). Logs one line at every start: INFO,
   * or WARN when the clamp applies.
   */
  _clampCapToFdLimit() {
    const limiter = this.rateLimiter;
    if (!limiter || typeof limiter.setEffectiveCap !== 'function') return;
    const configured = limiter.configuredMaxGlobal;
    const { soft, hard } = readFdLimits();
    const open = countOpenFds();
    if (soft === null || open === null) {
      logger.info('link', 'connection-cap',
        `Connection cap ${configured} (configured); descriptor limits unknown on this platform, so not clamped`,
        { configuredCap: configured, fdSoftLimit: soft, fdHardLimit: hard, effectiveCap: configured, clamped: false, limitsKnown: false });
      return;
    }
    const reserve = Math.max(Number(this.config.GMP_FD_HEADROOM) || 0, open + 16);
    const effective = Math.min(configured, Math.max(1, soft - reserve));
    const clamped = effective < configured;
    if (clamped) limiter.setEffectiveCap(effective, 'FD_LIMIT');
    const meta = { configuredCap: configured, fdSoftLimit: soft, fdHardLimit: hard, reserve, openAtStart: open, effectiveCap: effective, clamped, limitsKnown: true };
    if (clamped) {
      logger.warn('link', 'connection-cap',
        `Connection cap CLAMPED from ${configured} to ${effective}: descriptor soft limit ${soft} (hard ${hard ?? '?'}) minus ${reserve} reserved (${open} open at start). Raise the limit (ulimit -n) to serve more`, meta);
    } else {
      logger.info('link', 'connection-cap',
        `Connection cap ${effective} (configured ${configured}; not clamped): descriptor soft limit ${soft} (hard ${hard ?? '?'}) leaves ${soft - reserve} after ${reserve} reserved`, meta);
    }
  }

  _acceptConnection(socket) {
    if (this.reputation && this.reputation.isBanned(null, socket.remoteAddress)) {
      socket.destroy();
      return;
    }

    let activeLimiter = this.rateLimiter;
    if (this.isPublicPeer && this.bindingRateLimiter) {
      activeLimiter = this.bindingRateLimiter;
    }

    if (activeLimiter) {
      if (!activeLimiter.checkConnection(socket)) {
        socket.destroy();
        this.emit('rate-limited', { ip: socket.remoteAddress, type: activeLimiter === this.bindingRateLimiter ? 'binding' : 'standard' });
        return;
      }
    }

    const ephemeralKeyPair = this.nextEphemeralKeyPair();
    const link = new GMPLink({
      identity: this.identity,
      socket,
      isInitiator: false,
      ephemeralKeyPair,
      rateLimiter: activeLimiter,
      nonceStore: this.nonceStore,
      sessionKeyLRUSet: this.sessionKeyLRUSet,
      pingIntervalMs: this.pingIntervalMs,
      pongTimeoutMs: this.pongTimeoutMs,
      node: this,
      isVirtual: false,
      // Only a relay or storage host has hops to tell apart, and a circuit
      // never carries one.
      observeRoleMs: (this.relayServer || this.storageServer) && !socket.isRelayed ? this.relayRoleObservationMs : 0,
    });

    const connId = `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.links.set(connId, link);

    if (activeLimiter) {
      activeLimiter.recordPendingConnection(socket, connId);
    }

    // Nothing in the handshake says whether this is a relay hop; the link
    // observes it from the first frame after key confirmation.
    link.on('classified', ({ role }) => {
      const peerNodeId = link.remoteNodeId;
      // A relay hop is infrastructure, not a peer: no 'connection' event, no
      // peer cache entry, no topology announce, not counted as a peer
      //. It stays in this.links so it is closed with the node.
      if (role === 'hop') {
        if (activeLimiter) activeLimiter.recordHandshakeComplete(connId);
        return;
      }
      const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
      // Whoever completed a handshake with us knows our NodeID.
      if (!link.socket.isRelayed) this.exposure.noteHost(null, peerNodeIdHex);
      if (this.isPublicPeer && this.establishedPeers && this.establishedPeers.has(peerNodeIdHex)) {
        if (this.bindingRateLimiter) {
          this.bindingRateLimiter.recordConnectionClosed(connId);
        }
        if (this.rateLimiter) {
          this.rateLimiter._globalCount++;
          this.rateLimiter.recordHandshakeComplete(connId);
        }
        link.rateLimiter = this.rateLimiter;
      } else {
        if (activeLimiter) {
          activeLimiter.recordHandshakeComplete(connId);
        }
      }

      this.connections.set(connId, link);

      // Relayed links are never announced: an announce would tell the whole
      // mesh, relay included, which two nodes are talking.
      if (!link.isVirtual && !link.socket.isRelayed) {
        this.topologyManager.handleLinkEstablished(peerNodeIdHex);
      }

      this.emit('connection', { connId, link, peerNodeId, type: 'incoming' });
    });

    link.on('message', (msg) => {
      this.emit('message', { connId, msg });
    });

    link.on('close', () => {
      this.links.delete(connId);
      this.connections.delete(connId);
      if (link.rateLimiter) {
        link.rateLimiter.recordConnectionClosed(connId);
      }
      if (!link.isVirtual && link.remoteNodeId) {
        const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
        if (!link.socket.isRelayed && link.role === 'peer') this.topologyManager.handleLinkClosed(peerNodeIdHex);
        this.routingTable.removeRoutesVia(peerNodeIdHex);
      }
      this.emit('close', { connId });
    });

    link.on('error', (err) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', { connId, err });
      } else {
        logger.warn('node', 'link-error', `Link error on ${connId}: ${err.message}`, { connId, err: err.message });
      }
    });
  }

  async dial(address, port = DEFAULT_PORT, options = {}) {
    if (!this.identity) throw new Error('Identity not loaded');
    if (this.reputation && this.reputation.isBanned(null, address)) {
      throw new Error(`Target IP ${address} is banned`);
    }

    // Never show the real identity to a host holding one of our reservations:
    // checked by address and NodeID before sending, and again after handshake.
    const expectedNodeId = (options.nodeId ? String(options.nodeId).toLowerCase() : null)
      || this._listedNodeIdFor(address, port);
    const infraOperator = options.infrastructure && options.infrastructure.operator ? options.infrastructure.operator : null;
    // Separation checks every NodeID any list file gives this name, not just
    // the merged one: an overlay replacing a host's shipped entry must not
    // hide the shipped name from these rules.
    const separationIds = [...new Set([expectedNodeId, ...listedNodeIdsForAddress(address, port, this.bootstrap.publicPeersPath || undefined)])];
    // Hard rule 4: nor to this session's storage host.
    if (separationIds.some((id) => this._storageHost(hostKey(address, port), id, infraOperator))) {
      throw new RoleSeparationError('BOOTSTRAP_VIA_STORAGE_HOST',
        `Refusing to connect to ${address}:${port} with this node's identity: that host (or its operator) is this session's storage host`);
    }
    if (separationIds.some((id) => this._reservationHost(hostKey(address, port), id, infraOperator))) {
      throw new RoleSeparationError('BOOTSTRAP_VIA_RELAY_HOST',
        `Refusing to connect to ${address}:${port} with this node's identity: it holds this node's relay reservation`);
    }

    const useTls = options.tls || port === 443;
    // Rejects on pre-connect failure (e.g. ECONNREFUSED), resolving once the
    // stream is connected — before this point no GMPLink exists.
    const socket = await this.transport.dial({ host: address, port, tls: useTls, servername: address, ...(options.signal ? { signal: options.signal } : {}) });
    // A caller may give up on the dial (the bootstrap ladder does when another
    // dial wins, or this one exceeds its budget): the link is torn down and
    // the dial rejects as closed during the handshake.
    const signal = options.signal || null;
    if (signal && signal.aborted) {
      socket.destroy();
      throw new Error('Dial cancelled');
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const ephemeralKeyPair = this.nextEphemeralKeyPair();
      const link = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: true,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: false
      });

      const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);
      if (signal) {
        signal.addEventListener('abort', () => { if (!settled) link.destroy(new Error('Dial cancelled')); }, { once: true });
      }

      if (this.rateLimiter) {
        this.rateLimiter.recordPendingConnection(socket, connId);
      }

      link.on('connected', ({ peerNodeId }) => {
        settled = true;
        const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
        // The handshake has already shown this host our NodeID; record that
        // (it demotes any reservation there to unseparated), then refuse to
        // keep a link to a reservation host (hard rule 2, NodeID match).
        this.exposure.noteHost(hostKey(address, port), peerNodeIdHex);
        if (options.infrastructure) this.exposure.noteInfrastructure(options.infrastructure.operator);
        if (this._reservationHost(null, peerNodeIdHex)) {
          link.destroy();
          reject(new RoleSeparationError('BOOTSTRAP_VIA_RELAY_HOST',
            `${address}:${port} turned out to be a host holding this node's relay reservation; link refused, reservation now unseparated`));
          return;
        }
        if (this._storageHost(null, peerNodeIdHex)) {
          link.destroy();
          reject(new RoleSeparationError('BOOTSTRAP_VIA_STORAGE_HOST',
            `${address}:${port} turned out to be this session's storage host; link refused, storage now unseparated`));
          return;
        }
        this.connections.set(connId, link);
        if (this.rateLimiter) {
          this.rateLimiter.recordHandshakeComplete(connId);
        }
        if (!link.isVirtual && !link.socket.isRelayed) {
          this.topologyManager.handleLinkEstablished(peerNodeIdHex);
        }
        this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
        resolve({ connId, link, peerNodeId });
      });

      link.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      link.on('close', () => {
        this.links.delete(connId);
        this.connections.delete(connId);
        if (link.rateLimiter) {
          // Outbound: never counted on admission, so only its pending timers are
          // released. Calling recordConnectionClosed here drove the global count
          // one lower per outbound connection.
          link.rateLimiter.releasePending(connId);
        }
        if (!link.isVirtual && link.remoteNodeId) {
          const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
          if (!link.socket.isRelayed && link.role === 'peer') this.topologyManager.handleLinkClosed(peerNodeIdHex);
          this.routingTable.removeRoutesVia(peerNodeIdHex);
        }
        this.emit('close', { connId });
        if (!settled) {
          settled = true;
          reject(new Error('Link closed during handshake'));
        }
      });

      link.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      link._sendHELLO().catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  /**
   * Run the initiator handshake over a connection a transport already made.
   * @param {import('./transport/transport.js').GMPConnection} connection
   */
  async dialWithConnection(connection) {
    if (!this.identity) throw new Error('Identity not loaded');
    return this._initiateOver(connection);
  }

  async dialWithSocket(rawSocket) {
    if (!this.identity) throw new Error('Identity not loaded');

    // Hole punching races raw sockets outside the node and hands the winner
    // in; the transport wraps it into the connection shape links expect.
    const socket = this.transport.adopt ? this.transport.adopt(rawSocket) : rawSocket;
    return this._initiateOver(socket);
  }

  /**
   * Run the initiator handshake over an already-connected GMPConnection and
   * register the link. Shared by dialWithSocket (hole punching) and
   * dialRelayed (a relay circuit).
   * @param {import('./transport/transport.js').GMPConnection} socket
   * @returns {Promise<{ connId: string, link: GMPLink, peerNodeId: Buffer }>}
   */
  _initiateOver(socket) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ephemeralKeyPair = this.nextEphemeralKeyPair();
      const link = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: true,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: false
      });

      const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);

      if (this.rateLimiter) {
        this.rateLimiter.recordPendingConnection(socket, connId);
      }

      link.on('connected', ({ peerNodeId }) => {
        settled = true;
        const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
        if (!socket.isRelayed) this.exposure.noteHost(null, peerNodeIdHex);
        this.connections.set(connId, link);
        if (this.rateLimiter) {
          this.rateLimiter.recordHandshakeComplete(connId);
        }
        if (!link.isVirtual && !link.socket.isRelayed) {
          this.topologyManager.handleLinkEstablished(peerNodeIdHex);
        }
        this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
        resolve({ connId, link, peerNodeId });
      });

      link.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      link.on('close', () => {
        this.links.delete(connId);
        this.connections.delete(connId);
        if (link.rateLimiter) {
          // Outbound: never counted on admission, so only its pending timers are
          // released. Calling recordConnectionClosed here drove the global count
          // one lower per outbound connection.
          link.rateLimiter.releasePending(connId);
        }
        if (!link.isVirtual && link.remoteNodeId) {
          const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
          if (!link.socket.isRelayed && link.role === 'peer') this.topologyManager.handleLinkClosed(peerNodeIdHex);
          this.routingTable.removeRoutesVia(peerNodeIdHex);
        }
        this.emit('close', { connId });
        if (!settled) {
          settled = true;
          reject(new Error('Link closed during handshake'));
        }
      });

      link.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      link._sendHELLO().catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  async dialVirtual(destNodeId) {
    if (!this.identity) throw new Error('Identity not loaded');
    const destHex = toHex(destNodeId);
    if (this.reputation && this.reputation.isBanned(destHex)) {
      throw new Error(`Target peer NodeID ${destHex} is banned`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new VirtualSocket({
        node: this,
        sourceNodeId: this.identity.nodeId,
        destNodeId: destNodeId
      });

      const ephemeralKeyPair = this.nextEphemeralKeyPair();
      const link = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: true,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: true
      });

      const connId = `virtual-outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);

      const destHex = toHex(destNodeId).slice(0, 64);
      this.virtualConnections.set(destHex, link);

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          link.destroy(new Error('Virtual handshake timeout'));
          reject(new Error('Virtual handshake timeout'));
        }
      }, 2000);

      link.on('connected', ({ peerNodeId }) => {
        settled = true;
        clearTimeout(timeoutTimer);
        const peerHex = toHex(peerNodeId).slice(0, 64);
        // The handshake proves who answered, not that it is who we dialled; a
        // relay could otherwise answer with its own identity.
        if (peerHex !== destHex) {
          link.destroy(new Error('Virtual handshake answered by a different node than dialled'));
          reject(new Error('Virtual handshake answered by a different node than dialled'));
          return;
        }
        this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
        resolve({ connId, link, peerNodeId });
      });

      link.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      link.on('close', () => {
        clearTimeout(timeoutTimer);
        this.links.delete(connId);
        if (this.virtualConnections.get(destHex) === link) this.virtualConnections.delete(destHex);
        this.emit('close', { connId });
        if (!settled) {
          settled = true;
          reject(new Error('Link closed during handshake'));
        }
      });

      link.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      link._sendHELLO().catch((e) => {
        clearTimeout(timeoutTimer);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  handleIncomingRoutedPayload(sourceNodeId, payload) {
    const sourceHex = toHex(sourceNodeId).slice(0, 64);
    let virtualLink = this.virtualConnections.get(sourceHex);

    if (!virtualLink) {
      const socket = new VirtualSocket({
        node: this,
        sourceNodeId: this.identity.nodeId,
        destNodeId: sourceNodeId
      });

      const ephemeralKeyPair = this.nextEphemeralKeyPair();
      virtualLink = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: false,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: true
      });

      const connId = `virtual-incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, virtualLink);
      this.virtualConnections.set(sourceHex, virtualLink);

      virtualLink.on('connected', ({ peerNodeId }) => {
        const peerHex = toHex(peerNodeId).slice(0, 64);
        // The routed source prefix is only a claim; require the proven identity to match.
        if (peerHex !== sourceHex) {
          virtualLink.destroy(new Error('Virtual handshake identity does not match routed source'));
          return;
        }
        this.emit('connection', { connId, link: virtualLink, peerNodeId, type: 'incoming' });
      });

      virtualLink.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      virtualLink.on('close', () => {
        this.links.delete(connId);
        if (this.virtualConnections.get(sourceHex) === virtualLink) this.virtualConnections.delete(sourceHex);
        this.emit('close', { connId });
      });

      virtualLink.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
      });
    }

    virtualLink.socket.emit('data', payload);
  }

  get bootstrapStatus() {
    if (this.bootstrap) {
      return {
        stage: this.bootstrap.stage,
        peersConnected: this.bootstrap.getDirectConnectionCount(),
        sufficient: this.bootstrap.getDirectConnectionCount() >= this.bootstrap.minPeers
      };
    }
    return { stage: 'failed', peersConnected: 0, sufficient: false };
  }

  getHealthReport() {
    if (this.healthMonitor) {
      return this.healthMonitor.getHealthReport();
    }
    return null;
  }

  close() {
    this._removeRateLimiterTimeoutHandlers(this.rateLimiter);
    this._removeRateLimiterTimeoutHandlers(this.bindingRateLimiter);

    if (this.topologyManager) {
      this.topologyManager.close();
    }
    if (this.routingTable) {
      this.routingTable.close();
    }
    if (this.peerCache) {
      this.peerCache.close();
    }
    if (this.peerExchange) {
      this.peerExchange.close();
    }
    if (this.lanDiscovery) {
      this.lanDiscovery.close();
      this.lanDiscovery = null;
    }
    if (this.bootstrap) {
      this.bootstrap.close();
    }
    if (this.healthMonitor) {
      this.healthMonitor.close();
    }
    if (this.keyRotationManager) {
      this.keyRotationManager.close();
    }
    if (this.reputation) {
      this.reputation.close();
    }
    for (const entry of this.relayReservations.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.hop.close();
    }
    this.relayReservations.clear();
    if (this.relayServer) {
      this.relayServer.close();
    }
    if (this.storageServer) {
      this.storageServer.close();
    }

    for (const link of this.links.values()) {
      link.destroy();
    }
    this.links.clear();
    this.connections.clear();
    this.virtualConnections.clear();

    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }
    if (this.rateLimiter) {
      this.rateLimiter.close();
    }
    if (this.bindingRateLimiter) {
      this.bindingRateLimiter.close();
    }
    if (this.nonceStore) {
      this.nonceStore.close();
    }
  }
}

export { GMPNode, GMPLink, MESSAGETYPES, DEFAULT_PORT, SessionKeyLRUSet };