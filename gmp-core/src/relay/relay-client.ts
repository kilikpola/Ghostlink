/**
 * Relay tier, client side.
 *
 * RelayHop — one GMP link to a relay under a throwaway identity, carrying
 * reservations, circuit set-up and circuit data.
 *
 * RelayConnection — one circuit as a GMPConnection; the node runs its normal
 * handshake over it, sealed end to end (circuit-crypto.ts) in relay frames.
 */

import { EventEmitter } from 'events';
import { GMPLink } from '../link/link.js';
import type { LinkHost } from '../link/link.js';
import { MESSAGETYPES } from '../link/frame.js';
import { DEFAULT_TIMESTAMP_WINDOW_MS } from '../link/handshake.js';
import type { EphemeralKeySource } from '../link/ephemeral-source.js';
import type { EphemeralKeypair, NodeIdentity } from '../types.js';
import type { GMPConnection, GMPTransport } from '../transport/transport.js';
import type { RelayConnectionEvents, RelayHopEvents } from '../events.js';
import {
  CircuitCipher,
  CIRCUIT_HELLO_LEN,
  RECORD_KIND_CLASS,
  RECORD_KIND_DATA,
  classFromId,
  classRecord,
  maxRecordPayload,
  padRecord,
  unpadRecord,
  type TrafficClass,
} from './circuit-crypto.js';
import {
  RelayError,
  decodeControl,
  decodeRelayData,
  encodeControl,
  encodeRelayData,
  verifyVoucher,
  type RelayStopReason,
  type Voucher,
} from './relay-protocol.js';

/**
 * Open a hop link to an infrastructure host (relay or storage) under a
 * throwaway identity; relay and storage frames go to `onFrame`. A
 * non-ephemeral `identity` is refused before any byte is sent.
 * `ephemeralSource` is required and supplies both the hop identity and the
 * hop's ephemeral key.
 */
export async function openHopLink(
  transport: GMPTransport,
  addr: RelayAddress,
  onFrame: (type: number, plaintext: Buffer) => void,
  opts: { pingIntervalMs?: number; pongTimeoutMs?: number; identity?: NodeIdentity; ephemeralSource: EphemeralKeySource },
): Promise<{ link: GMPLink; identity: NodeIdentity }> {
  // Checked before anything reads opts, so a JS caller that omits it entirely
  // gets this refusal rather than a TypeError.
  if (!opts || !opts.ephemeralSource) {
    throw new RelayError('no-ephemeral-source', 'Refusing to open a hop without an ephemeral key source (GM-M3-2\')');
  }
  if (opts.identity && opts.identity.ephemeral !== true) {
    throw new RelayError('real-identity', 'Refusing to open a hop with a non-ephemeral identity');
  }
  const source = opts.ephemeralSource;
  const hopIdentity = opts.identity ?? source.nextIdentity();
  const useTls = addr.tls === true || addr.port === 443;
  const socket = await transport.dial({ host: addr.address, port: addr.port, tls: useTls, servername: addr.address });

  const host: LinkHost & { nextEphemeralKeyPair: () => EphemeralKeypair } = {
    now: () => Date.now(),
    timestampWindowMs: DEFAULT_TIMESTAMP_WINDOW_MS,
    emit: () => false,
    handleIncomingRoutedPayload: () => {},
    handleRelayFrame: (_link, type, plaintext) => onFrame(type, plaintext),
    handleStorageFrame: (_link, type, plaintext) => onFrame(type, plaintext),
    // So a re-HELLO on this link redraws from the counter, not the bare RNG.
    nextEphemeralKeyPair: () => source.next(),
  };
  const link = new GMPLink({
    identity: hopIdentity,
    socket,
    isInitiator: true,
    ephemeralKeyPair: source.next(),
    pingIntervalMs: opts.pingIntervalMs,
    pongTimeoutMs: opts.pongTimeoutMs,
    node: host,
    isVirtual: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { link.destroy(); reject(new RelayError('timeout', 'Hop handshake timed out')); }, REQUEST_TIMEOUT_MS);
    link.once('connected', () => { clearTimeout(timer); resolve(); });
    link.once('close', () => { clearTimeout(timer); reject(new Error('Hop link closed during handshake')); });
    link.on('error', () => {});
    link._sendHELLO().catch((e: Error) => { clearTimeout(timer); reject(e); });
  });

  const hostNodeId = Buffer.from(link.remoteNodeId).toString('hex');
  if (addr.nodeId && addr.nodeId.toLowerCase() !== hostNodeId) {
    link.destroy();
    throw new RelayError('wrong-relay', 'The host answered with a different NodeID than expected');
  }
  return { link, identity: hopIdentity };
}

export interface RelayAddress {
  address: string;
  port: number;
  /** Expected relay NodeID (hex), e.g. from public-peers.json. Checked when given. */
  nodeId?: string;
  tls?: boolean;
  /** Who runs the relay (public-peers.json `operator`); decides separation. */
  operator?: string;
}

const REQUEST_TIMEOUT_MS = 10000;

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayHop extends EventEmitter<RelayHopEvents> {
  readonly link: GMPLink;
  /** The throwaway identity this hop presents to the relay. */
  readonly hopIdentity: NodeIdentity;
  readonly circuits = new Map<number, RelayConnection>();
  private pendingReserve: Pending<Voucher> | null = null;
  private readonly pendingConnects = new Map<number, Pending<number>>();
  private nextRequestId = 1;

  private constructor(link: GMPLink, hopIdentity: NodeIdentity) {
    super();
    this.link = link;
    this.hopIdentity = hopIdentity;
  }

  /** `opts.ephemeralSource` is required; see openHopLink. */
  static async open(
    transport: GMPTransport,
    addr: RelayAddress,
    opts: { pingIntervalMs?: number; pongTimeoutMs?: number; ephemeralSource: EphemeralKeySource },
  ): Promise<RelayHop> {
    let hop: RelayHop | null = null;
    const { link, identity } = await openHopLink(transport, addr, (type, plaintext) => { if (hop) hop._onFrame(type, plaintext); }, opts);
    hop = new RelayHop(link, identity);
    link.on('close', () => hop._onLinkClosed());
    return hop;
  }

  get relayNodeId(): string {
    return Buffer.from(this.link.remoteNodeId).toString('hex');
  }

  /** Reserve (or renew, with the current voucher ID). Resolves with a verified voucher. */
  reserve(renewVoucherId?: string): Promise<Voucher> {
    if (this.pendingReserve) return Promise.reject(new Error('A reservation request is already in flight'));
    return new Promise<Voucher>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingReserve = null; reject(new RelayError('timeout')); }, REQUEST_TIMEOUT_MS);
      this.pendingReserve = { resolve, reject, timer };
      this._send(MESSAGETYPES.RELAY_RESERVE, encodeControl(renewVoucherId ? { renew: renewVoucherId } : {}));
    });
  }

  /** Open a circuit to the holder of `voucherId`. Resolves with this side's circuit ID. */
  connect(voucherId: string): Promise<number> {
    const requestId = this.nextRequestId++;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingConnects.delete(requestId); reject(new RelayError('timeout')); }, REQUEST_TIMEOUT_MS);
      this.pendingConnects.set(requestId, { resolve, reject, timer });
      this._send(MESSAGETYPES.RELAY_CONNECT, encodeControl({ voucherId, requestId }));
    });
  }

  sendData(circuitId: number, data: Uint8Array): void {
    this._send(MESSAGETYPES.RELAY_DATA, encodeRelayData(circuitId, data));
  }

  stopCircuit(circuitId: number): void {
    if (this.link.state === 'connected') {
      this._send(MESSAGETYPES.RELAY_STOP, encodeControl({ circuitId, reason: 'closed' }));
    }
  }

  close(): void {
    this.link.destroy();
  }

  private _send(type: number, payload: Buffer): void {
    this.link.sendRelay(type, payload);
  }

  /** @internal Called by the hop link's host. */
  _onFrame(type: number, plaintext: Buffer): void {
    if (type === MESSAGETYPES.RELAY_DATA) {
      const frame = decodeRelayData(plaintext);
      if (frame) this.circuits.get(frame.circuitId)?._receive(frame.data);
      return;
    }
    const msg = decodeControl(plaintext);
    if (!msg) return;

    if (type === MESSAGETYPES.RELAY_RESERVATION) {
      const pending = this.pendingReserve;
      if (!pending) return;
      this.pendingReserve = null;
      clearTimeout(pending.timer);
      const v = msg.voucher;
      const ok = verifyVoucher(v, this.link.remoteSigningPubkey)
        && (v as Voucher).relayNodeId === this.relayNodeId
        && (v as Voucher).reserver === this.hopIdentity.nodeIdHex
        && (v as Voucher).expiresAt > Date.now();
      if (ok) pending.resolve(v as Voucher);
      else pending.reject(new RelayError('bad-voucher', 'The relay issued a voucher that does not verify'));
      return;
    }

    if (type === MESSAGETYPES.RELAY_CONNECT) {
      if (typeof msg.circuitId !== 'number') return;
      if (msg.requestId !== undefined) {
        const pending = this.pendingConnects.get(Number(msg.requestId));
        if (!pending) return;
        this.pendingConnects.delete(Number(msg.requestId));
        clearTimeout(pending.timer);
        pending.resolve(msg.circuitId);
      } else {
        const conn = new RelayConnection(this, msg.circuitId, null);
        this.circuits.set(msg.circuitId, conn);
        this.emit('incoming', conn);
      }
      return;
    }

    if (type === MESSAGETYPES.RELAY_STOP) {
      const reason = (typeof msg.reason === 'string' ? msg.reason : 'closed') as RelayStopReason;
      if (msg.op === 'reserve' && this.pendingReserve) {
        const pending = this.pendingReserve;
        this.pendingReserve = null;
        clearTimeout(pending.timer);
        pending.reject(new RelayError(reason));
      } else if (msg.requestId !== undefined && this.pendingConnects.has(Number(msg.requestId))) {
        const pending = this.pendingConnects.get(Number(msg.requestId));
        this.pendingConnects.delete(Number(msg.requestId));
        clearTimeout(pending.timer);
        pending.reject(new RelayError(reason));
      } else if (typeof msg.circuitId === 'number') {
        this.circuits.get(msg.circuitId)?._stopped(reason);
      }
    }
  }

  private _onLinkClosed(): void {
    for (const conn of [...this.circuits.values()]) conn._stopped('peer-gone');
    if (this.pendingReserve) {
      clearTimeout(this.pendingReserve.timer);
      this.pendingReserve.reject(new RelayError('peer-gone'));
      this.pendingReserve = null;
    }
    for (const pending of this.pendingConnects.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelayError('peer-gone'));
    }
    this.pendingConnects.clear();
    this.emit('close');
  }
}

/** One relayed circuit as a GMPConnection. remoteAddress is null: nothing is recorded for the far end. */
export class RelayConnection extends EventEmitter<RelayConnectionEvents> implements GMPConnection {
  readonly remoteAddress: string | null = null;
  readonly remotePort: number | null = null;
  readonly isRelayed = true;
  readonly circuitId: number;
  /** Padding class of this circuit; null on the callee until the dialer's CLASS record arrives. */
  trafficClass: TrafficClass | null = null;
  /** Live separation status of this relay (a getter, so later demotion shows). */
  private separationSource: () => 'separated' | 'unseparated' = () => 'unseparated';
  private readonly hop: RelayHop;
  private cipher: CircuitCipher | null;
  private calleeKeys: { priv: Uint8Array; pub: Uint8Array } | null = null;
  private early: Buffer[] = [];
  private closed = false;
  private closeHopWhenDone = false;

  /** @internal Use RelayConnection.dial, or the hop's 'incoming' event. */
  constructor(hop: RelayHop, circuitId: number, cipher: CircuitCipher | null) {
    super();
    this.hop = hop;
    this.circuitId = circuitId;
    this.cipher = cipher;
  }

  get separation(): 'separated' | 'unseparated' {
    return this.separationSource();
  }

  /** @internal Set by the node that owns the reservation or the dial. */
  setSeparationSource(source: () => 'separated' | 'unseparated'): void {
    this.separationSource = source;
  }

  /**
   * Dialer side: seal to the callee's static key, send the circuit hello, then
   * the CLASS record fixing the padding for both directions.
   */
  static dial(
    hop: RelayHop,
    circuitId: number,
    calleeStaticPub: Uint8Array,
    opts: { closeHopWhenDone?: boolean; trafficClass?: TrafficClass } = {},
  ): RelayConnection {
    const { cipher, hello } = CircuitCipher.forDialer(calleeStaticPub);
    const conn = new RelayConnection(hop, circuitId, cipher);
    conn.closeHopWhenDone = !!opts.closeHopWhenDone;
    conn.trafficClass = opts.trafficClass === 'bulk' ? 'bulk' : 'interactive';
    hop.circuits.set(circuitId, conn);
    hop.sendData(circuitId, hello);
    hop.sendData(circuitId, cipher.seal(classRecord(conn.trafficClass)));
    return conn;
  }

  /** Callee side: the keys the dialer sealed to. Call before handing the connection to a link. */
  acceptAsCallee(staticPrivKey: Uint8Array, staticPubKey: Uint8Array): void {
    this.calleeKeys = { priv: staticPrivKey, pub: staticPubKey };
    const early = this.early;
    this.early = [];
    for (const record of early) this._receive(record);
  }

  write(data: Uint8Array | string, callback?: (err?: Error | null) => void): void {
    if (this.closed || !this.cipher || !this.trafficClass) {
      const err = new Error(this.closed ? 'Relayed connection closed' : 'Relayed connection not ready');
      if (callback) setImmediate(() => callback(err));
      return;
    }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    try {
      const max = maxRecordPayload(this.trafficClass);
      for (let off = 0; off < bytes.length; off += max) {
        const record = padRecord(RECORD_KIND_DATA, bytes.subarray(off, off + max), this.trafficClass);
        this.hop.sendData(this.circuitId, this.cipher.seal(record));
      }
    } catch (e) {
      if (callback) setImmediate(() => callback(e as Error));
      this._close(false);
      return;
    }
    if (callback) setImmediate(() => callback());
  }

  end(): void {
    this._close(true);
  }

  destroy(): void {
    this._close(true);
  }

  /** @internal A sealed record (or, first on the callee side, the circuit hello) arrived. */
  _receive(record: Buffer): void {
    if (this.closed) return;
    if (!this.cipher) {
      if (!this.calleeKeys) { this.early.push(Buffer.from(record)); return; }
      try {
        if (record.length !== CIRCUIT_HELLO_LEN) throw new Error('expected circuit hello');
        this.cipher = CircuitCipher.forCallee(this.calleeKeys.priv, this.calleeKeys.pub, record);
      } catch {
        this._close(true);
      }
      return;
    }
    let kind: number;
    let payload: Buffer;
    try {
      ({ kind, payload } = unpadRecord(this.cipher.open(record)));
    } catch {
      // Wrong key, tampering, reordering, replay or a malformed record:
      // nothing past this point can be trusted, so the circuit goes before
      // the GMP link sees a byte.
      this._close(true);
      return;
    }
    if (!this.trafficClass) {
      // The callee's first sealed record must fix the class.
      const cls = kind === RECORD_KIND_CLASS && payload.length === 1 ? classFromId(payload[0]) : null;
      if (!cls) { this._close(true); return; }
      this.trafficClass = cls;
      return;
    }
    if (kind !== RECORD_KIND_DATA) { this._close(true); return; }
    if (payload.length > 0) this.emit('data', payload);
  }

  /** @internal The relay (or the hop link) ended this circuit. */
  _stopped(reason: RelayStopReason): void {
    if (this.closed) return;
    this.emit('relay-stop', reason);
    this._close(false);
  }

  private _close(sendStop: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.hop.circuits.delete(this.circuitId);
    if (sendStop) {
      try { this.hop.stopCircuit(this.circuitId); } catch { /* hop gone */ }
    }
    if (this.closeHopWhenDone) this.hop.close();
    setImmediate(() => this.emit('close'));
  }
}
