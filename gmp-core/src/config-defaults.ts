/**
 * Built-in configuration defaults. Side-effect free, so node-level modules can
 * use them without loading process-wide configuration (config.ts).
 */

import type { GMPConfig } from './types.js';

export const DEFAULTS: Readonly<GMPConfig> = Object.freeze({
  GMP_PORT: 49500,
  GMP_BRIDGE_PORT: 3002,
  GMP_BRIDGE_HOST: '127.0.0.1',
  GMP_MIN_PEERS: 3,
  GMP_MAX_PEERS: 100,
  GMP_MAX_CONNECTIONS: 100,
  GMP_HELLO_TIMEOUT_MS: 10000,
  GMP_HANDSHAKE_TIMEOUT_MS: 10000,
  GMP_PING_INTERVAL_MS: 30000,
  GMP_PING_TIMEOUT_MS: 10000,
  GMP_TIMESTAMP_WINDOW_MS: 120000,
  /** Bootstrap ladder budgets: rung 1 peer cache. Sum of the four rungs is the worst case to manual entry. */
  GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 1500,
  /** Rung 3: public-peers.json. */
  GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 4000,
  /** Rung 2: LAN discovery (skipped when LAN discovery is off). */
  GMP_BOOTSTRAP_LAN_TIMEOUT_MS: 1000,
  /** Rung 4: peers learned by peer exchange. */
  GMP_BOOTSTRAP_PX_TIMEOUT_MS: 1000,
  /** Per-dial cap; short enough to free a slot within the public rung's budget. */
  GMP_BOOTSTRAP_DIAL_TIMEOUT_MS: 2500,
  /** Minimum gap between two bootstrap dial starts within a rung. */
  GMP_BOOTSTRAP_DIAL_STAGGER_MS: 500,
  /** Rung 2 may dial LAN peers this node has never met. Off: lan-discovery never introduces strangers. */
  GMP_LAN_BOOTSTRAP_ANY: false,
  GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: 30000,
  GMP_RATE_LIMIT_WINDOW_MS: 60000,
  /**
   * Global concurrent inbound connection cap. Provisional: sized for a 0.5 GB
   * host at ~340 KiB RSS per connection with ~40% headroom.
   */
  GMP_RATE_LIMIT_MAX_GLOBAL: 540,
  /**
   * Per-address inbound token bucket: `burst` at once, regaining this many per
   * minute. There is no per-address concurrent cap (CGNAT).
   */
  GMP_INBOUND_RATE_PER_MINUTE: 30,
  GMP_INBOUND_BURST: 256,
  GMP_FORWARD_RATE_LIMIT_PER_SOURCE: 500,
  GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: 60000,
  GMP_SESSION_KEY_LRU_SIZE: 50,
  GMP_SEQUENCE_NUM_LRU_SIZE: 1000,
  GMP_NONCE_PRUNE_AGE_MS: 7776000000,
  GMP_ROUTE_EXPIRY_MS: 300000,
  GMP_TOPOLOGY_TTL: 16,
  GMP_MESSAGE_HOP_LIMIT: 16,
  GMP_REANNOUNCE_INTERVAL_MS: 60000,
  /** Own edges are signed once per validity window; older announces are dropped. */
  GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS: 10 * 60 * 1000,
  /**
   * Most of its own edges a node shows one peer: a sample fixed per (requester
   * address key, epoch). Also the peer-exchange response size.
   */
  GMP_TOPOLOGY_SAMPLE_SIZE: 8,
  GMP_TOPOLOGY_SAMPLE_EPOCH_MS: 24 * 60 * 60 * 1000,
  /** On-demand route query for a named destination: hops it may travel. */
  GMP_ROUTE_QUERY_TTL: 3,
  GMP_PEER_CACHE_MAX_SIZE: 500,
  GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: 10,
  GMP_PEER_CACHE_PRUNE_AGE_DAYS: 30,
  GMP_METRICS_PORT: 9090,
  /** Log RSS, open fds and links to stdout this often. 0: off. */
  GMP_RESOURCE_LOG_INTERVAL_MS: 0,
  /** With the resource log on, warn once open fds pass this fraction of the soft limit. */
  GMP_FD_WARN_FRACTION: 0.8,
  /**
   * Descriptors kept back from inbound connections: effective cap =
   * min(GMP_RATE_LIMIT_MAX_GLOBAL, soft fd limit - max(this, open fds + 16)).
   */
  GMP_FD_HEADROOM: 64,
  /** Accept-time refusals: the first is logged at once, then a count per this interval. */
  GMP_REFUSAL_LOG_INTERVAL_MS: 10000,
  GMP_LOG_LEVEL: 'INFO',
  GMP_LOG_TO_FILE: false,
  GMP_LOG_TO_CONSOLE: true,
  GMP_STRICT_STATE: false,
  GMP_BAN_DURATION_MS: 86400000,
  GMP_REPUTATION_RECOVERY_INTERVAL_MS: 60000,
  GMP_RELAY_ENABLED: false,
  GMP_RELAY_RESERVATION_TTL_MS: 30 * 60 * 1000,
  GMP_RELAY_MAX_RESERVATIONS: 1024,
  GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET: 256,
  GMP_RELAY_RESERVATION_RATE_PER_MINUTE: 30,
  GMP_RELAY_RESERVATION_BURST: 256,
  GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION: 8,
  GMP_RELAY_MAX_CIRCUIT_BYTES: 64 * 1024 * 1024,
  GMP_RELAY_MAX_CIRCUIT_DURATION_MS: 60 * 60 * 1000,
  /** How long a relay or storage host waits for an inbound session's first frame before calling it a peer. */
  GMP_RELAY_ROLE_OBSERVATION_MS: 2000,
  /** This node offers sealed store-and-forward storage (a storage host). */
  GMP_STORAGE_ENABLED: false,
  /** Blob lifetime; expiry is a hard delete. */
  GMP_SF_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  GMP_SF_BUCKET_MAX_BLOBS: 256,
  GMP_SF_BUCKET_MAX_BYTES: 16 * 1024 * 1024,
  /** Every FETCH_REQUEST carries exactly this many bucket ids. */
  GMP_SF_FETCH_BUCKETS: 4,
  /** Most blobs one FETCH_RESPONSE returns, oldest first. */
  GMP_SF_FETCH_MAX_BLOBS: 256,
  /** Deposits per /24 (IPv6 /48), as a token bucket with its own quota. */
  GMP_SF_DEPOSIT_RATE_PER_MINUTE: 30,
  GMP_SF_DEPOSIT_BURST: 256,
  /** Mean poll interval; each poll is jittered to 0.5x-1.5x of it. */
  GMP_SF_POLL_INTERVAL_MS: 15 * 60 * 1000,
  /** Self-hosted mailbox: "host:port" or "host:port#nodeIdHex". Empty: pick a public storage host. */
  GMP_SF_STORAGE_PEER: '',
  /** Fake channels polled like real ones, so decoy entries rotate and carry cursors like real ones. */
  GMP_SF_DECOY_CHANNELS: 2,
  /**
   * Round fetch cursors down to this many ms so clients behind one address are
   * indistinguishable. 0: exact.
   */
  GMP_SF_CURSOR_QUANTUM_MS: 300_000,
});
