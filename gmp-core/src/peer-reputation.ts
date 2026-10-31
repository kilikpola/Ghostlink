import { EventEmitter } from 'events';
import type { ReputationEvents } from './events.js';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import type {
  PeerTrustLevel,
  GMPNodeLike,
} from './types.js';

interface ReputationOptions {
  banDurationMs?: number;
  recoveryIntervalMs?: number;
}

export class ReputationManager extends EventEmitter<ReputationEvents> {
  private node: GMPNodeLike;
  private banDurationMs: number;
  private scores: Map<string, number>;
  private bannedPeers: Map<string, number>;
  private recoveryTimer: ReturnType<typeof setInterval>;
  readonly recoveryIntervalMs: number;

  constructor(node: GMPNodeLike, options: ReputationOptions = {}) {
    super();
    this.node = node;

    this.banDurationMs = options.banDurationMs || DEFAULTS.GMP_BAN_DURATION_MS;
    const recoveryIntervalMs = options.recoveryIntervalMs || DEFAULTS.GMP_REPUTATION_RECOVERY_INTERVAL_MS;
    this.recoveryIntervalMs = recoveryIntervalMs;

    this.scores = new Map();
    this.bannedPeers = new Map();

    this.recoveryTimer = setInterval(() => {
      this.recoverScores();
    }, recoveryIntervalMs);
  }

  recoverScores(): void {
    for (const [nodeId, score] of this.scores.entries()) {
      if (this.isBanned(nodeId)) continue;
      if (score < 100) {
        const newScore = Math.min(100, score + 1);
        this.scores.set(nodeId, newScore);
      }
    }
  }

  getScore(nodeId: string): number {
    if (!nodeId) return 100;
    if (this.scores.has(nodeId)) {
      return this.scores.get(nodeId)!;
    }
    return 100;
  }

  /**
   * D2: a penalty is about one identity. `offendingLink` is the link that
   * misbehaved; at score 0 it is closed and the NodeID refused (time-boxed).
   * Before an identity is proven (nodeId null) nothing is recorded: the caller
   * closes that link itself.
   */
  penalize(nodeId: string | null, points: number, reason: string = '', offendingLink: { destroy(err?: Error): void } | null = null): void {
    if (!nodeId) return;
    const currentScore = this.getScore(nodeId);
    const newScore = Math.max(0, currentScore - points);
    this.scores.set(nodeId, newScore);

    logger.warn('reputation', 'penalized', `Penalized peer ${nodeId.slice(0, 8)}: -${points} points (Reason: ${reason}). New score: ${newScore}`, {
      nodeId,
      points,
      reason,
      newScore
    });

    if (newScore === 0) {
      this.ban(nodeId, reason, offendingLink);
    }
  }

  /**
   * Refuse this NodeID for banDurationMs and close the offender's links: the
   * offending link, and any other link whose handshake proved this same NodeID.
   * Never by address (D2): an address is shared by everyone behind the same
   * CGNAT, and a mesh-routed link has none. Address-level protection is the
   * admission token bucket — a rate, never a ban (rate-limiter.ts).
   */
  ban(nodeId: string | null, reason: string = '', offendingLink: { destroy(err?: Error): void } | null = null): void {
    if (!nodeId) return;
    const expiresAt = Date.now() + this.banDurationMs;
    this.bannedPeers.set(nodeId, expiresAt);

    logger.error('reputation', 'banned', `BANNED peer ${nodeId.slice(0, 8)} for ${this.banDurationMs}ms (Reason: ${reason})`, {
      nodeId,
      banDurationMs: this.banDurationMs,
      reason
    });

    this.emit('ban', { nodeId, expiresAt, reason });

    const err = new Error(`Peer reputation reduced to 0: banned (Reason: ${reason})`);
    if (offendingLink) offendingLink.destroy(err);
    if (this.node) {
      for (const link of this.node.links.values()) {
        if (link === offendingLink) continue;
        const linkNodeIdHex = link.remoteNodeId ? Buffer.from(link.remoteNodeId).toString('hex') : null;
        if (linkNodeIdHex === nodeId) link.destroy(err);
      }
    }
  }

  isBanned(nodeId: string | null): boolean {
    if (!nodeId || !this.bannedPeers.has(nodeId)) return false;
    if (Date.now() < this.bannedPeers.get(nodeId)!) return true;
    this.bannedPeers.delete(nodeId);
    return false;
  }

  /** Routed packets name 32-byte NodeID prefixes (64 hex): is any banned NodeID one with this prefix? */
  isBannedPrefix(prefixHex: string): boolean {
    if (!prefixHex) return false;
    const now = Date.now();
    for (const [id, expiresAt] of this.bannedPeers) {
      if (now >= expiresAt) { this.bannedPeers.delete(id); continue; }
      if (id.startsWith(prefixHex)) return true;
    }
    return false;
  }

  getTrustLevel(nodeId: string): PeerTrustLevel {
    const score = this.getScore(nodeId);
    if (this.isBanned(nodeId)) return 'banned';
    if (score >= 80) return 'trusted';
    if (score >= 40) return 'suspicious';
    return 'untrusted';
  }

  close(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
    }
  }
}