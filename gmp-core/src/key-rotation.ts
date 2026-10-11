import { EventEmitter } from 'events';
import type { KeyRotationEvents } from './events.js';
import { verifySignature, hexToBytes, stringToBytes } from './identity.js';
import type {
  KeyRotationPayload,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

interface RotationMessage {
  cert: KeyRotationPayload;
  sequenceNumber: number;
  ttl: number;
}

export class KeyRotationManager extends EventEmitter<KeyRotationEvents> {
  private node: GMPNodeLike;
  private seenSequenceNumbers: Set<string>;
  private sequenceNumber: number;
  private readonly ttl: number;

  constructor(node: GMPNodeLike, options: { topologyTtl?: number } = {}) {
    super();
    this.node = node;
    this.ttl = options.topologyTtl || DEFAULTS.GMP_TOPOLOGY_TTL;
    this.seenSequenceNumbers = new Set();
    this.sequenceNumber = 0;
  }

  floodRotation(cert: KeyRotationPayload): void {
    this.sequenceNumber++;
    const rotationMsg: RotationMessage = {
      cert,
      sequenceNumber: this.sequenceNumber,
      ttl: this.ttl
    };
    const cacheKey = `${cert.oldNodeId}:${this.sequenceNumber}`;
    this.seenSequenceNumbers.add(cacheKey);

    this.floodToDirectNeighboursOnly(rotationMsg);
  }

  flood(rotationMsg: RotationMessage, excludePeerHex: string | null = null): void {
    const excludeHex = excludePeerHex ? toHex(excludePeerHex) : null;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex !== excludeHex) {
          try {
            link.sendKeyRotation(rotationMsg.cert, rotationMsg.sequenceNumber, rotationMsg.ttl);
          } catch (e: unknown) {
            const err = e as Error;
            logger.error('key-rotation', 'flood-failed', `Failed to flood key rotation to peer ${peerHex}: ${err.message}`, {
              peerNodeId: peerHex,
              err: err.message
            });
          }
        }
      }
    }
  }

  floodToDirectNeighboursOnly(rotationMsg: RotationMessage): void {
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        try {
          link.sendKeyRotation(rotationMsg.cert, rotationMsg.sequenceNumber, rotationMsg.ttl);
        } catch (e: unknown) {
          const err = e as Error;
          logger.error('key-rotation', 'flood-failed', `Failed to send key rotation to direct neighbour ${peerHex}: ${err.message}`, {
            peerNodeId: peerHex,
            err: err.message
          });
        }
      }
    }
  }

  handleReceivedRotation(msg: RotationMessage, incomingLink: GMPLinkLike | null): void {
    const { cert, sequenceNumber, ttl } = msg;
    if (!cert || ttl <= 0) return;

    const oldNodeIdHex = toHex(cert.oldNodeId);
    const cacheKey = `${oldNodeIdHex}:${sequenceNumber}`;
    if (this.seenSequenceNumbers.has(cacheKey)) {
      return;
    }
    this.seenSequenceNumbers.add(cacheKey);

    const cachedPeer = this.node.peerCache.cache.find(p => p.nodeId === oldNodeIdHex);
    if (!cachedPeer || !cachedPeer.signingPubKey) {
      logger.warn('key-rotation', 'unknown-old-node', `Unknown or untrusted old NodeID: ${oldNodeIdHex}`, {
        oldNodeId: oldNodeIdHex
      });
      return;
    }

    const msgToVerify = cert.oldNodeId + cert.newPublicKey + cert.newNodeId + cert.rotationTimestamp;
    const oldSigningPubKeyBytes = hexToBytes(cachedPeer.signingPubKey);
    const isValid = verifySignature(
      oldSigningPubKeyBytes,
      stringToBytes(msgToVerify),
      hexToBytes(cert.signature)
    );

    if (!isValid) {
      logger.warn('key-rotation', 'invalid-signature', `Invalid signature on rotation certificate for old NodeID: ${oldNodeIdHex}`, {
        oldNodeId: oldNodeIdHex
      });
      if (incomingLink && typeof incomingLink._penalizeUntrusted === 'function') {
        incomingLink._penalizeUntrusted('Invalid key rotation signature');
      }
      return;
    }

    const newNodeIdHex = toHex(cert.newNodeId);
    this.node.peerCache.replaceNodeId(oldNodeIdHex, newNodeIdHex, cert.newPublicKey);

    this.node.routingTable.removeRoutesVia(oldNodeIdHex);
    if (this.node.routingTable.routes.has(oldNodeIdHex)) {
      const nextHops = Array.from(this.node.routingTable.routes.get(oldNodeIdHex)!.keys());
      for (const nextHop of nextHops) {
        this.node.routingTable.removeRoute(oldNodeIdHex, nextHop);
      }
    }

    // Do NOT re-flood: rotation certificates only go to direct neighbours.
    // On-demand delivery happens when a peer presents a stale key.

    this.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
    this.node.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
  }

  close(): void {
    this.seenSequenceNumbers.clear();
  }
}