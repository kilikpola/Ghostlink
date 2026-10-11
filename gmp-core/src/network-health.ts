import { EventEmitter } from 'events';
import type { NetworkHealthEvents } from './events.js';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import type {
  HealthReport,
  NodeHealthStatus,
  GMPNodeLike,
} from './types.js';

export class NetworkHealthMonitor extends EventEmitter<NetworkHealthEvents> {
  private node: GMPNodeLike;
  private startTime: number;
  private metrics: HealthMetrics;
  private noRouteTimestamps: number[];
  private forwardedListener: () => void;
  private ttlExpiredListener: () => void;
  private noRouteListener: () => void;
  private checkInterval: ReturnType<typeof setInterval> | null;
  readonly checkIntervalMs: number;

  /** checkIntervalMs defaults to half the re-announce interval, as before. */
  constructor(node: GMPNodeLike, options: { checkIntervalMs?: number } = {}) {
    super();
    this.node = node;
    this.startTime = Date.now();

    this.metrics = {
      currentPeerCount: 0,
      peakPeerCount: 0,
      messagesForwarded: 0,
      messagesDroppedNoRoute: 0,
      messagesDroppedTTL: 0,
      uptimeSeconds: 0,
      bootstrapAttempts: 0
    };

    this.noRouteTimestamps = [];

    this.forwardedListener = () => {
      this.metrics.messagesForwarded++;
    };
    this.ttlExpiredListener = () => {
      this.metrics.messagesDroppedTTL++;
    };
    this.noRouteListener = () => {
      this.metrics.messagesDroppedNoRoute++;
      this.noRouteTimestamps.push(Date.now());
    };

    this.node.on('forwarded', this.forwardedListener);
    this.node.on('ttl-expired', this.ttlExpiredListener);
    this.node.on('no-route', this.noRouteListener);

    const intervalMs = options.checkIntervalMs || DEFAULTS.GMP_REANNOUNCE_INTERVAL_MS / 2;
    this.checkIntervalMs = intervalMs;
    this.checkInterval = setInterval(() => {
      this.runHealthCheck();
    }, intervalMs);

    if (this.checkInterval && this.checkInterval.unref) {
      this.checkInterval.unref();
    }
  }

  getDirectConnectionCount(): number {
    return Array.from(this.node.connections.values())
      .filter(link => link.state === 'connected' && !link.isVirtual).length;
  }

  updatePeerCounts(): void {
    const current = this.getDirectConnectionCount();
    this.metrics.currentPeerCount = current;
    if (current > this.metrics.peakPeerCount) {
      this.metrics.peakPeerCount = current;
    }
  }

  runHealthCheck(): void {
    this.updatePeerCounts();

    const minPeers = this.node.bootstrap ? this.node.bootstrap.minPeers : DEFAULTS.GMP_MIN_PEERS;

    if (this.metrics.currentPeerCount < minPeers && this.node.bootstrap && !this.node.bootstrap.isBootstrapping) {
      logger.info('health-monitor', 'check-trigger-bootstrap', `Low peer count (${this.metrics.currentPeerCount} < ${minPeers}). Initiating re-bootstrap.`);
      this.node.bootstrap.start().catch(() => {});
    }

    const now = Date.now();
    const cutoff = now - 5 * 60 * 1000;
    this.noRouteTimestamps = this.noRouteTimestamps.filter(t => t > cutoff);
    const droppedInLast5M = this.noRouteTimestamps.length;
    const totalForwarded = this.metrics.messagesForwarded;

    if (droppedInLast5M > 0 && (totalForwarded === 0 || droppedInLast5M > 0.20 * totalForwarded)) {
      logger.warn('health-monitor', 'routing-degraded', `Routing tables are degraded: ${droppedInLast5M} drops in last 5m`, {
        droppedInLast5M,
        totalForwarded
      });
      this.node.emit('routing-degraded', {
        droppedInLast5M,
        totalForwarded
      });
      this.emit('routing-degraded', {
        droppedInLast5M,
        totalForwarded
      });
    }
  }

  getHealthReport(): HealthReport {
    this.updatePeerCounts();
    this.metrics.uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    let status: NodeHealthStatus = 'healthy';
    const minPeers = this.node.bootstrap ? this.node.bootstrap.minPeers : DEFAULTS.GMP_MIN_PEERS;

    const now = Date.now();
    const cutoff = now - 5 * 60 * 1000;
    const recentDrops = this.noRouteTimestamps.filter(t => t > cutoff).length;
    const totalForwarded = this.metrics.messagesForwarded;
    const isDegradedRouting = recentDrops > 0 && (totalForwarded === 0 || recentDrops > 0.20 * totalForwarded);

    if (this.node.bootstrap && this.node.bootstrap.isBootstrapping) {
      status = 'bootstrapping';
    } else if (this.metrics.currentPeerCount === 0) {
      status = 'isolated';
    } else if (this.metrics.currentPeerCount < minPeers || isDegradedRouting) {
      status = 'degraded';
    }

    return {
      status,
      currentPeerCount: this.metrics.currentPeerCount,
      peakPeerCount: this.metrics.peakPeerCount,
      messagesForwarded: this.metrics.messagesForwarded,
      messagesDroppedNoRoute: this.metrics.messagesDroppedNoRoute,
      messagesDroppedTTL: this.metrics.messagesDroppedTTL,
      uptimeSeconds: this.metrics.uptimeSeconds,
      bootstrapAttempts: this.metrics.bootstrapAttempts
    };
  }

  close(): void {
    this.node.off('forwarded', this.forwardedListener);
    this.node.off('ttl-expired', this.ttlExpiredListener);
    this.node.off('no-route', this.noRouteListener);

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

interface HealthMetrics {
  currentPeerCount: number;
  peakPeerCount: number;
  messagesForwarded: number;
  messagesDroppedNoRoute: number;
  messagesDroppedTTL: number;
  uptimeSeconds: number;
  bootstrapAttempts: number;
}

