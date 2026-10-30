import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import metrics from './metrics.js';
import type {
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

/**
 * R7: content type of a ratchet message in DATA (ratchet/ratchet-wire.ts
 * RATCHET_CONTENT_TYPE; equality is tested). A literal here so the routing
 * module imports nothing from the ratchet.
 */
const RATCHET_CONTENT_TYPE = 0x02;

export class Forwarder {
  private node: GMPNodeLike;
  private forwardTimestamps: Map<string, number[]>;

  constructor(node: GMPNodeLike) {
    this.node = node;
    this.forwardTimestamps = new Map();
  }

  processIncoming(plaintext: Uint8Array, incomingLink: GMPLinkLike | null): ProcessResult {
    if (plaintext.length < 1) return false;

    // R7: a ratchet message (identity-v2.md §3.1) is binary. Hand it to the node
    // as bytes here, before the link would turn the DATA plaintext into a string.
    if (plaintext[0] === RATCHET_CONTENT_TYPE) {
      if (incomingLink) {
        (this.node as unknown as { emit(e: 'ratchet-data', i: { link: GMPLinkLike; message: Uint8Array }): boolean })
          .emit('ratchet-data', { link: incomingLink, message: Uint8Array.prototype.slice.call(plaintext, 1) });
      }
      return { local: false };
    }

    const isRouted = plaintext[0];

    if (isRouted !== 0x01) {
      return false;
    }

    if (plaintext.length < 66) {
      return false;
    }

    const sourceNodeId = plaintext.slice(1, 33);
    const finalDest = plaintext.slice(33, 65);
    const hopCount = plaintext[65];
    const payload = plaintext.slice(66);

    const ourNodeIdHex = this.node.identity!.nodeIdHex;
    const finalDestHex = Buffer.from(finalDest).toString('hex');
    const sourceNodeIdHex = Buffer.from(sourceNodeId).toString('hex');

    if (this.node.reputation) {
      if (this.node.reputation.isBanned(sourceNodeIdHex) || this.node.reputation.isBanned(finalDestHex)) {
        logger.warn('forwarder', 'dropped-banned-packet', `Dropping packet between banned peers: ${sourceNodeIdHex.slice(0, 8)} -> ${finalDestHex.slice(0, 8)}`, {
          sourceNodeId: sourceNodeIdHex,
          destinationNodeId: finalDestHex
        });
        return { local: false, error: 'banned' };
      }
    }

    if (ourNodeIdHex.startsWith(finalDestHex)) {
      return {
        local: true,
        sourceNodeId,
        payload
      };
    }

    if (sourceNodeIdHex === ourNodeIdHex) {
      if (incomingLink) {
        incomingLink._penalizeBanned('Routing loop detected: received our own authored packet');
      }
      return { local: false, error: 'routing-loop' };
    }

    if (!this.checkRateLimit(incomingLink ? incomingLink.remoteNodeId : null)) {
      if (incomingLink) {
        incomingLink._penalizeBanned('Forwarding rate limit exceeded');
      }
      this.node.emit('rate-limited', {
        sourceNodeId: incomingLink ? incomingLink.remoteNodeId : null,
        type: 'forward'
      });
      metrics.increment('security.rateLimitHits');
      return { local: false, error: 'rate-limited' };
    }

    const newHopCount = hopCount - 1;
    if (newHopCount <= 0) {
      this.node.emit('ttl-expired', {
        finalDestinationNodeId: finalDestHex,
        hopCount: hopCount
      });
      metrics.increment('routing.droppedTTL');
      return { local: false, error: 'ttl-expired' };
    }

    const route = this.node.routingTable.getBestRoute(finalDestHex);
    if (!route) {
      this.node.emit('no-route', {
        finalDestinationNodeId: finalDestHex
      });
      metrics.increment('routing.droppedNoRoute');
      return { local: false, error: 'no-route' };
    }

    const nextHopLink = this.node.getLinkByNodeId(route.nextHopNodeId);
    if (!nextHopLink || nextHopLink.state !== 'connected') {
      this.node.emit('no-route', {
        finalDestinationNodeId: finalDestHex
      });
      metrics.increment('routing.droppedNoRoute');
      return { local: false, error: 'no-route' };
    }

    try {
      nextHopLink.sendRoutedDATA(finalDest, newHopCount, payload, sourceNodeId);
      metrics.increment('routing.messagesForwarded');
      this.node.emit('forwarded', {
        sourceNodeId: sourceNodeIdHex,
        finalDestinationNodeId: finalDestHex,
        hopCount: newHopCount
      });
    } catch (e) {
      // Ignore socket writing errors during forward
    }

    return { local: false };
  }

  // Takes the link's raw NodeID as well as a hex string: GMPLink.remoteNodeId
  // is a Uint8Array, and toHex below normalizes either form.
  checkRateLimit(sourceNodeId: string | Uint8Array | null): boolean {
    if (!sourceNodeId) return true;
    const sourceHex = toHex(sourceNodeId);
    const now = Date.now();

    const windowMs = (this.node as unknown as { forwardRateLimitWindowMs?: number }).forwardRateLimitWindowMs
      ?? DEFAULTS.GMP_RATE_LIMIT_WINDOW_MS;
    const maxForwards = (this.node as unknown as { forwardRateLimitMax?: number }).forwardRateLimitMax
      ?? DEFAULTS.GMP_FORWARD_RATE_LIMIT_PER_SOURCE;

    let timestamps = this.forwardTimestamps.get(sourceHex) || [];
    const cutoff = now - windowMs;
    timestamps = timestamps.filter(ts => ts > cutoff);

    if (timestamps.length >= maxForwards) {
      return false;
    }

    timestamps.push(now);
    this.forwardTimestamps.set(sourceHex, timestamps);
    return true;
  }
}

type ProcessResult =
  | false
  | { local: true; sourceNodeId: Uint8Array; payload: Uint8Array }
  | { local: false; error?: string };