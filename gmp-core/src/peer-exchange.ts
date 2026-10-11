import { EventEmitter } from 'events';
import type { PeerExchangeEvents, GMPNodeEvents } from './events.js';
import { DEFAULTS } from './config-defaults.js';
import { requesterKey } from './topology-sample.js';
import type {
  PeerInfo,
  PeerRequestPayload,
  PeerResponsePayload,
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

/** The most peers we request in a PEER_REQUEST, and so the most we accept back. */
const MAX_PEERS_PER_RESPONSE = 20;

export class PeerExchangeManager extends EventEmitter<PeerExchangeEvents> {
  private node: GMPNodeLike;
  private lastRequestTimes: Map<string, number>;
  private candidatePool: Map<string, PeerInfo>;
  private pendingRequestTimers: Set<ReturnType<typeof setTimeout>>;
  private connectionListener: (...args: GMPNodeEvents['connection']) => void;
  private readonly requestIntervalMs: number;
  private readonly maxPool: number;

  constructor(node: GMPNodeLike, options: { requestIntervalMs?: number; maxPool?: number } = {}) {
    super();
    this.node = node;
    this.requestIntervalMs = options.requestIntervalMs || DEFAULTS.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS;
    this.maxPool = options.maxPool || DEFAULTS.GMP_PEER_CACHE_MAX_SIZE;

    this.lastRequestTimes = new Map();

    this.candidatePool = new Map();

    this.pendingRequestTimers = new Set();

    this.connectionListener = ({ link, peerNodeId }) => {
      if (link && !link.isVirtual && peerNodeId) {
        const timer = setTimeout(() => {
          this.pendingRequestTimers.delete(timer);
          if (link.state === 'connected') {
            try {
              link.sendPeerRequest(MAX_PEERS_PER_RESPONSE);
            } catch (err) {
              // Link might have disconnected
            }
          }
        }, 500);
        this.pendingRequestTimers.add(timer);
        if (timer.unref) {
          (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
        }
      }
    };

    this.node.on('connection', this.connectionListener);
  }

  /**
   * Answer a PEER_REQUEST with a sample of at most `sampleSize` dialable peers,
   * keyed on the requester's address so reconnecting returns the same set
   * within an epoch. Only outbound peers have addresses. Rate-limited per
   * address key.
   */
  handlePeerRequest(link: GMPLinkLike, msg: PeerRequestPayload): void {
    if (!link.remoteNodeId) return;
    const requesterHex = toHex(link.remoteNodeId);
    const key = requesterKey(link);

    const now = Date.now();
    const lastTime = this.lastRequestTimes.get(key) || 0;
    const intervalMs = this.requestIntervalMs;
    if (now - lastTime < intervalMs) {
      return;
    }
    this.lastRequestTimes.set(key, now);

    // No sampler (no topology manager): answer with nothing rather than the set.
    const topology = this.node.topologyManager;
    const size = Math.min(msg.maxPeers || MAX_PEERS_PER_RESPONSE, topology?.sampleSize ?? 0);
    const candidates = (this.node.peerCache.getDirectPeers24h() || []).filter((p) => p.nodeId !== requesterHex);
    const chosen = topology ? topology.pickSample(link, candidates, (p) => p.nodeId, size) : [];
    const peersToSend = chosen.map((p) => ({
      nodeId: p.nodeId,
      address: p.address,
      port: p.port,
      lastSeen: p.lastSeen,
    }));

    try {
      link.sendPeerResponse(peersToSend);
    } catch (err) {
      // Link failed
    }
  }

  handlePeerResponse(_link: GMPLinkLike, msg: PeerResponsePayload): void {
    if (!msg || !Array.isArray(msg.peers)) return;

    // Bounded: the response size is the remote's to choose.
    const maxPool = this.maxPool;
    let addedCount = 0;
    for (const peer of msg.peers.slice(0, MAX_PEERS_PER_RESPONSE)) {
      const nodeIdHex = toHex(peer.nodeId);

      if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) {
        continue;
      }

      if (this.node.getLinkByNodeId(nodeIdHex)) {
        continue;
      }

      this.candidatePool.set(nodeIdHex, {
        nodeId: nodeIdHex,
        address: peer.address,
        port: peer.port,
        lastSeen: peer.lastSeen
      });
      // Map iteration is insertion order, so the first key is the oldest.
      while (this.candidatePool.size > maxPool) {
        const oldest = this.candidatePool.keys().next().value;
        if (oldest === undefined) break;
        this.candidatePool.delete(oldest);
      }
      addedCount++;
    }

    if (addedCount > 0) {
      this.emit('candidates-added', addedCount);
      if (this.node.bootstrap && this.node.bootstrap.isBootstrapping) {
        this.node.bootstrap.attemptCandidates();
      }
    }
  }

  /** Peers learned by exchange, newest first: bootstrap rung 4. */
  candidates(): PeerInfo[] {
    return [...this.candidatePool.values()].reverse();
  }

  close(): void {
    this.node.off('connection', this.connectionListener);
    for (const timer of this.pendingRequestTimers) {
      clearTimeout(timer);
    }
    this.pendingRequestTimers.clear();
    this.lastRequestTimes.clear();
    this.candidatePool.clear();
  }
}