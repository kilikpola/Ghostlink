import { EventEmitter } from 'events';
import type { RateLimiterEvents } from './events.js';
import { DEFAULTS } from './config-defaults.js';
import { SubnetTokenBucket } from './relay/token-bucket.js';
import logger from './logger.js';

interface RateLimitEntry {
  ip: string;
  helloTimer: NodeJS.Timeout | null;
  handshakeTimer: NodeJS.Timeout | null;
}

/**
 * An address's key at a given IPv6 prefix length: IPv4 exact (IPv4-mapped
 * unwrapped), IPv6 truncated to `v6Prefix` bits. Non-IP addresses are their
 * own key.
 *
 * Deliberately different granularities:
 *   admissionKey (rate limiting): /64, so carrier customers on one /48 are
 *     not limited together.
 *   requesterKey (topology sample): /48, so enumerating membership needs many
 *     distinct allocations.
 */
export function addressKey(address: string | null | undefined, v6Prefix: 48 | 64): string {
  if (!address) return 'unknown';
  const v4 = address.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4;
  if (address.includes(':')) {
    const bare = address.replace(/%.*$/, '').toLowerCase();
    const [head, tail] = bare.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const hextets = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    const n = v6Prefix / 16;
    return `${hextets.slice(0, n).map((h) => h || '0').join(':')}::/${v6Prefix}`;
  }
  return address;
}

/** The rate-limit key for an address: IPv4 exact, IPv6 /64. See addressKey for why /64. */
export function admissionKey(address: string | null | undefined): string {
  return addressKey(address, 64);
}

/** Why an inbound connection was refused at accept time. */
export type RefusalCode = 'GLOBAL_CAP' | 'FD_LIMIT' | 'ADDRESS_RATE';

/**
 * Inbound admission: a global concurrent cap, a per-address token bucket
 * (no per-address concurrent cap, because of CGNAT), and HELLO / handshake
 * timeouts for every admitted connection.
 */
export class RateLimiter extends EventEmitter<RateLimiterEvents> {
  private maxGlobal: number;
  /** The configured cap, before any clamp to the descriptor limit. */
  readonly configuredMaxGlobal: number;
  /** FD_LIMIT once setEffectiveCap has clamped the cap below the configured one. */
  private capCode: 'GLOBAL_CAP' | 'FD_LIMIT' = 'GLOBAL_CAP';
  private readonly warnFraction: number;
  private readonly refusalLogIntervalMs: number;
  private pressureWarned = false;
  /** Refusals since the last summary line, per code. */
  private refusedSince = new Map<RefusalCode, number>();
  private refusalTimer: NodeJS.Timeout | null = null;
  private ratePerMinute: number;
  private burst: number;
  private helloTimeoutMs: number;
  private handshakeTimeoutMs: number;
  /** Replaceable (tests), like RelayServer.clock; the bucket reads it on every call. */
  clock: () => number;
  private readonly tokens: SubnetTokenBucket;
  private lastSweep: number;
  private _globalCount: number;
  private _pendingConnections: Map<string, RateLimitEntry>;

  constructor(options: {
    maxGlobal?: number;
    ratePerMinute?: number;
    burst?: number;
    helloTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    /** connection-pressure WARN at this fraction of the (effective) cap. */
    warnFraction?: number;
    refusalLogIntervalMs?: number;
    /** Tests only. */
    clock?: () => number;
  } = {}) {
    super();
    this.maxGlobal = options.maxGlobal ?? DEFAULTS.GMP_RATE_LIMIT_MAX_GLOBAL;
    this.configuredMaxGlobal = this.maxGlobal;
    const wf = options.warnFraction ?? DEFAULTS.GMP_FD_WARN_FRACTION;
    this.warnFraction = wf > 0 && wf <= 1 ? wf : 0.8;
    this.refusalLogIntervalMs = options.refusalLogIntervalMs ?? DEFAULTS.GMP_REFUSAL_LOG_INTERVAL_MS;
    this.ratePerMinute = options.ratePerMinute ?? DEFAULTS.GMP_INBOUND_RATE_PER_MINUTE;
    this.burst = options.burst ?? DEFAULTS.GMP_INBOUND_BURST;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULTS.GMP_HELLO_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULTS.GMP_HANDSHAKE_TIMEOUT_MS;
    this.clock = options.clock ?? Date.now;
    this.tokens = new SubnetTokenBucket(() => ({ ratePerMinute: this.ratePerMinute, burst: this.burst }), () => this.clock());
    this.lastSweep = this.clock();
    this._globalCount = 0;
    this._pendingConnections = new Map();
  }

  private _getIP(socket: { remoteAddress?: string }): string {
    return socket.remoteAddress || 'unknown';
  }

  checkConnection(socket: { remoteAddress?: string }): boolean {
    const ip = this._getIP(socket);

    // The cap first, so a connection refused for capacity spends no token.
    if (this._globalCount >= this.maxGlobal) {
      this.emit('rate-limited', { ip, reason: 'global-cap-reached', code: this.capCode, current: this._globalCount, limit: this.maxGlobal });
      this._noteRefusal(this.capCode);
      return false;
    }

    const now = this.clock();
    if (now - this.lastSweep > 60_000) {
      this.tokens.sweep();
      this.lastSweep = now;
    }
    if (Number.isFinite(this.burst) && !this.tokens.take(admissionKey(ip))) {
      this.emit('rate-limited', { ip, reason: 'address-rate', code: 'ADDRESS_RATE', current: this._globalCount });
      this._noteRefusal('ADDRESS_RATE');
      return false;
    }

    this._globalCount++;
    this._checkPressure();
    return true;
  }

  /**
   * Lower the cap below the configured one (never raise it), used when the fd
   * limit is lower, so the node refuses visibly before libuv drops silently.
   */
  setEffectiveCap(cap: number, code: 'FD_LIMIT'): void {
    if (!(cap > 0) || cap >= this.configuredMaxGlobal) return;
    this.maxGlobal = Math.floor(cap);
    this.capCode = code;
  }

  /** Live pressure from the admitted count: fires at the moment, not at the next resource sample. */
  private _checkPressure(): void {
    const at = this.warnFraction * this.maxGlobal;
    if (!this.pressureWarned && this._globalCount >= at) {
      this.pressureWarned = true;
      logger.warn('rate-limiter', 'connection-pressure',
        `${this._globalCount} of ${this.maxGlobal} inbound connections in use (${Math.round(this.warnFraction * 100)}% warn level; cap ${this.capCode === 'FD_LIMIT' ? 'clamped to the descriptor limit' : 'as configured'}): new connections will be refused at ${this.maxGlobal}`,
        { count: this._globalCount, cap: this.maxGlobal, configuredCap: this.configuredMaxGlobal, code: this.capCode });
    } else if (this.pressureWarned && this._globalCount < 0.7 * this.maxGlobal) {
      this.pressureWarned = false; // re-arm once well clear
    }
  }

  /** Log the first refusal of a burst, then one summary per interval. */
  private _noteRefusal(code: RefusalCode): void {
    const first = this.refusalTimer === null;
    if (first) {
      logger.warn('rate-limiter', 'connection-refused', this._refusalMsg(code, 1), { code, count: 1, cap: this.maxGlobal, current: this._globalCount });
      this.refusalTimer = setTimeout(() => this._flushRefusals(), this.refusalLogIntervalMs);
      this.refusalTimer.unref?.();
      return;
    }
    this.refusedSince.set(code, (this.refusedSince.get(code) || 0) + 1);
  }

  private _flushRefusals(): void {
    this.refusalTimer = null;
    if (this.refusedSince.size === 0) return; // quiet window: the next refusal logs at once again
    for (const [code, count] of this.refusedSince) {
      logger.warn('rate-limiter', 'connection-refused', this._refusalMsg(code, count), { code, count, cap: this.maxGlobal, current: this._globalCount, windowMs: this.refusalLogIntervalMs });
    }
    this.refusedSince.clear();
    this.refusalTimer = setTimeout(() => this._flushRefusals(), this.refusalLogIntervalMs);
    this.refusalTimer.unref?.();
  }

  private _refusalMsg(code: RefusalCode, count: number): string {
    const why = code === 'FD_LIMIT' ? `connection cap ${this.maxGlobal} reached (clamped from ${this.configuredMaxGlobal} to fit the descriptor limit)`
      : code === 'GLOBAL_CAP' ? `connection cap ${this.maxGlobal} reached`
        : 'per-address connection rate exceeded';
    return `Refused ${count} inbound connection(s) [${code}]: ${why}`;
  }

  recordPendingConnection(socket: { remoteAddress?: string }, linkId: string): void {
    const ip = this._getIP(socket);
    this._pendingConnections.set(linkId, {
      ip,
      helloTimer: setTimeout(() => {
        this.emit('hello-timeout', { linkId, ip });
      }, this.helloTimeoutMs),
      handshakeTimer: null,
    });
  }

  recordHelloReceived(linkId: string): void {
    const pending = this._pendingConnections.get(linkId);
    if (pending && pending.helloTimer) {
      clearTimeout(pending.helloTimer);
    }
    const pending2 = this._pendingConnections.get(linkId);
    if (pending2) {
      pending2.handshakeTimer = setTimeout(() => {
        this.emit('handshake-timeout', { linkId, ip: pending2.ip });
      }, this.handshakeTimeoutMs);
    }
  }

  recordHandshakeComplete(linkId: string): void {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
  }

  /** Stop HELLO / handshake timers for an uncounted (outbound) connection. */
  releasePending(linkId: string): void {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
  }

  /** An admitted (inbound) connection closed: release its timers and its slot. */
  recordConnectionClosed(linkId: string): void {
    this.releasePending(linkId);
    this._globalCount--;
    if (this._globalCount < 0) {
      // A close recorded for a never-admitted connection. A negative count
      // would loosen the global cap, so it is floored, and loud.
      logger.error('rate-limiter', 'global-count-negative',
        `Connection count went negative (${this._globalCount}); a close was recorded for a connection that was never admitted`,
        { linkId, count: this._globalCount });
      this._globalCount = 0;
    }
  }

  getStats(): { globalCount: number; maxGlobal: number; pendingConnections: number } {
    return {
      globalCount: this._globalCount,
      maxGlobal: this.maxGlobal,
      pendingConnections: this._pendingConnections.size,
    };
  }

  close(): void {
    if (this.refusalTimer) clearTimeout(this.refusalTimer);
    this.refusalTimer = null;
    for (const pending of this._pendingConnections.values()) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
    }
    this._pendingConnections.clear();
  }
}