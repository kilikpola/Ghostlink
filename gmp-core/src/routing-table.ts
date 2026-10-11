import { EventEmitter } from 'events';
import type { RoutingTableEvents } from './events.js';
import { DEFAULTS } from './config-defaults.js';
import type { RouteEntry } from './types.js';

function toHex(nodeId: string | Buffer | Uint8Array): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return String(nodeId);
}

export class RoutingTable extends EventEmitter<RoutingTableEvents> {
  private expiryTimeoutMs: number;
  private pruneIntervalMs: number;
  /** destination -> next hop -> route. Read by key rotation to re-point routes. */
  readonly routes: Map<string, Map<string, RouteEntry>>;
  private pruneTimer: NodeJS.Timeout;

  constructor(options: { expiryTimeoutMs?: number; pruneIntervalMs?: number } = {}) {
    super();
    this.expiryTimeoutMs = options.expiryTimeoutMs ?? DEFAULTS.GMP_ROUTE_EXPIRY_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULTS.GMP_REANNOUNCE_INTERVAL_MS;
    this.routes = new Map();

    this.pruneTimer = setInterval(() => {
      this.pruneExpired();
    }, this.pruneIntervalMs);

    if (this.pruneTimer && this.pruneTimer.unref) {
      this.pruneTimer.unref();
    }
  }

  addRoute(dest: string | Buffer | Uint8Array, nextHop: string | Buffer | Uint8Array, hopCount: number): void {
    const destHex = toHex(dest);
    const nextHopHex = toHex(nextHop);
    const now = Date.now();

    if (!this.routes.has(destHex)) {
      this.routes.set(destHex, new Map());
    }

    const destRoutes = this.routes.get(destHex)!;
    const existing = destRoutes.get(nextHopHex);

    const route: RouteEntry = {
      destinationNodeId: destHex,
      nextHopNodeId: nextHopHex,
      hopCount,
      lastUpdated: now
    };

    destRoutes.set(nextHopHex, route);

    if (!existing || existing.hopCount !== hopCount) {
      this.emit('route-added', route);
    }
  }

  getBestRoute(dest: string | Buffer | Uint8Array): { nextHopNodeId: string; hopCount: number } | null {
    const destHex = toHex(dest);

    let targetDestHex: string | null = null;
    if (destHex.length === 64) {
      for (const existingDestHex of this.routes.keys()) {
        if (existingDestHex.startsWith(destHex)) {
          targetDestHex = existingDestHex;
          break;
        }
      }
    } else {
      targetDestHex = destHex;
    }

    if (!targetDestHex || !this.routes.has(targetDestHex)) return null;

    const destRoutes = this.routes.get(targetDestHex)!;
    const now = Date.now();
    let bestRoute: RouteEntry | null = null;

    for (const route of destRoutes.values()) {
      if (now - route.lastUpdated > this.expiryTimeoutMs) {
        continue;
      }
      if (!bestRoute || route.hopCount < bestRoute.hopCount) {
        bestRoute = route;
      }
    }

    if (!bestRoute) return null;

    return {
      nextHopNodeId: bestRoute.nextHopNodeId,
      hopCount: bestRoute.hopCount
    };
  }

  removeRoutesVia(deadNodeId: string | Buffer | Uint8Array): void {
    const deadNodeHex = toHex(deadNodeId);
    for (const [destHex, destRoutes] of this.routes.entries()) {
      if (destRoutes.has(deadNodeHex)) {
        const route = destRoutes.get(deadNodeHex)!;
        destRoutes.delete(deadNodeHex);
        this.emit('route-removed', route);
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  removeRoute(dest: string | Buffer | Uint8Array, nextHop: string | Buffer | Uint8Array): void {
    const destHex = toHex(dest);
    const nextHopHex = toHex(nextHop);
    if (this.routes.has(destHex)) {
      const destRoutes = this.routes.get(destHex)!;
      if (destRoutes.has(nextHopHex)) {
        const route = destRoutes.get(nextHopHex)!;
        destRoutes.delete(nextHopHex);
        this.emit('route-removed', route);
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  pruneExpired(): void {
    const now = Date.now();
    for (const [destHex, destRoutes] of this.routes.entries()) {
      for (const [nextHopHex, route] of destRoutes.entries()) {
        if (now - route.lastUpdated > this.expiryTimeoutMs) {
          destRoutes.delete(nextHopHex);
          this.emit('route-expired', route);
        }
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  getAllRoutes(): RouteEntry[] {
    const list: RouteEntry[] = [];
    const now = Date.now();
    for (const [, destRoutes] of this.routes.entries()) {
      for (const route of destRoutes.values()) {
        if (now - route.lastUpdated <= this.expiryTimeoutMs) {
          list.push(route);
        }
      }
    }
    return list;
  }

  close(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
    }
  }
}