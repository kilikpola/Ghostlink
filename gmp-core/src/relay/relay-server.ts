/**
 * Relay server: holds reservations (signed, time-boxed vouchers) and circuits
 * (paired circuit IDs), and forwards RELAY_DATA after reading only the circuit
 * ID. Every limit is enforced here; refusals carry a reason on RELAY_STOP.
 * No user identity reaches this class (docs/relay-metadata.md).
 */

import { SubnetTokenBucket } from './token-bucket.js';
import crypto from 'crypto';
import { MESSAGETYPES } from '../link/frame.js';
import type { GMPLink } from '../link/link.js';
import type { NodeIdentity } from '../types.js';
import { DEFAULTS } from '../config-defaults.js';
import logger from '../logger.js';
import {
  RELAY_REJECTION_REASONS,
  decodeControl,
  decodeRelayData,
  encodeControl,
  encodeRelayData,
  signVoucher,
  subnetKey,
  type RelayStopReason,
  type Voucher,
} from './relay-protocol.js';

export interface RelayQuotas {
  reservationTtlMs: number;
  maxReservations: number;
  maxReservationsPerSubnet: number;
  /** Token bucket per /24: refill rate (per minute) and capacity. */
  reservationRatePerMinute: number;
  reservationBurst: number;
  maxCircuitsPerReservation: number;
  maxCircuitBytes: number;
  maxCircuitDurationMs: number;
}

export const DEFAULT_RELAY_QUOTAS: RelayQuotas = {
  reservationTtlMs: DEFAULTS.GMP_RELAY_RESERVATION_TTL_MS,
  maxReservations: DEFAULTS.GMP_RELAY_MAX_RESERVATIONS,
  maxReservationsPerSubnet: DEFAULTS.GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET,
  reservationRatePerMinute: DEFAULTS.GMP_RELAY_RESERVATION_RATE_PER_MINUTE,
  reservationBurst: DEFAULTS.GMP_RELAY_RESERVATION_BURST,
  maxCircuitsPerReservation: DEFAULTS.GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION,
  maxCircuitBytes: DEFAULTS.GMP_RELAY_MAX_CIRCUIT_BYTES,
  maxCircuitDurationMs: DEFAULTS.GMP_RELAY_MAX_CIRCUIT_DURATION_MS,
};

export interface RelayStats {
  reservationsActive: number;
  circuitsActive: number;
  bytesRelayed: number;
  rejections: Record<string, number>;
}

interface Reservation {
  voucher: Voucher;
  link: GMPLink;
  subnet: string;
  circuits: Set<Circuit>;
}

interface CircuitEnd {
  link: GMPLink;
  circuitId: number;
}

interface Circuit {
  dialer: CircuitEnd;
  reserver: CircuitEnd;
  reservation: Reservation;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

interface LinkState {
  circuits: Map<number, Circuit>;
  nextCircuitId: number;
}

export class RelayServer {
  readonly quotas: RelayQuotas;
  private readonly identity: () => NodeIdentity | null;
  private readonly reservations = new Map<string, Reservation>();
  /**
   * Recently expired voucher IDs (capped, kept one TTL) so a late dial hears
   * reservation-expired rather than no-reservation.
   */
  private readonly expiredIds = new Map<string, number>();
  private readonly links = new Map<GMPLink, LinkState>();
  private bytesRelayed = 0;
  private readonly rejections: Record<string, number> = {};
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  /** Per-/24 token buckets for new reservations. */
  private readonly tokens = new SubnetTokenBucket(
    () => ({ ratePerMinute: this.quotas.reservationRatePerMinute, burst: this.quotas.reservationBurst }),
    () => this.clock(),
  );
  /** Time source for expiry and rate limiting; replaceable in tests. */
  clock: () => number = () => Date.now();

  constructor(identity: () => NodeIdentity | null, quotas: Partial<RelayQuotas> = {}) {
    this.identity = identity;
    this.quotas = { ...DEFAULT_RELAY_QUOTAS, ...quotas };
    for (const reason of RELAY_REJECTION_REASONS) this.rejections[reason] = 0;
    // Expiry is a hard delete: expired reservations are dropped, not flagged.
    this.sweepTimer = setInterval(() => this._sweep(), Math.min(60000, this.quotas.reservationTtlMs));
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  getStats(): RelayStats {
    this._sweep();
    let circuitsActive = 0;
    for (const state of this.links.values()) circuitsActive += state.circuits.size;
    return {
      reservationsActive: this.reservations.size,
      // each circuit is registered on both of its links
      circuitsActive: circuitsActive / 2,
      bytesRelayed: this.bytesRelayed,
      rejections: { ...this.rejections },
    };
  }

  /** A relay-layer frame arrived on `link`, already hop-decrypted. */
  handleFrame(link: GMPLink, type: number, plaintext: Buffer): void {
    this._track(link);
    switch (type) {
      case MESSAGETYPES.RELAY_RESERVE: return this._reserve(link, plaintext);
      case MESSAGETYPES.RELAY_CONNECT: return this._connect(link, plaintext);
      case MESSAGETYPES.RELAY_DATA: return this._data(link, plaintext);
      case MESSAGETYPES.RELAY_STOP: return this._stopFromClient(link, plaintext);
      default: return; // RELAY_RESERVATION is relay -> client only
    }
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const state of this.links.values()) {
      for (const circuit of state.circuits.values()) clearTimeout(circuit.timer);
    }
    this.links.clear();
    this.reservations.clear();
  }

  // ── reservations ─────────────────────────────────

  private _reserve(link: GMPLink, plaintext: Buffer): void {
    const msg = decodeControl(plaintext);
    if (!msg) return this._reject(link, { op: 'reserve' }, 'malformed');
    this._sweep();

    const identity = this.identity();
    if (!identity || !link.remoteNodeId) return;
    const expiresAt = this.clock() + this.quotas.reservationTtlMs;
    const reserver = Buffer.from(link.remoteNodeId).toString('hex');

    const renewId = typeof msg.renew === 'string' ? msg.renew : null;
    const existing = renewId ? this.reservations.get(renewId) : undefined;
    if (existing && existing.link === link) {
      existing.voucher = this._sign(existing.voucher.voucherId, reserver, expiresAt);
      return this._send(link, MESSAGETYPES.RELAY_RESERVATION, encodeControl({ voucher: existing.voucher }));
    }

    if (this.reservations.size >= this.quotas.maxReservations) {
      return this._reject(link, { op: 'reserve' }, 'reservation-limit');
    }
    const subnet = subnetKey(link.socket ? link.socket.remoteAddress : null);
    // Sybil control is a rate, not a head count: CGNAT puts hundreds of
    // legitimate subscribers behind one /24, and they are the population the
    // relay exists for. Renewals (above) never spend a token.
    if (!this._takeToken(subnet)) {
      return this._reject(link, { op: 'reserve' }, 'subnet-rate-limit');
    }
    let inSubnet = 0;
    for (const r of this.reservations.values()) if (r.subnet === subnet) inSubnet++;
    if (inSubnet >= this.quotas.maxReservationsPerSubnet) {
      this._refundToken(subnet);
      return this._reject(link, { op: 'reserve' }, 'subnet-limit');
    }

    const voucher = this._sign(crypto.randomBytes(16).toString('hex'), reserver, expiresAt);
    this.reservations.set(voucher.voucherId, { voucher, link, subnet, circuits: new Set() });
    this._send(link, MESSAGETYPES.RELAY_RESERVATION, encodeControl({ voucher }));
  }

  private _takeToken(subnet: string): boolean {
    return this.tokens.take(subnet);
  }

  private _refundToken(subnet: string): void {
    this.tokens.refund(subnet);
  }

  /** Voucher IDs currently held by a reserving hop (hex NodeID). */
  reservationsFor(reserverHex: string): string[] {
    return [...this.reservations.values()].filter((r) => r.voucher.reserver === reserverHex).map((r) => r.voucher.voucherId);
  }

  private _sign(voucherId: string, reserver: string, expiresAt: number): Voucher {
    const identity = this.identity();
    return signVoucher(
      { v: 1, relayNodeId: identity.nodeIdHex, voucherId, reserver, expiresAt },
      identity.signingPrivKey,
    );
  }

  private _sweep(): void {
    const now = this.clock();
    for (const [id, r] of this.reservations) {
      // Circuits already running keep their own limits; the voucher just
      // stops admitting new ones.
      if (r.voucher.expiresAt <= now) this._expire(id, now);
    }
    this.tokens.sweep();
    for (const [id, at] of this.expiredIds) {
      if (now - at > this.quotas.reservationTtlMs) this.expiredIds.delete(id);
    }
  }

  private _expire(id: string, now: number): void {
    this.reservations.delete(id);
    this.expiredIds.set(id, now);
    if (this.expiredIds.size > this.quotas.maxReservations) {
      this.expiredIds.delete(this.expiredIds.keys().next().value);
    }
  }

  // ── circuits ─────────────────────────────────────

  private _connect(link: GMPLink, plaintext: Buffer): void {
    const msg = decodeControl(plaintext);
    const requestId = msg && (typeof msg.requestId === 'string' || typeof msg.requestId === 'number') ? msg.requestId : undefined;
    if (!msg || typeof msg.voucherId !== 'string') return this._reject(link, { op: 'connect', requestId }, 'malformed');

    const reservation = this.reservations.get(msg.voucherId);
    if (!reservation || reservation.voucher.expiresAt <= this.clock()) {
      if (reservation) this._expire(msg.voucherId, this.clock());
      const reason = this.expiredIds.has(msg.voucherId) ? 'reservation-expired' : 'no-reservation';
      return this._reject(link, { op: 'connect', requestId }, reason);
    }
    if (reservation.circuits.size >= this.quotas.maxCircuitsPerReservation) {
      return this._reject(link, { op: 'connect', requestId }, 'circuit-limit');
    }
    if (reservation.link.state !== 'connected') {
      this.reservations.delete(msg.voucherId);
      return this._reject(link, { op: 'connect', requestId }, 'peer-gone');
    }

    const dialer: CircuitEnd = { link, circuitId: this._allocate(link) };
    const reserverEnd: CircuitEnd = { link: reservation.link, circuitId: this._allocate(reservation.link) };
    const circuit: Circuit = {
      dialer,
      reserver: reserverEnd,
      reservation,
      bytes: 0,
      timer: setTimeout(() => this._teardown(circuit, 'duration-exceeded'), this.quotas.maxCircuitDurationMs),
    };
    if (circuit.timer.unref) circuit.timer.unref();
    reservation.circuits.add(circuit);
    this._track(dialer.link).circuits.set(dialer.circuitId, circuit);
    this._track(reserverEnd.link).circuits.set(reserverEnd.circuitId, circuit);

    // The reserver learns only that a circuit opened: no voucher echo, no
    // dialer identity (the relay has none to give).
    this._send(reserverEnd.link, MESSAGETYPES.RELAY_CONNECT, encodeControl({ circuitId: reserverEnd.circuitId }));
    this._send(dialer.link, MESSAGETYPES.RELAY_CONNECT, encodeControl({ circuitId: dialer.circuitId, requestId }));
  }

  private _data(link: GMPLink, plaintext: Buffer): void {
    const frame = decodeRelayData(plaintext);
    if (!frame) return;
    const circuit = this.links.get(link)?.circuits.get(frame.circuitId);
    if (!circuit) return; // late frame for a circuit already torn down

    circuit.bytes += frame.data.length;
    if (circuit.bytes > this.quotas.maxCircuitBytes) {
      return this._teardown(circuit, 'bytes-exceeded');
    }
    const other = circuit.dialer.link === link && circuit.dialer.circuitId === frame.circuitId ? circuit.reserver : circuit.dialer;
    this.bytesRelayed += frame.data.length;
    this._send(other.link, MESSAGETYPES.RELAY_DATA, encodeRelayData(other.circuitId, frame.data));
  }

  private _stopFromClient(link: GMPLink, plaintext: Buffer): void {
    const msg = decodeControl(plaintext);
    if (!msg || typeof msg.circuitId !== 'number') return;
    const circuit = this.links.get(link)?.circuits.get(msg.circuitId);
    if (!circuit) return;
    const from = circuit.dialer.link === link && circuit.dialer.circuitId === msg.circuitId ? circuit.dialer : circuit.reserver;
    this._teardown(circuit, 'closed', from);
  }

  /** Stop both ends (except `skip`, the end that asked) and free the circuit. */
  private _teardown(circuit: Circuit, reason: RelayStopReason, skip?: CircuitEnd): void {
    const dialerState = this.links.get(circuit.dialer.link);
    if (!dialerState || dialerState.circuits.get(circuit.dialer.circuitId) !== circuit) return; // already gone
    clearTimeout(circuit.timer);
    dialerState.circuits.delete(circuit.dialer.circuitId);
    this.links.get(circuit.reserver.link)?.circuits.delete(circuit.reserver.circuitId);
    circuit.reservation.circuits.delete(circuit);
    if (reason in this.rejections) this.rejections[reason]++;
    for (const end of [circuit.dialer, circuit.reserver]) {
      if (end !== skip) this._send(end.link, MESSAGETYPES.RELAY_STOP, encodeControl({ circuitId: end.circuitId, reason }));
    }
  }

  // ── links ────────────────────────────────────────

  private _track(link: GMPLink): LinkState {
    let state = this.links.get(link);
    if (!state) {
      state = { circuits: new Map(), nextCircuitId: 1 };
      this.links.set(link, state);
      link.once('close', () => this._linkClosed(link));
    }
    return state;
  }

  private _allocate(link: GMPLink): number {
    const state = this._track(link);
    return state.nextCircuitId++;
  }

  private _linkClosed(link: GMPLink): void {
    const state = this.links.get(link);
    if (state) {
      for (const circuit of [...state.circuits.values()]) {
        const gone = circuit.dialer.link === link ? circuit.dialer : circuit.reserver;
        this._teardown(circuit, 'peer-gone', gone);
      }
      this.links.delete(link);
    }
    for (const [id, r] of this.reservations) if (r.link === link) this.reservations.delete(id);
  }

  private _reject(link: GMPLink, ctx: { op: string; requestId?: unknown }, reason: RelayStopReason): void {
    if (reason in this.rejections) this.rejections[reason]++;
    logger.info('relay', 'rejected', `Relay ${ctx.op} refused: ${reason}`, { op: ctx.op, reason });
    this._send(link, MESSAGETYPES.RELAY_STOP, encodeControl({ ...ctx, reason }));
  }

  private _send(link: GMPLink, type: number, payload: Buffer): void {
    if (link.state !== 'connected') return;
    try {
      link.sendRelay(type, payload);
    } catch (e) {
      logger.warn('relay', 'send-failed', `Relay send failed: ${(e as Error).message}`);
    }
  }
}
