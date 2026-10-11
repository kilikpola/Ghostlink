/**
 * GMPLink — one authenticated, encrypted GMP session over one connection.
 *
 * Handshake: HELLO -> HELLO_ACK (proves the responder's key) -> encrypted PING
 * from the initiator (proves the initiator's key). States: handshaking ->
 * [confirming] -> connected -> closed.
 *
 * Each direction's counter is the AES-GCM nonce, advanced after every
 * seal/open and reported to the nonce store; the session key is claimed once
 * after derivation (ARCHITECTURE_BASELINE.md §7).
 *
 * Nonce state location:
 *   - initiator, real identity: the node's persisted NonceStore;
 *   - ephemeral local identity (our relay hop): EphemeralNonceState;
 *   - responder: EphemeralNonceState until the first non-infrastructure frame
 *     in either direction, when the key is claimed in the persisted store
 *     (refusal tears the link down) before that frame is handled.
 * A responder classifies the link as 'hop' or 'peer' from its first
 * non-keepalive frame after key confirmation (observeRoleMs).
 */

import { EventEmitter } from 'events';
import type { GMPLinkEvents } from '../events.js';
import crypto from 'crypto';
import logger from '../logger.js';
import type { EphemeralKeypair, NodeIdentity } from '../types.js';
import type { GMPConnection } from '../transport/transport.js';
import { MESSAGETYPES, FrameDecoder, encodeFrame } from './frame.js';
import {
  encryptAESGCM,
  decryptAESGCM,
  sealFramePayload,
  openFramePayload,
  deriveLinkKeys,
  bufferEquals,
  fingerprintKey,
  SessionKeyLRUSet,
} from './session.js';
import {
  PROTOCOL_VERSION,
  HELLO_PAYLOAD_LEN,
  HELLO_ACK_PAYLOAD_LEN,
  DEFAULT_TIMESTAMP_WINDOW_MS,
  CLOCK_SKEW_REPORT_MS,
  HANDSHAKE_CONFIRM_TIMEOUT_MS,
  buildHello,
  parseHello,
  buildHelloAck,
  parseHelloAck,
  nodeIdMatchesKeys,
  timestampDelta,
  verifyHandshakeSignature,
} from './handshake.js';
import { Keepalive } from './keepalive.js';
import { EphemeralNonceState } from './ephemeral-nonce-state.js';

export function toHex(nodeId: string | Uint8Array): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

/** Handshake and keepalive: every session carries these; they classify nothing. */
const SESSION_FRAME_TYPES: ReadonlySet<number> = new Set([
  MESSAGETYPES.HELLO, MESSAGETYPES.HELLO_ACK, MESSAGETYPES.PING, MESSAGETYPES.PONG,
]);

/** Relay tier, 0x0C-0x10. */
const RELAY_FRAME_TYPES: ReadonlySet<number> = new Set([
  MESSAGETYPES.RELAY_RESERVE, MESSAGETYPES.RELAY_RESERVATION, MESSAGETYPES.RELAY_CONNECT,
  MESSAGETYPES.RELAY_DATA, MESSAGETYPES.RELAY_STOP,
]);

/** Store-and-forward, 0x11-0x15. */
const STORAGE_FRAME_TYPES: ReadonlySet<number> = new Set([
  MESSAGETYPES.STORE_REQUEST, MESSAGETYPES.STORE_ACK, MESSAGETYPES.FETCH_REQUEST,
  MESSAGETYPES.FETCH_RESPONSE, MESSAGETYPES.RETIRED_0x15,
]);

/**
 * Infrastructure frames (0x0C-0x15): the only frames a hop may carry, and never
 * a reason to move a session into the persisted nonce store.
 */
const INFRA_FRAME_TYPES: ReadonlySet<number> = new Set([...RELAY_FRAME_TYPES, ...STORAGE_FRAME_TYPES]);

export type LinkState = 'handshaking' | 'confirming' | 'connected' | 'closed';

/**
 * 'hop': a one-connection relay hop whose nonce state never leaves memory.
 * 'peer': an ordinary session. 'pending': a responder not yet classified.
 */
export type LinkRole = 'pending' | 'peer' | 'hop';

/** What a link needs from the NonceStore. */
export interface LinkNonceStore {
  claimSessionKey(peerNodeId: Uint8Array, sessionKeyFingerprint: string): { valid: boolean; reason?: string };
  updateCounters(peerNodeId: Uint8Array, sessionKey: Uint8Array, sendCounter: number, recvCounter: number): void;
}

/**
 * What a link's rate limiter must support: the link records HELLO receipt;
 * GMPNode, through link.rateLimiter, records handshake completion and close.
 */
export interface LinkRateLimiter {
  recordHelloReceived(linkId: string): void;
  recordHandshakeComplete(linkId: string): void;
  recordConnectionClosed(linkId: string): void;
  releasePending(linkId: string): void;
}

type RoutedResult =
  | false
  | { local: true; sourceNodeId: Uint8Array; payload: Uint8Array }
  | { local: false; error?: string };

/** The node services a link reports to. */
export interface LinkHost {
  now(): number;
  timestampWindowMs: number;
  reputation?: {
    isBanned(nodeIdHex: string | null, ip?: string | null): boolean;
    penalize(nodeIdHex: string | null, points: number, reason?: string, ip?: string | null): void;
  } | null;
  forwarder?: { processIncoming(plaintext: Uint8Array, link: GMPLink): RoutedResult } | null;
  handleIncomingRoutedPayload(sourceNodeId: Uint8Array, payload: Uint8Array): void;
  topologyManager?: {
    handleReceivedAnnounce(announce: unknown, link: GMPLink): void;
    handleRouteQuery(link: GMPLink, query: any): void; // eslint-disable-line @typescript-eslint/no-explicit-any -- validated inside
    handleRouteAnswer(link: GMPLink, answer: any): void; // eslint-disable-line @typescript-eslint/no-explicit-any -- validated inside
  } | null;
  peerExchange?: {
    handlePeerRequest(link: GMPLink, msg: unknown): void;
    handlePeerResponse(link: GMPLink, msg: unknown): void;
  } | null;
  keyRotationManager?: { handleReceivedRotation(msg: unknown, link: GMPLink): void } | null;
  /** Relay-tier frames (0x0C-0x10), hop-decrypted. Absent: they are ignored. */
  handleRelayFrame?(link: GMPLink, type: number, plaintext: Buffer): void;
  /** Store-and-forward frames (0x11-0x15), hop-decrypted. Absent: they are ignored. */
  handleStorageFrame?(link: GMPLink, type: number, plaintext: Buffer): void;
  emit(event: string, ...args: unknown[]): boolean;
}

export interface GMPLinkOptions {
  identity: NodeIdentity;
  socket: GMPConnection;
  isInitiator: boolean;
  ephemeralKeyPair: EphemeralKeypair;
  rateLimiter?: LinkRateLimiter | null;
  nonceStore?: LinkNonceStore | null;
  sessionKeyLRUSet?: SessionKeyLRUSet | null;
  pingIntervalMs?: number | null;
  pongTimeoutMs?: number | null;
  node?: LinkHost | null;
  isVirtual?: boolean;
  /**
   * Responder only: how long after key confirmation to wait for a hop's first
   * frame before treating the link as a peer. 0 / absent: a peer immediately.
   */
  observeRoleMs?: number | null;
}

export class GMPLink extends EventEmitter<GMPLinkEvents> {
  identity: NodeIdentity;
  socket: GMPConnection;
  isInitiator: boolean;
  remoteNodeId: Buffer | null = null;
  remoteStaticPubkey: Buffer | null = null;
  remoteSigningPubkey: Buffer | null = null;
  ephemeralKeyPair: EphemeralKeypair;

  sendKey: Buffer | null = null;
  recvKey: Buffer | null = null;
  sendNonceCounter = 0;
  recvNonceCounter = 0;
  state: LinkState = 'handshaking';

  confirmTimer: ReturnType<typeof setTimeout> | null = null;

  initiatorNonce: Buffer | null = null;
  initiatorEphemeralPubkey: Buffer | null = null;

  rateLimiter: LinkRateLimiter | null;
  nonceStore: LinkNonceStore | null;
  sessionKeyLRUSet: SessionKeyLRUSet | null;
  node: LinkHost | null;
  isVirtual: boolean;
  role: LinkRole;
  /** Persisted store this responder session moves into; null once moved. */
  private _deferredNonceStore: LinkNonceStore | null = null;
  private readonly _observeRoleMs: number;
  private _roleTimer: ReturnType<typeof setTimeout> | null = null;
  _connId: string;

  private readonly _decoder = new FrameDecoder();
  private readonly _keepalive: Keepalive;

  /** Construct a link over a GMPConnection (see transport/transport.ts). */
  constructor({ identity, socket, isInitiator, ephemeralKeyPair, rateLimiter, nonceStore, sessionKeyLRUSet, pingIntervalMs, pongTimeoutMs, node, isVirtual, observeRoleMs }: GMPLinkOptions) {
    super();
    this.identity = identity;
    this.socket = socket;
    this.isInitiator = isInitiator;
    this.ephemeralKeyPair = ephemeralKeyPair;

    this._keepalive = new Keepalive({
      intervalMs: pingIntervalMs,
      timeoutMs: pongTimeoutMs,
      onInterval: () => {
        if (this.state === 'connected') {
          this._sendPING();
        }
      },
      onTimeout: () => this.destroy(new Error('PONG timeout')),
    });

    this.rateLimiter = rateLimiter;
    // Where nonce state lives: see the header. In-memory stores rather than
    // none, so the claim and high-water guards run on every session.
    if (identity && identity.ephemeral) {
      this.role = 'hop';
      this.nonceStore = new EphemeralNonceState();
    } else if (!isInitiator && nonceStore) {
      this.role = 'pending';
      this._deferredNonceStore = nonceStore;
      this.nonceStore = new EphemeralNonceState();
    } else {
      this.role = isInitiator ? 'peer' : 'pending';
      this.nonceStore = nonceStore;
    }
    this._observeRoleMs = observeRoleMs && observeRoleMs > 0 ? observeRoleMs : 0;
    this.sessionKeyLRUSet = sessionKeyLRUSet;
    this.node = node;
    this.isVirtual = !!isVirtual;
    this._connId = `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this._setupSocketHandlers();
  }

  _updateNonceStore(): void {
    if (this.nonceStore && this.remoteNodeId && this.sendKey) {
      this.nonceStore.updateCounters(
        this.remoteNodeId,
        this.sendKey,
        this.sendNonceCounter,
        this.recvNonceCounter
      );
    }
  }

  /**
   * Claim the session key in the persisted store and move counters there.
   * A refused claim tears the link down; returns false in that case.
   */
  private _promoteNonceState(): boolean {
    const store = this._deferredNonceStore;
    if (!store) return true;
    this._deferredNonceStore = null;
    const result = store.claimSessionKey(this.remoteNodeId, fingerprintKey(this.sendKey));
    if (!result.valid) {
      logger.error('link', 'security-session-key-reuse', `Session key reuse detected: ${result.reason}`, {
        reason: result.reason
      });
      this._penalizeUntrusted(`Session key reuse detected: ${result.reason}`);
      this.destroy(new Error(`Session key reuse detected: ${result.reason}`));
      return false;
    }
    const memory = this.nonceStore;
    this.nonceStore = store;
    if (memory instanceof EphemeralNonceState) memory.close();
    this._updateNonceStore();
    return true;
  }

  /** Settle a pending responder's role, once. */
  private _classify(role: 'peer' | 'hop'): void {
    if (this.role !== 'pending') return;
    this.role = role;
    if (this._roleTimer) { clearTimeout(this._roleTimer); this._roleTimer = null; }
    this.emit('classified', { role });
  }

  /** Encrypt one outgoing frame payload, advance the send counter, persist. */
  private _sealPayload(type: number, plaintext: Uint8Array): Buffer {
    if (!SESSION_FRAME_TYPES.has(type) && !INFRA_FRAME_TYPES.has(type)) {
      if (this.role === 'hop') throw new Error(`Frame type ${type} is not allowed on a relay hop`);
      if (!this._promoteNonceState()) throw new Error('Session refused by the nonce store');
      this._classify('peer');
    }
    const sealed = sealFramePayload(this.sendKey, this.sendNonceCounter, type, plaintext);
    this.sendNonceCounter++;
    this._updateNonceStore();
    return sealed;
  }

  /**
   * Decrypt one incoming frame payload, advance the receive counter, persist.
   * Throws (without advancing) if authentication fails.
   */
  private _openPayload(type: number, payload: Buffer): Buffer {
    const plaintext = openFramePayload(this.recvKey, this.recvNonceCounter, type, Buffer.from(payload));
    this.recvNonceCounter++;
    this._updateNonceStore();
    return plaintext;
  }

  _setupSocketHandlers(): void {
    this.socket.on('data', (data) => this._handleData(data));
    this.socket.on('close', () => this._handleClose());
    this.socket.on('error', (err) => this.emit('error', err));
  }

  _handleData(data: Uint8Array): void {
    this._decoder.push(data);

    // Intercept plain HTTP GET/HEAD requests (e.g. from reverse proxy health checks)
    const buffered = this._decoder.buffered;
    if (buffered.length >= 4) {
      const prefix = buffered.slice(0, 4).toString('utf8');
      if (prefix === 'GET ' || prefix === 'HEAD') {
        const response =
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 20\r\n" +
          "Connection: close\r\n\r\n" +
          '{"status":"healthy"}';
        this.socket.write(response, () => {
          this.socket.end();
        });
        return;
      }
    }

    for (;;) {
      let frame;
      try {
        frame = this._decoder.next();
      } catch (e) {
        this.destroy(new Error('Message too large'));
        return;
      }
      if (!frame) return;
      // Frames already buffered keep being dispatched even if one of them
      // tears the link down; every handler checks state first.
      this._processMessage(frame.type, frame.payload);
    }
  }

  _processMessage(type: number, payload: Buffer): void {
    const sessionFrame = SESSION_FRAME_TYPES.has(type);
    const infraFrame = INFRA_FRAME_TYPES.has(type);
    // A hop exists to carry relay and storage frames. Anything else on it is
    // refused, so a throwaway identity can never become a peer, a route or a
    // cache entry.
    if (this.role === 'hop' && !sessionFrame && !infraFrame) {
      this.destroy(new Error(`Frame type ${type} is not allowed on a relay hop`));
      return;
    }
    // Observe the role on key-confirmed sessions only. The type byte is not yet
    // authenticated; forging it needs an on-path attacker.
    if (this.state === 'connected' && !sessionFrame) {
      if (!infraFrame && !this._promoteNonceState()) return;
      this._classify(infraFrame ? 'hop' : 'peer');
    }
    switch (type) {
      case MESSAGETYPES.HELLO:
        // Catch so a malformed key (X25519 throws) tears down this link
        // instead of crashing the process.
        this._handleHELLO(payload).catch((err) => this.destroy(err));
        break;
      case MESSAGETYPES.HELLO_ACK:
        this._handleHELLO_ACK(payload).catch((err) => this.destroy(err));
        break;
      case MESSAGETYPES.DATA:
        this._handleDATA(payload);
        break;
      case MESSAGETYPES.PING:
        this._handlePING(payload);
        break;
      case MESSAGETYPES.PONG:
        this._handlePONG(payload);
        break;
      case MESSAGETYPES.BINDING_REQUEST:
        this._handleBINDING_REQUEST(payload);
        break;
      case MESSAGETYPES.BINDING_RESPONSE:
        this._handleBINDING_RESPONSE(payload);
        break;
      case MESSAGETYPES.TOPOLOGY_ANNOUNCE:
        this._handleTOPOLOGY_ANNOUNCE(payload);
        break;
      case MESSAGETYPES.PEER_REQUEST:
        this._handlePEER_REQUEST(payload);
        break;
      case MESSAGETYPES.PEER_RESPONSE:
        this._handlePEER_RESPONSE(payload);
        break;
      case MESSAGETYPES.KEY_ROTATION:
        this._handleKEY_ROTATION(payload);
        break;
      case MESSAGETYPES.RELAY_RESERVE:
      case MESSAGETYPES.RELAY_RESERVATION:
      case MESSAGETYPES.RELAY_CONNECT:
      case MESSAGETYPES.RELAY_DATA:
      case MESSAGETYPES.RELAY_STOP:
        this._handleRELAY(type, payload);
        break;
      case MESSAGETYPES.STORE_REQUEST:
      case MESSAGETYPES.STORE_ACK:
      case MESSAGETYPES.FETCH_REQUEST:
      case MESSAGETYPES.FETCH_RESPONSE:
      case MESSAGETYPES.RETIRED_0x15:
        this._handleSTORAGE(type, payload);
        break;
      default:
        this.destroy(new Error(`Unknown message type: ${type}`));
    }
  }

  // ── Handshake ─────────────────────────────────────

  /**
   * Refuse a handshake that claims our own NodeID (reflection or loopback).
   * Not penalised, so loopback/LAN addresses are never banned.
   */
  private _checkNotSelf(remoteNodeId: Buffer, label: string): boolean {
    if (bufferEquals(remoteNodeId, this.identity.nodeId)) {
      this.destroy(new Error(`${label} NodeID is our own (reflected or self-connection)`));
      return false;
    }
    return true;
  }

  /** Check timestamp window and report skew. False if the link was torn down. */
  private _checkHandshakeTimestamp(timestamp: number, remoteNodeId: Buffer, label: string): boolean {
    const now = this.node ? this.node.now() : Date.now();
    const delta = timestampDelta(now, timestamp);
    const windowMs = this.node ? this.node.timestampWindowMs : DEFAULT_TIMESTAMP_WINDOW_MS;
    if (delta > windowMs) {
      this._penalizeSuspicious(`${label} timestamp out of range`);
      this.destroy(new Error(`${label} timestamp out of range`));
      return false;
    }

    if (delta > CLOCK_SKEW_REPORT_MS) {
      this.emit('clock-skew-detected', { delta, remoteNodeId });
      if (this.node) {
        this.node.emit('clock-skew-detected', { delta, link: this, remoteNodeId });
      }
    }
    return true;
  }

  /**
   * Refuse a session key seen before (persisted claim plus in-process LRU).
   * Returns false if the link was torn down.
   */
  private _checkSessionKeyUnique(): boolean {
    // Nonce store uniqueness check (Phase 2a persisted check)
    if (this.nonceStore) {
      const nsResult = this.nonceStore.claimSessionKey(this.remoteNodeId, fingerprintKey(this.sendKey));
      if (!nsResult.valid) {
        logger.error('link', 'security-session-key-reuse', `Session key reuse detected: ${nsResult.reason}`, {
          reason: nsResult.reason
        });
        this._penalizeUntrusted(`Session key reuse detected: ${nsResult.reason}`);
        this.destroy(new Error(`Session key reuse detected: ${nsResult.reason}`));
        return false;
      }
    }

    // Session key uniqueness check (Phase 2a)
    const keyFingerprint = fingerprintKey(this.sendKey);
    if (this.sessionKeyLRUSet) {
      if (this.sessionKeyLRUSet.has(keyFingerprint)) {
        logger.error('link', 'security-duplicate-session-key', `Duplicate session key detected for peer ${Buffer.from(this.remoteNodeId).toString('hex').slice(0, 16)}...`);
        this._penalizeUntrusted('Session key reuse detected');
        this.destroy(new Error('Session key reuse detected - possible attack or crypto bug'));
        return false;
      }
      this.sessionKeyLRUSet.add(keyFingerprint);
    }
    return true;
  }

  async _handleHELLO(payload: Buffer): Promise<void> {
    if (this.state !== 'handshaking') { return; }

    if (this.rateLimiter) {
      this.rateLimiter.recordHelloReceived(this._connId);
    }

    if (payload.length !== HELLO_PAYLOAD_LEN) {
      this.destroy(new Error(`Invalid HELLO payload length: ${payload.length}, expected ${HELLO_PAYLOAD_LEN}`));
      return;
    }

    const hello = parseHello(payload);
    if (hello.version !== PROTOCOL_VERSION) {
      this.destroy(new Error(`Unsupported protocol version: ${payload[0]}`));
      return;
    }

    if (!this._checkNotSelf(hello.nodeId, 'HELLO')) return;

    const initiatorNodeIdHex = Buffer.from(hello.nodeId).toString('hex');
    const remoteIp = this.socket ? this.socket.remoteAddress : null;

    if (this.node && this.node.reputation && this.node.reputation.isBanned(initiatorNodeIdHex, remoteIp)) {
      this.destroy(new Error('Peer is banned'));
      return;
    }

    if (!nodeIdMatchesKeys(hello.nodeId, hello.staticPubkey, hello.signingPubkey)) {
      this._penalizeSuspicious('HELLO NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)');
      this.destroy(new Error('HELLO NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)'));
      return;
    }

    if (!this._checkHandshakeTimestamp(hello.timestamp, hello.nodeId, 'HELLO')) return;

    if (!verifyHandshakeSignature(hello.signingPubkey, hello.signedPortion, hello.signature)) {
      this._penalizeUntrusted('HELLO signature verification failed');
      this.destroy(new Error('HELLO signature verification failed'));
      return;
    }

    this.remoteNodeId = hello.nodeId;
    this.remoteStaticPubkey = hello.staticPubkey;
    this.remoteSigningPubkey = hello.signingPubkey;

    this.initiatorNonce = hello.nonce;
    this.initiatorEphemeralPubkey = hello.ephemeralPubkey;

    // Keys fold in a static<->static exchange so only the NodeID's key holder
    // can complete the handshake. The catch absorbs malformed keys.
    try {
      ({ sendKey: this.sendKey, recvKey: this.recvKey } = deriveLinkKeys({
        isInitiator: false,
        localEphemeralPriv: this.ephemeralKeyPair.ephemeralPriv,
        remoteEphemeralPub: hello.ephemeralPubkey,
        localStaticPriv: this.identity.staticPrivKey,
        remoteStaticPub: hello.staticPubkey,
        localNodeId: this.identity.nodeId,
        remoteNodeId: hello.nodeId,
      }));
    } catch (e) {
      this._penalizeUntrusted('HELLO key agreement failed');
      this.destroy(new Error('HELLO key agreement failed'));
      return;
    }

    if (!this._checkSessionKeyUnique()) return;

    // Encrypt the initiator's nonce as proof-of-key using responder's send key
    // This proves we (responder) successfully derived the session key
    const encryptedProof = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      Buffer.from(hello.nonce),
      null  // No AAD for the proof encryption in Phase 1
    );
    this.sendNonceCounter++;
    this._updateNonceStore();

    // Not connected until the initiator's encrypted PING proves it holds its
    // static key. Set before writing so a fast PING is not dropped.
    this.state = 'confirming';
    this.confirmTimer = setTimeout(() => {
      if (this.state === 'confirming') this.destroy(new Error('Handshake confirmation timeout'));
    }, HANDSHAKE_CONFIRM_TIMEOUT_MS);
    if (this.confirmTimer.unref) this.confirmTimer.unref();
    await this._sendHELLO_ACK(encryptedProof);
  }

  async _handleHELLO_ACK(payload: Buffer): Promise<void> {
    if (this.state !== 'handshaking') { return; }

    if (payload.length !== HELLO_ACK_PAYLOAD_LEN) {
      this.destroy(new Error(`Invalid HELLO_ACK payload length: ${payload.length}, expected ${HELLO_ACK_PAYLOAD_LEN}`));
      return;
    }

    const ack = parseHelloAck(payload);
    if (!this._checkNotSelf(ack.nodeId, 'HELLO_ACK')) return;

    const responderNodeIdHex = Buffer.from(ack.nodeId).toString('hex');
    const remoteIp = this.socket ? this.socket.remoteAddress : null;

    if (this.node && this.node.reputation && this.node.reputation.isBanned(responderNodeIdHex, remoteIp)) {
      this.destroy(new Error('Peer is banned'));
      return;
    }

    if (!nodeIdMatchesKeys(ack.nodeId, ack.staticPubkey, ack.signingPubkey)) {
      this._penalizeSuspicious('HELLO_ACK NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)');
      this.destroy(new Error('HELLO_ACK NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)'));
      return;
    }

    if (!this._checkHandshakeTimestamp(ack.timestamp, ack.nodeId, 'HELLO_ACK')) return;

    if (!verifyHandshakeSignature(ack.signingPubkey, ack.signedPortion, ack.signature)) {
      this._penalizeUntrusted('HELLO_ACK signature verification failed');
      this.destroy(new Error('HELLO_ACK signature verification failed'));
      return;
    }

    this.remoteNodeId = ack.nodeId;
    this.remoteStaticPubkey = ack.staticPubkey;
    this.remoteSigningPubkey = ack.signingPubkey;

    // Same two-exchange derivation as _handleHELLO, from the initiator's side.
    try {
      ({ sendKey: this.sendKey, recvKey: this.recvKey } = deriveLinkKeys({
        isInitiator: true,
        localEphemeralPriv: this.ephemeralKeyPair.ephemeralPriv,
        remoteEphemeralPub: ack.ephemeralPubkey,
        localStaticPriv: this.identity.staticPrivKey,
        remoteStaticPub: ack.staticPubkey,
        localNodeId: this.identity.nodeId,
        remoteNodeId: ack.nodeId,
      }));
    } catch (e) {
      this._penalizeUntrusted('HELLO_ACK key agreement failed');
      this.destroy(new Error('HELLO_ACK key agreement failed'));
      return;
    }

    if (!this._checkSessionKeyUnique()) return;

    // Decrypt proof to verify session key derivation
    // The proof is the initiator's nonce, encrypted with the responder's key
    try {
      const decryptedProof = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(ack.encryptedProof),
        null
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      // Verify the decrypted proof matches our original initiatorNonce
      if (!bufferEquals(Buffer.from(decryptedProof), Buffer.from(this.initiatorNonce))) {
        this._penalizeUntrusted('HELLO_ACK proof verification failed - nonce mismatch');
        this.destroy(new Error('HELLO_ACK proof verification failed - nonce mismatch'));
        return;
      }
    } catch (e) {
      this._penalizeUntrusted('HELLO_ACK proof decryption failed - possible replay or tampering');
      this.destroy(new Error('HELLO_ACK proof decryption failed - possible replay or tampering'));
      return;
    }

    this.state = 'connected';
    // Key confirmation for the responder, sent before anything else on this
    // session so it is the first frame the responder decrypts (_handlePING).
    this._sendPING();
    this._startPingTimer();
    this.emit('connected', { peerNodeId: this.remoteNodeId });
  }

  async _sendHELLO(): Promise<void> {
    // Fresh ephemeral per connection, bound to the node's boot counter when
    // a host provides one; otherwise the caller's explicit keypair is used.
    const src = this.node as (LinkHost & { nextEphemeralKeyPair?: () => EphemeralKeypair }) | null;
    if (src && typeof src.nextEphemeralKeyPair === 'function') {
      this.ephemeralKeyPair = src.nextEphemeralKeyPair();
    } else if (!this.ephemeralKeyPair) {
      throw new Error('No ephemeral key source and no explicit ephemeral keypair: refusing to draw one from the bare RNG (GM-M3-2\')');
    }
    const timestamp = this.node ? this.node.now() : Date.now();
    const initiatorNonce = crypto.randomBytes(32);

    this.initiatorNonce = initiatorNonce;

    const payload = buildHello(this.identity, this.ephemeralKeyPair.ephemeralPub, timestamp, initiatorNonce);
    await this._sendRawMessage(MESSAGETYPES.HELLO, payload);
  }

  async _sendHELLO_ACK(encryptedProof: Buffer): Promise<void> {
    const timestamp = this.node ? this.node.now() : Date.now();
    const payload = buildHelloAck(this.identity, this.ephemeralKeyPair.ephemeralPub, timestamp, encryptedProof);
    await this._sendRawMessage(MESSAGETYPES.HELLO_ACK, payload);
  }

  // ── Keepalive ─────────────────────────────────────

  _handlePING(payload: Buffer): void {
    if (this.state !== 'connected' && this.state !== 'confirming') return;
    try {
      this._openPayload(MESSAGETYPES.PING, payload);
      if (this.state === 'confirming') {
        // Key confirmation from the initiator: only now is its identity proven.
        clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
        this.state = 'connected';
        this._startPingTimer();
        this.emit('connected', { peerNodeId: this.remoteNodeId });
        this._startRoleObservation();
      }
      this._sendPONG();
    } catch (e) {
      this._penalizeSuspicious('PING decryption failed');
      this.destroy(new Error('PING decryption failed'));
    }
  }

  _handlePONG(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      this._openPayload(MESSAGETYPES.PONG, payload);
      this._keepalive.pongReceived();
    } catch (e) {
      this._penalizeSuspicious('PONG decryption failed');
      this.destroy(new Error('PONG decryption failed'));
    }
  }

  _sendPING(): void {
    this._sendRawNoEncrypt(MESSAGETYPES.PING, this._sealPayload(MESSAGETYPES.PING, Buffer.alloc(0)));
    this._keepalive.pingSent();
  }

  _sendPONG(): void {
    this._sendRawNoEncrypt(MESSAGETYPES.PONG, this._sealPayload(MESSAGETYPES.PONG, Buffer.alloc(0)));
  }

  _startPingTimer(): void {
    this._keepalive.start();
  }

  /** A key-confirmed responder: classify now, or give the remote one window to show a hop. */
  private _startRoleObservation(): void {
    if (this.role !== 'pending' || this.state !== 'connected') return;
    if (!this._observeRoleMs) {
      this._classify('peer');
      return;
    }
    this._roleTimer = setTimeout(() => {
      this._roleTimer = null;
      if (this.state === 'connected') this._classify('peer');
    }, this._observeRoleMs);
    if (this._roleTimer.unref) this._roleTimer.unref();
  }

  // ── Application data ──────────────────────────────

  _handleDATA(payload: Buffer): void {
    if (this.state !== 'connected') return;

    try {
      const plaintext = this._openPayload(MESSAGETYPES.DATA, payload);

      if (this.node && this.node.forwarder) {
        const result = this.node.forwarder.processIncoming(plaintext, this);
        if (result) {
          if (result.local) {
            this.node.handleIncomingRoutedPayload(result.sourceNodeId, result.payload);
          }
          return;
        }
      }

      this.emit('message', plaintext.toString('utf8'));
    } catch (e) {
      this._penalizeSuspicious('DATA decryption failed');
      this.destroy(new Error('DATA decryption failed'));
    }
  }

  async send(data: string | Uint8Array): Promise<void> {
    if (this.state !== 'connected') {
      throw new Error('Cannot send on non-connected link');
    }
    const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const encryptedPayload = this._sealPayload(MESSAGETYPES.DATA, plaintext);
    await this._sendRawNoEncrypt(MESSAGETYPES.DATA, encryptedPayload);
  }

  sendRoutedDATA(finalDest: string | Uint8Array, hopCount: number, payload: Uint8Array, sourceNodeId?: Uint8Array): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send on non-connected link');
    }

    const source = sourceNodeId || this.identity.nodeId.slice(0, 32);
    const dest = toHex(finalDest);
    const destBuf = Buffer.from(dest, 'hex').slice(0, 32);

    const plaintext = Buffer.alloc(1 + 32 + 32 + 1 + payload.length);
    plaintext[0] = 0x01; // isRouted
    plaintext.set(source, 1);
    plaintext.set(destBuf, 33);
    plaintext[65] = hopCount;
    plaintext.set(payload, 66);

    this._sendRawNoEncrypt(MESSAGETYPES.DATA, this._sealPayload(MESSAGETYPES.DATA, plaintext));
  }

  // ── Control messages ──────────────────────────────

  _handleBINDING_REQUEST(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      this._openPayload(MESSAGETYPES.BINDING_REQUEST, payload);
      this._sendBINDING_RESPONSE();
    } catch (e) {
      this._penalizeSuspicious('BINDING_REQUEST decryption failed');
      this.destroy(new Error('BINDING_REQUEST decryption failed'));
    }
  }

  _sendBINDING_RESPONSE(): void {
    const remoteAddress = this.socket.remoteAddress;
    const remotePort = this.socket.remotePort;
    const dataBuf = Buffer.from(JSON.stringify({ address: remoteAddress, port: remotePort }), 'utf8');
    this._sendRawNoEncrypt(MESSAGETYPES.BINDING_RESPONSE, this._sealPayload(MESSAGETYPES.BINDING_RESPONSE, dataBuf));
  }

  _handleBINDING_RESPONSE(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      const plaintext = this._openPayload(MESSAGETYPES.BINDING_RESPONSE, payload);
      const info = JSON.parse(plaintext.toString('utf8'));
      this.emit('binding-response', info);
    } catch (e) {
      this._penalizeSuspicious('BINDING_RESPONSE decryption or parsing failed');
      this.destroy(new Error('BINDING_RESPONSE decryption or parsing failed'));
    }
  }

  sendBindingRequest(): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send binding request on non-connected link');
    }
    this._sendRawNoEncrypt(MESSAGETYPES.BINDING_REQUEST, this._sealPayload(MESSAGETYPES.BINDING_REQUEST, Buffer.alloc(0)));
  }

  _handleTOPOLOGY_ANNOUNCE(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      const plaintext = this._openPayload(MESSAGETYPES.TOPOLOGY_ANNOUNCE, payload);
      const announce = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.topologyManager) {
        this.node.topologyManager.handleReceivedAnnounce(announce, this);
      }
    } catch (e) {
      this._penalizeSuspicious('TOPOLOGY_ANNOUNCE decryption failed');
      this.destroy(new Error('TOPOLOGY_ANNOUNCE decryption failed'));
    }
  }

  sendTopologyAnnounce(announce: unknown): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send topology announce on non-connected link');
    }
    const dataBuf = Buffer.from(JSON.stringify(announce), 'utf8');
    this._sendRawNoEncrypt(MESSAGETYPES.TOPOLOGY_ANNOUNCE, this._sealPayload(MESSAGETYPES.TOPOLOGY_ANNOUNCE, dataBuf));
  }

  sendPeerRequest(maxPeers: number): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send peer request on non-connected link');
    }
    const dataBuf = Buffer.from(JSON.stringify({ maxPeers }), 'utf8');
    this._sendRawNoEncrypt(MESSAGETYPES.PEER_REQUEST, this._sealPayload(MESSAGETYPES.PEER_REQUEST, dataBuf));
  }

  /** A route query for a named destination, carried in PEER_REQUEST. */
  sendRouteQuery(routeQuery: unknown): void {
    this._sendJsonFrame(MESSAGETYPES.PEER_REQUEST, { routeQuery });
  }

  /** Send a route answer in PEER_RESPONSE, with `peers: []` for older nodes. */
  sendRouteAnswer(routeAnswer: unknown): void {
    this._sendJsonFrame(MESSAGETYPES.PEER_RESPONSE, { peers: [], routeAnswer });
  }

  private _sendJsonFrame(type: number, obj: unknown): void {
    if (this.state !== 'connected') throw new Error('Link not connected');
    const dataBuf = Buffer.from(JSON.stringify(obj), 'utf8');
    this._sendRawNoEncrypt(type, this._sealPayload(type, dataBuf));
  }

  sendPeerResponse(peers: unknown[]): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send peer response on non-connected link');
    }
    const dataBuf = Buffer.from(JSON.stringify({ peers }), 'utf8');
    this._sendRawNoEncrypt(MESSAGETYPES.PEER_RESPONSE, this._sealPayload(MESSAGETYPES.PEER_RESPONSE, dataBuf));
  }

  _handlePEER_REQUEST(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      const plaintext = this._openPayload(MESSAGETYPES.PEER_REQUEST, payload);
      const msg = JSON.parse(plaintext.toString('utf8'));
      if (msg && msg.routeQuery && this.node && this.node.topologyManager) {
        this.node.topologyManager.handleRouteQuery(this, msg.routeQuery);
      } else if (this.node && this.node.peerExchange) {
        this.node.peerExchange.handlePeerRequest(this, msg);
      }
    } catch (e) {
      this._penalizeSuspicious('PEER_REQUEST decryption failed');
      this.destroy(new Error('PEER_REQUEST decryption failed'));
    }
  }

  _handlePEER_RESPONSE(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      const plaintext = this._openPayload(MESSAGETYPES.PEER_RESPONSE, payload);
      const msg = JSON.parse(plaintext.toString('utf8'));
      if (msg && msg.routeAnswer && this.node && this.node.topologyManager) {
        this.node.topologyManager.handleRouteAnswer(this, msg.routeAnswer);
      } else if (this.node && this.node.peerExchange) {
        this.node.peerExchange.handlePeerResponse(this, msg);
      }
    } catch (e) {
      this._penalizeSuspicious('PEER_RESPONSE decryption failed');
      this.destroy(new Error('PEER_RESPONSE decryption failed'));
    }
  }

  sendKeyRotation(cert: unknown, sequenceNumber: number, ttl: number): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send key rotation on non-connected link');
    }
    const dataBuf = Buffer.from(JSON.stringify({ cert, sequenceNumber, ttl }), 'utf8');
    this._sendRawNoEncrypt(MESSAGETYPES.KEY_ROTATION, this._sealPayload(MESSAGETYPES.KEY_ROTATION, dataBuf));
  }

  _handleKEY_ROTATION(payload: Buffer): void {
    if (this.state !== 'connected') return;
    try {
      const plaintext = this._openPayload(MESSAGETYPES.KEY_ROTATION, payload);
      const msg = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.keyRotationManager) {
        this.node.keyRotationManager.handleReceivedRotation(msg, this);
      }
    } catch (e) {
      this._penalizeSuspicious('KEY_ROTATION decryption failed');
      this.destroy(new Error('KEY_ROTATION decryption failed'));
    }
  }

  // ── Relay tier ────────────────────────────

  _handleRELAY(type: number, payload: Buffer): void {
    if (this.state !== 'connected') return;
    let plaintext: Buffer;
    try {
      plaintext = this._openPayload(type, payload);
    } catch (e) {
      this._penalizeSuspicious('RELAY frame decryption failed');
      this.destroy(new Error('RELAY frame decryption failed'));
      return;
    }
    // Outside the try: a bug in the relay handler is not the peer's fault
    // and must not be reported (or penalised) as a decryption failure.
    if (this.node && this.node.handleRelayFrame) {
      try {
        this.node.handleRelayFrame(this, type, plaintext);
      } catch (e) {
        logger.warn('link', 'relay-handler-failed', `Relay handler failed: ${(e as Error).message}`);
      }
    }
  }

  // ── Store-and-forward ─────────────────────

  _handleSTORAGE(type: number, payload: Buffer): void {
    // As for relay frames: nothing before key confirmation is handled.
    if (this.state !== 'connected') return;
    let plaintext: Buffer;
    try {
      plaintext = this._openPayload(type, payload);
    } catch (e) {
      this._penalizeSuspicious('STORAGE frame decryption failed');
      this.destroy(new Error('STORAGE frame decryption failed'));
      return;
    }
    if (this.node && this.node.handleStorageFrame) {
      try {
        this.node.handleStorageFrame(this, type, plaintext);
      } catch (e) {
        logger.warn('link', 'storage-handler-failed', `Storage handler failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Send one infrastructure frame (relay 0x0C-0x10 or storage 0x11-0x15),
   * sealed with this link's session like any other.
   */
  sendRelay(type: number, payload: Uint8Array): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send relay frame on non-connected link');
    }
    this._sendRawNoEncrypt(type, this._sealPayload(type, payload));
  }

  // ── Transport I/O and teardown ────────────────────

  _sendRawMessage(type: number, payload: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(encodeFrame(type, payload), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _sendRawNoEncrypt(type: number, payload: Uint8Array): void {
    this.socket.write(encodeFrame(type, payload));
  }

  _handleClose(): void {
    this._cleanup();
    this.emit('close');
  }

  _cleanup(): void {
    this._updateNonceStore();
    this._keepalive.stop();
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    if (this._roleTimer) { clearTimeout(this._roleTimer); this._roleTimer = null; }
    // In-memory nonce state is evicted with its connection; a responder
    // session that never carried a non-infrastructure frame is never persisted.
    this._deferredNonceStore = null;
    if (this.nonceStore instanceof EphemeralNonceState) this.nonceStore.close();
    this.state = 'closed';
  }

  destroy(err?: Error): void {
    this._cleanup();
    if (err) this.emit('error', err);
    try {
      this.socket.destroy();
    } catch (e) {}
  }

  _penalizeSuspicious(reason: string): void {
    this._penalize(10, reason);
  }

  _penalizeUntrusted(reason: string): void {
    this._penalize(50, reason);
  }

  _penalizeBanned(reason: string): void {
    this._penalize(100, reason);
  }

  private _penalize(points: number, reason: string): void {
    if (this.node && this.node.reputation) {
      const peerHex = this.remoteNodeId ? Buffer.from(this.remoteNodeId).toString('hex') : null;
      const remoteIp = this.socket ? this.socket.remoteAddress : null;
      this.node.reputation.penalize(peerHex, points, reason, remoteIp);
    }
  }
}
