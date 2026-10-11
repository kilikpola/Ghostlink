/**
 * GMP event contracts: one map per emitter, event name -> listener argument
 * tuple. Emitters extend EventEmitter<Map>, so emit/on are type-checked;
 * event-contract-test.js checks payloads at runtime.
 */

import type { GMPLink } from './link/link.js';
import type { RouteEntry } from './types.js';
import type { BootstrapDiagnosis } from './bootstrap.js';
import type { RelayConnection } from './relay/relay-client.js';

// ── L2: link ────────────────────────────────────────

export interface GMPLinkEvents {
  /** Handshake complete and, on the responder, key-confirmed. */
  connected: [info: { peerNodeId: Buffer }];
  /**
   * Responder only: the role observed from the first non-keepalive frame after
   * key confirmation, or 'peer' when the window closes. Emitted once.
   */
  classified: [info: { role: 'peer' | 'hop' }];
  /** Decrypted non-routed DATA, as UTF-8 text. */
  message: [text: string];
  /**
   * Reply to sendBindingRequest(). Peer-controlled JSON, so `unknown`:
   * consumers must validate it (see isBindingResponse in public-peer-list.ts).
   */
  'binding-response': [info: unknown];
  /** Handshake timestamp in window but more than CLOCK_SKEW_REPORT_MS off. */
  'clock-skew-detected': [info: { delta: number; remoteNodeId: Buffer }];
  error: [err: Error];
  close: [];
}

// ── L3: node ────────────────────────────────────────

export interface RoutingDegradedInfo {
  droppedInLast5M: number;
  totalForwarded: number;
}

export type NodeRateLimitedInfo =
  /** A connection refused at accept time by a RateLimiter. */
  | { ip: string | undefined; type: 'binding' | 'standard' }
  /** A routed frame refused by the forwarder's per-source limit. */
  | { sourceNodeId: Uint8Array | null; type: 'forward' };

export interface GMPNodeEvents {
  connection: [info: { connId: string; link: GMPLink; peerNodeId: Buffer; type: 'incoming' | 'outgoing' }];
  /** Re-emitted GMPLink 'message'; msg is the link's UTF-8 text. */
  message: [info: { connId: string; msg: string }];
  close: [info: { connId: string }];
  /** Emitted only when someone listens; otherwise link errors are logged. */
  error: [info: { connId: string; err: Error }];
  'clock-skew-detected': [info: { delta: number; link: GMPLink; remoteNodeId: Buffer }];
  'rate-limited': [info: NodeRateLimitedInfo];
  /** finalDestinationNodeId: hex of the 32-byte routed destination prefix. */
  'no-route': [info: { finalDestinationNodeId: string }];
  'ttl-expired': [info: { finalDestinationNodeId: string; hopCount: number }];
  forwarded: [info: { sourceNodeId: string; finalDestinationNodeId: string; hopCount: number }];
  'routing-degraded': [info: RoutingDegradedInfo];
  /** Positional, re-emitted from BootstrapManager. */
  'bootstrap-complete': [peersConnected: number];
  'bootstrap-failed': [peersConnected: number, diagnosis: BootstrapDiagnosis];
  'key-rotated': [info: { oldNodeId: string; newNodeId: string }];
}

// ── L6: application ─────────────────────────────────

export interface GMPNodeManagerEvents {
  'external-address': [info: { address: string; port: number }];
  /** transport is 'relayed-unseparated' when the relay is not separated from identity-aware hosts. */
  'peer-connected': [info: { nodeId: string; address: string | null; port: number | null; transport: 'direct' | 'relayed' | 'relayed-unseparated' }];
  'peer-disconnected': [info: { nodeId: string }];
  /** via 'mailbox': fetched from store-and-forward, not received live. */
  message: [info: { fromNodeId: string; payload: string; via?: 'mailbox' }];
  /** The storage host acknowledged the deposit — SENT (stored). */
  'sf-stored': [info: { localId: string; destNodeId: string }];
  /** The recipient's sealed receipt for this message arrived in our mailbox: DELIVERED. */
  'sf-delivered': [info: { localId: string; destNodeId: string }];
  /** No receipt within two TTLs; none can arrive any more. Not proof the message was unread. */
  'sf-expired': [info: { localId: string; destNodeId: string }];
  /** This user's mailbox and whether it is separated from bootstrap/relay. */
  'storage-status': [info: { host: string | null; separation: 'separated' | 'unseparated' | 'none'; selfHosted: boolean; pending: number }];
  'bootstrap-complete': [info: { peersConnected: number }];
  'bootstrap-failed': [info: { peersConnected: number; diagnosis: BootstrapDiagnosis | null }];
  'routing-degraded': [info: RoutingDegradedInfo];
}

// ── Subsystems ──────────────────────────────────────

export interface RateLimiterEvents {
  'rate-limited': [info: { ip: string; reason: 'global-cap-reached' | 'address-rate'; code: 'GLOBAL_CAP' | 'FD_LIMIT' | 'ADDRESS_RATE'; current: number; limit?: number }];
  'hello-timeout': [info: { linkId: string; ip: string }];
  'handshake-timeout': [info: { linkId: string; ip: string }];
}

export interface RoutingTableEvents {
  'route-added': [route: RouteEntry];
  'route-removed': [route: RouteEntry];
  'route-expired': [route: RouteEntry];
}

export interface ReputationEvents {
  ban: [info: { nodeId: string | null; ip: string | null; expiresAt: number; reason: string }];
}

export interface PeerExchangeEvents {
  'candidates-added': [count: number];
}

export interface BootstrapEvents {
  'bootstrap-complete': [peersConnected: number];
  'bootstrap-failed': [peersConnected: number, diagnosis: BootstrapDiagnosis];
}

export interface KeyRotationEvents {
  'key-rotated': [info: { oldNodeId: string; newNodeId: string }];
}

export interface NetworkHealthEvents {
  'routing-degraded': [info: RoutingDegradedInfo];
}

/** lan-discovery.ts */
export interface LanDiscoveryEvents {
  'peer-discovered': [info: { nodeId: string; address: string; port: number }];
}

// ── Relay tier ──────────────────────────────

export interface RelayHopEvents {
  /** The relay opened a circuit to this reservation. */
  incoming: [conn: RelayConnection];
  close: [];
}

/** A relayed circuit presented as a GMPConnection (data/close/error as in transport.ts). */
export interface RelayConnectionEvents {
  data: [chunk: Buffer];
  close: [];
  error: [err: Error];
  /** The relay ended the circuit; reason is a RELAY_STOP reason code. */
  'relay-stop': [reason: string];
}

/** Emitters that extend EventEmitter but emit nothing. */
export type NoEvents = Record<never, never>;

// ── Store-and-forward client ─────────────────

export interface StoreForwardEvents {
  stored: [info: { localId: string; destNodeId: string }];
  delivered: [info: { localId: string; destNodeId: string }];
  expired: [info: { localId: string; destNodeId: string }];
  message: [info: { fromNodeId: string; payload: string; blobId: string }];
  'poll-complete': [info: import('./storage/store-forward.js').PollReport];
}
