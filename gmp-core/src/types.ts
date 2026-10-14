import type net from 'net';
import type { GMPTransport, GMPConnection } from './transport/transport.js';
import type { EventEmitter } from 'events';
import type { GMPLinkEvents, GMPNodeEvents } from './events.js';

// ── Message Types ──────────────────────────────────

export const enum MessageType {
  HELLO             = 0x01,
  HELLO_ACK         = 0x02,
  DATA              = 0x03,
  PING              = 0x04,
  PONG              = 0x05,
  BINDING_REQUEST   = 0x06,
  BINDING_RESPONSE  = 0x07,
  TOPOLOGY_ANNOUNCE = 0x08,
  PEER_REQUEST      = 0x09,
  PEER_RESPONSE     = 0x0A,
  KEY_ROTATION      = 0x0B,
}

export const PROTOCOL_VERSION = 0x01;

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

// ── Identity ────────────────────────────────────────

export interface NodeKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface NodeIdentity {
  /**
   * A relay hop identity: used for one connection, never stored or reused.
   * Its nonce state stays in memory.
   */
  ephemeral?: boolean;
  seed: Uint8Array;
  staticPrivKey: Uint8Array;
  staticPubKey: Uint8Array;
  signingPrivKey: Uint8Array;
  signingPubKey: Uint8Array;
  nodeId: Uint8Array;
  nodeIdHex: string;
  staticPubKeyHex: string;
  signingPubKeyHex: string;
  staticPrivKeyHex: string;
  signingPrivKeyHex: string;
}

export interface EphemeralKeypair {
  ephemeralPriv: Uint8Array;
  ephemeralPub: Uint8Array;
}

// ── Session ─────────────────────────────────────────

export interface RawSessionKeys {
  initiatorKey: Uint8Array;
  responderKey: Uint8Array;
}

export interface PeerSession {
  peerNodeId: string;
  isInitiator: boolean;
  sessionKeys: RawSessionKeys;
  sendNonce: number;
  recvNonce: number;
  establishedAt: number;
}

// ── Wire Protocol ───────────────────────────────────

export interface HelloPayload {
  version: number;
  nodeId: string;
  ephemeralPubKey: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
  encryptedProof: Uint8Array;
}

export interface HelloAckPayload {
  version: number;
  nodeId: string;
  ephemeralPubKey: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
  encryptedProof: Uint8Array;
}

export interface DataPayload {
  isRouted: boolean;
  sourceNodeId?: string;
  finalDestinationNodeId?: string;
  hopCount?: number;
  encryptedData: Uint8Array;
}

export interface BindingResponse {
  address: string;
  port: number;
}

export interface TopologyAnnouncePayload {
  announcerNodeId: string;
  connectedToNodeId: string;
  sequenceNumber: number;
  timestamp: number;
  withdrawn: boolean;
  ttl: number;
}

export interface PeerInfo {
  nodeId: string;
  address: string;
  port: number;
  lastSeen: number;
}

export interface PeerRequestPayload {
  maxPeers: number;
}

export interface PeerResponsePayload {
  peers: PeerInfo[];
}

export interface KeyRotationPayload {
  oldNodeId: string;
  /** Hex-encoded signing key. */
  newPublicKey: string;
  newNodeId: string;
  rotationTimestamp: number;
  /** Hex, for the same reason: rotateKey() runs the signature through bytesToHex. */
  signature: string;
}

// ── Routing ─────────────────────────────────────────

export interface RouteEntry {
  destinationNodeId: string;
  nextHopNodeId: string;
  hopCount: number;
  lastUpdated: number;
}

// ── Peer Cache ──────────────────────────────────────

export interface CachedPeer {
  nodeId: string;
  address: string;
  port: number;
  firstSeen: number;
  lastSeen: number;
  connectionCount: number;
  lastFailedAt: number | null;
  failureCount: number;
  /** Recorded on first contact; KeyRotationManager verifies rotations against it. */
  signingPubKey?: string;
  /**
   * Known only because it connected to us: kept for its signing key, with no
   * address. Never dialled, never shared.
   */
  inbound?: boolean;
}

/** What a public host is for. */
export type PeerRole = 'bootstrap' | 'relay' | 'storage';

export interface PublicPeerEntry {
  address: string;
  port: number;
  tls?: boolean;
  nodeId: string;
  addedAt: number;
  lastVerified: number;
  /** Absent in the file means ["bootstrap"]; always set after loadPublicPeers. */
  roles: PeerRole[];
  /** Who runs the host; separation is only claimed for a known, different operator. */
  operator?: string;
  /** Hosting provider (informational). */
  provider?: string;
}

// ── NAT ─────────────────────────────────────────────

export type NatType =
  | 'NO_NAT_OR_FULL_CONE'
  | 'RESTRICTED_CONE'
  | 'SYMMETRIC'
  | 'UNKNOWN';

// ── Config ──────────────────────────────────────────

export interface GMPConfig {
  GMP_PORT: number;
  GMP_BRIDGE_PORT: number;
  GMP_BRIDGE_HOST: string;
  GMP_MIN_PEERS: number;
  GMP_MAX_PEERS: number;
  GMP_MAX_CONNECTIONS: number;
  GMP_HELLO_TIMEOUT_MS: number;
  GMP_HANDSHAKE_TIMEOUT_MS: number;
  GMP_PING_INTERVAL_MS: number;
  GMP_PING_TIMEOUT_MS: number;
  GMP_TIMESTAMP_WINDOW_MS: number;
  GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_LAN_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_PX_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_DIAL_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_DIAL_STAGGER_MS: number;
  GMP_LAN_BOOTSTRAP_ANY: boolean;
  GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: number;
  GMP_RATE_LIMIT_WINDOW_MS: number;
  /** Global concurrent inbound connection cap. Provisional; see config-defaults.ts. */
  GMP_RATE_LIMIT_MAX_GLOBAL: number;
  /** Per-address inbound connection token bucket: refill per minute. */
  GMP_INBOUND_RATE_PER_MINUTE: number;
  /** ...and its capacity. */
  GMP_INBOUND_BURST: number;
  GMP_FORWARD_RATE_LIMIT_PER_SOURCE: number;
  GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: number;
  GMP_SESSION_KEY_LRU_SIZE: number;
  GMP_SEQUENCE_NUM_LRU_SIZE: number;
  GMP_NONCE_PRUNE_AGE_MS: number;
  GMP_ROUTE_EXPIRY_MS: number;
  GMP_TOPOLOGY_TTL: number;
  /** Own-edge signature validity; receivers drop older announces. */
  GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS: number;
  /** Most own edges / peer-exchange entries shown to one requester. */
  GMP_TOPOLOGY_SAMPLE_SIZE: number;
  /** How long a requester's sample stays fixed. */
  GMP_TOPOLOGY_SAMPLE_EPOCH_MS: number;
  /** Hops an on-demand route query may travel. */
  GMP_ROUTE_QUERY_TTL: number;
  GMP_MESSAGE_HOP_LIMIT: number;
  GMP_REANNOUNCE_INTERVAL_MS: number;
  GMP_PEER_CACHE_MAX_SIZE: number;
  GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: number;
  GMP_PEER_CACHE_PRUNE_AGE_DAYS: number;
  GMP_METRICS_PORT: number;
  /** Resource self-measurement interval to stdout; 0 = off. */
  GMP_RESOURCE_LOG_INTERVAL_MS: number;
  /** fd-pressure WARN threshold, as a fraction of the soft descriptor limit. */
  GMP_FD_WARN_FRACTION: number;
  /** Descriptors reserved below the soft limit when clamping the connection cap. */
  GMP_FD_HEADROOM: number;
  /** Interval of the accept-time refusal summary log line. */
  GMP_REFUSAL_LOG_INTERVAL_MS: number;
  GMP_LOG_LEVEL: LogLevel;
  GMP_LOG_TO_FILE: boolean;
  GMP_LOG_TO_CONSOLE: boolean;
  /**
   * Refuse to run on a state file that cannot be authenticated instead of
   * discarding it. Recommended for public peers and unattended nodes.
   */
  GMP_STRICT_STATE: boolean;
  GMP_BAN_DURATION_MS: number;
  GMP_REPUTATION_RECOVERY_INTERVAL_MS: number;

  /** Run the relay tier on this node. Off by default; public peers opt in. */
  GMP_RELAY_ENABLED: boolean;
  /** Voucher lifetime; clients renew at 80% of it. */
  GMP_RELAY_RESERVATION_TTL_MS: number;
  GMP_RELAY_MAX_RESERVATIONS: number;
  /**
   * Concurrent reservations per source /24 (IPv6 /48). A ceiling, not the
   * Sybil control: CGNAT puts hundreds of subscribers behind one address.
   */
  GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET: number;
  /** Anti-Sybil: new reservations per minute per /24 — token bucket refill rate. */
  GMP_RELAY_RESERVATION_RATE_PER_MINUTE: number;
  /** Token bucket capacity per /24: how many may arrive at once before the rate applies. */
  GMP_RELAY_RESERVATION_BURST: number;
  /** Concurrent relayed connections per reserving node. */
  GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION: number;
  GMP_RELAY_MAX_CIRCUIT_BYTES: number;
  GMP_RELAY_MAX_CIRCUIT_DURATION_MS: number;
  GMP_RELAY_ROLE_OBSERVATION_MS: number;
  GMP_STORAGE_ENABLED: boolean;
  GMP_SF_TTL_MS: number;
  GMP_SF_BUCKET_MAX_BLOBS: number;
  GMP_SF_BUCKET_MAX_BYTES: number;
  GMP_SF_FETCH_BUCKETS: number;
  GMP_SF_FETCH_MAX_BLOBS: number;
  GMP_SF_DEPOSIT_RATE_PER_MINUTE: number;
  GMP_SF_DEPOSIT_BURST: number;
  GMP_SF_POLL_INTERVAL_MS: number;
  GMP_SF_STORAGE_PEER: string;
  GMP_SF_DECOY_CHANNELS: number;
  GMP_SF_CURSOR_QUANTUM_MS: number;

  /** LAN discovery beacons. Unset means on; false turns them off. */
  GMP_LAN_DISCOVERY?: boolean;
  GMP_LAN_DISCOVERY_PORT?: number;
  GMP_LAN_DISCOVERY_GROUP?: string;

  /**
   * Seed phrase the identity is derived from. Read from the env variable or
   * constructor option only; loadConfig drops it from config files.
   */
  GMP_SEED_PHRASE?: string;
}

/**
 * GMPNodeManager constructor options: config overrides plus the shorthand
 * aliases the bridge and CLI send (resolved in start()).
 */
export interface GMPNodeManagerOptions extends Partial<GMPConfig> {
  seedPhrase?: string;
  port?: number;
  /** Transport implementation for the node (defaults to TCP). */
  transport?: GMPTransport;
  /** This node's state directory; defaults to GMP_DATA_DIR / paths.ts. */
  dataDir?: string;
  /** Accepted but not forwarded to the node (ARCHITECTURE_BASELINE.md §11). */
  isPublicPeer?: boolean;
  /** Forwarded to GMPNode: no bootstrap dialling (a self-hosted storage peer needs none). */
  disableBootstrap?: boolean;
  /** Run the store-and-forward client (default true; a storage peer has no mailbox of its own). */
  storeForward?: boolean;
}

/**
 * What GMPNode's constructor reads. Individual options override single values
 * from `config`.
 */
export interface GMPNodeConstructorOptions {
  /** Resolved configuration (loadConfig). Absent: built-in DEFAULTS. */
  config?: GMPConfig;
  /** This node's state directory. Absent: the process-wide paths.ts locations. */
  dataDir?: string;
  port?: number;
  seedPhrase?: string;
  /** Injected transport; GMPNode defaults to TcpTransport when absent. */
  transport?: GMPTransport;
  minPeers?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  timestampWindowMs?: number;
  noncePruneAgeMs?: number;
  nonceStorePath?: string;
  peerCachePath?: string;
  publicPeersPath?: string;
  announceIntervalMs?: number;
  forwardRateLimitMax?: number;
  forwardRateLimitWindowMs?: number;
  reputationBanDurationMs?: number;
  reputationRecoveryIntervalMs?: number;
  lanDiscovery?: boolean;
  lanDiscoveryPort?: number;
  lanDiscoveryGroup?: string;
  disableBootstrap?: boolean;
  bootstrapParallelCount?: number;
  isPublicPeer?: boolean;
  /**
   * A raw 32-byte, already-KDF'd seed to build the identity from, in place of a
   * seed phrase. Validated and accepted only as an in-process option by
   * createGMPNode (never env/config); the node then derives every key and the
   * NodeID from it. For mobile (native PBKDF2) and deterministic test identities.
   */
  derivedSeed?: Uint8Array;
}

// ── Structural views of the link.js runtime objects ──

/**
 * Canonical structural contracts for the untyped GMPNode / GMPLink in link.js.
 * Managers needing less should `Pick<>` from these.
 */
export interface GMPLinkLike {
  state: string;
  isVirtual: boolean;
  /** link.js assigns the raw 64-byte NodeID here, never its hex form. */
  remoteNodeId: Uint8Array | null;
  /** The Ed25519 key the peer proved in the handshake (null until then). */
  remoteSigningPubkey?: Uint8Array | null;
  remoteStaticPubkey?: Uint8Array | null;
  socket: {
    remoteAddress?: string;
    remotePort?: number;
    /** A relay circuit. */
    isRelayed?: boolean;
    /** For relay circuits: separated from the hosts knowing our identity or not. */
    separation?: 'separated' | 'unseparated';
  } | null;
  send(data: string): Promise<void>;
  destroy(error?: Error): void;
  on: EventEmitter<GMPLinkEvents>['on'];
  once: EventEmitter<GMPLinkEvents>['once'];
  sendBindingRequest(): void;
  sendRoutedDATA(
    finalDest: string | Uint8Array,
    hopCount: number,
    payload: Uint8Array,
    sourceNodeId: Uint8Array
  ): void;
  sendTopologyAnnounce(announce: TopologyAnnouncePayload): void;
  sendPeerRequest(maxPeers: number): void;
  sendPeerResponse(peers: PeerInfo[]): void;
  /** On-demand route query / answer, carried in PEER_REQUEST / PEER_RESPONSE. */
  sendRouteQuery(query: unknown): void;
  sendRouteAnswer(answer: unknown): void;
  sendKeyRotation(cert: KeyRotationPayload, sequenceNumber: number, ttl: number): void;
  _penalizeSuspicious(reason: string): void;
  _penalizeUntrusted(reason: string): void;
  _penalizeBanned(reason: string): void;
}

/** @see GMPLinkLike for why these live here rather than in each manager. */
export interface GMPNodeLike {
  identity: NodeIdentity | null;
  /** Every link, keyed by connection id, handshaking ones included. */
  links: Map<string, GMPLinkLike>;
  /** The subset that completed a handshake. */
  connections: Map<string, GMPLinkLike>;
  routingTable: RoutingTableLike;
  peerCache: PeerCacheLike;
  bootstrap?: BootstrapLike;
  /** The topology manager's keyed sampler, shared with peer exchange. */
  topologyManager?: {
    sampleSize: number;
    pickSample<T>(link: GMPLinkLike, candidates: T[], idOf: (t: T) => string, size: number): T[];
  };
  /** LAN beacons (bootstrap rung 2); null when LAN discovery is off. */
  lanDiscovery?: {
    getNodeIds(): string[];
    getPeer(nodeId: string): { nodeId: string; address: string; port: number } | null;
    on(event: 'peer-discovered', fn: (p: { nodeId: string; address: string; port: number }) => void): unknown;
    off(event: 'peer-discovered', fn: (p: { nodeId: string; address: string; port: number }) => void): unknown;
  } | null;
  /** Peer exchange (bootstrap rung 4). */
  peerExchange?: { candidates(): Array<{ nodeId: string; address: string; port: number }> } | null;
  reputation?: ReputationManagerLike;
  getLinkByNodeId(nodeId: string | Uint8Array): GMPLinkLike | null;
  dial(address: string, port?: number, options?: DialOptions): Promise<DialResult>;
  dialWithSocket(socket: net.Socket): Promise<DialResult>;
  /** Handshake over a connection the node's transport already made (hole punching, S1). */
  dialWithConnection(connection: GMPConnection): Promise<DialResult>;
  /** The node's transport. */
  transport: GMPTransport;
  /** Typed against GMPNodeEvents (events.ts): emit and on are checked. */
  on: EventEmitter<GMPNodeEvents>['on'];
  off: EventEmitter<GMPNodeEvents>['off'];
  once: EventEmitter<GMPNodeEvents>['once'];
  emit: EventEmitter<GMPNodeEvents>['emit'];
}

export interface DialOptions {
  tls?: boolean;
  /** Set when dialling public-peer infrastructure; records its operator. */
  infrastructure?: { operator: string | null };
  /**
   * Hex NodeID expected at this address, if known. Used only for role
   * separation before connecting.
   */
  nodeId?: string;
  /** Abort the dial: an unfinished handshake is torn down and the dial rejects. */
  signal?: AbortSignal;
}

/** What GMPNode.dial / dialWithSocket resolve to. */
export interface DialResult {
  connId: string;
  link: GMPLinkLike;
  /** The raw 64-byte NodeID (it was typed string; GMPNode resolves a Buffer). */
  peerNodeId: Buffer;
}

export interface RouteLookup {
  nextHopNodeId: string;
  hopCount: number;
}

/** The RoutingTable surface reachable through GMPNodeLike.routingTable. */
export interface RoutingTableLike {
  routes: Map<string, Map<string, unknown>>;
  addRoute(
    dest: string | Buffer | Uint8Array,
    nextHop: string | Buffer | Uint8Array,
    hopCount: number
  ): void;
  getBestRoute(dest: string | Buffer | Uint8Array): RouteLookup | null;
  getAllRoutes(): RouteEntry[];
  removeRoute(dest: string | Buffer | Uint8Array, nextHop: string | Buffer | Uint8Array): void;
  removeRoutesVia(deadNodeId: string | Buffer | Uint8Array): void;
}

/** The PeerCache surface reachable through GMPNodeLike.peerCache. */
export interface PeerCacheLike {
  cache: CachedPeer[];
  getCandidates(): CachedPeer[];
  getDirectPeers24h(): CachedPeer[];
  recordFailure(nodeId: string): void;
  replaceNodeId(oldNodeId: string, newNodeId: string, newPublicKey: string): boolean;
}

/** The ReputationManager surface reachable through GMPNodeLike.reputation. */
export interface ReputationManagerLike {
  isBanned(nodeIdHex: string, ip?: string | null): boolean;
}

/** The BootstrapManager surface reachable through GMPNodeLike.bootstrap. */
export interface BootstrapLike {
  minPeers: number;
  isBootstrapping: boolean;
  start(): Promise<void>;
  attemptCandidates(): void;
}

// ── Health ──────────────────────────────────────────

export type NodeHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'isolated'
  | 'bootstrapping';

export interface HealthReport {
  status: NodeHealthStatus;
  currentPeerCount: number;
  peakPeerCount: number;
  messagesForwarded: number;
  messagesDroppedNoRoute: number;
  messagesDroppedTTL: number;
  uptimeSeconds: number;
  bootstrapAttempts: number;
}

// ── Reputation ──────────────────────────────────────

export type ReputationEvent =
  | 'signature-failure'
  | 'malformed-message'
  | 'rate-limit-hit'
  | 'forged-node-id'
  | 'clock-skew';

export type PeerTrustLevel =
  | 'trusted'
  | 'suspicious'
  | 'untrusted'
  | 'banned';

// ── Wire framing helpers ─────────────────────────────

export interface WireFrame {
  messageType: MessageType;
  payload: Uint8Array;
}

export interface HandshakeProps {
  nodeId: string;
  address: string;
  port: number;
  isInitiator: boolean;
  stage: 'connecting' | 'hello' | 'hello_ack' | 'complete' | 'failed';
  ephemeralPriv?: Uint8Array;
  ephemeralPub?: Uint8Array;
  peerEphemeralPub?: Uint8Array;
  sharedSecret?: Uint8Array;
  initiatorKey?: Uint8Array;
  responderKey?: Uint8Array;
  sendCipherState?: CipherState;
  recvCipherState?: CipherState;
}

export interface CipherState {
  key: Uint8Array;
  nonce: number;
}

export interface NonceEntry {
  nonce: number;
  sequenceNum: number;
  expiresAt: number;
}

export interface ForwarderStats {
  messagesForwarded: number;
  messagesDroppedNoRoute: number;
  messagesDroppedTTL: number;
}

// ── Socket helpers ──────────────────────────────────

export type SocketSide = 'client' | 'server';

// ── Logger interface ────────────────────────────────

export interface LogMeta {
  [key: string]: unknown;
}

// ── TLS / IPC bridge types ───────────────────────────

export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export interface OriginCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Thrown when GMP_STRICT_STATE refuses an unauthenticated state file. A distinct
 * type so broad load() catches can rethrow it.
 */
export class StateAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateAuthenticationError';
  }
}
