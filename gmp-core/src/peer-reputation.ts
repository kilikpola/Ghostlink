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
  private bannedIps: Map<string, number>;
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
    this.bannedIps = new Map();

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

  penalize(nodeId: string, points: number, reason: string = '', ip: string | null = null): void {
    if (!nodeId) return;
    const currentScore = this.getScore(nodeId);
    const newScore = Math.max(0, currentScore - points);
    this.scores.set(nodeId, newScore);

    logger.warn('reputation', 'penalized', `Penalized peer ${nodeId.slice(0, 8)}: -${points} points (Reason: ${reason}). New score: ${newScore}`, {
      nodeId,
      points,
      reason,
      ip,
      newScore
    });

    if (newScore === 0) {
      this.ban(nodeId, ip, reason);
    }
  }

  ban(nodeId: string, ip: string | null, reason: string = ''): void {
    const expiresAt = Date.now() + this.banDurationMs;
    if (nodeId) {
      this.bannedPeers.set(nodeId, expiresAt);
    }
    if (ip) {
      this.bannedIps.set(ip, expiresAt);
    }

    logger.error('reputation', 'banned', `BANNED peer ${nodeId ? nodeId.slice(0, 8) : 'unknown'} (IP: ${ip || 'unknown'}) for ${this.banDurationMs}ms (Reason: ${reason})`, {
      nodeId,
      ip,
      banDurationMs: this.banDurationMs,
      reason
    });

    this.emit('ban', { nodeId, ip, expiresAt, reason });

    if (this.node) {
      for (const link of this.node.links.values()) {
        const linkIp = link.socket ? link.socket.remoteAddress : null;
        const linkNodeIdHex = link.remoteNodeId ? Buffer.from(link.remoteNodeId).toString('hex') : null;
        if ((nodeId && linkNodeIdHex === nodeId) || (ip && linkIp === ip)) {
          link.destroy(new Error(`Peer reputation reduced to 0: banned (Reason: ${reason})`));
        }
      }
    }
  }

  isBanned(nodeId: string, ip: string | null = null): boolean {
    const now = Date.now();

    if (nodeId && this.bannedPeers.has(nodeId)) {
      const expiresAt = this.bannedPeers.get(nodeId)!;
      if (now < expiresAt) {
        return true;
      } else {
        this.bannedPeers.delete(nodeId);
      }
    }

    if (ip && this.bannedIps.has(ip)) {
      const expiresAt = this.bannedIps.get(ip)!;
      if (now < expiresAt) {
        return true;
      } else {
        this.bannedIps.delete(ip);
      }
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