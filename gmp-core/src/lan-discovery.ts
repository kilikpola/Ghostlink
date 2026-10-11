/**
 * LAN Discovery — a local directory of Ghost Addresses over UDP multicast, so
 * peers on one network can resolve each other with no internet.
 *
 * It never connects to anybody; it only records "NodeID X is at host:port".
 * The bootstrap ladder (rung 2) dials only LAN NodeIDs already known.
 *
 * Beacons carry a NodeID and port, both public and untrusted: the handshake
 * authenticates the peer, so a forged beacon can only cause a failed dial.
 */

import dgram from 'dgram';
import { EventEmitter } from 'events';
import type { LanDiscoveryEvents } from './events.js';
import logger from './logger.js';

/**
 * What LanDiscovery needs from the node: its identity (for the beacon and to
 * drop our own echo) and its listening port.
 */
export interface LanDiscoveryHost {
  identity: { nodeIdHex: string } | null;
  port: number;
}

export interface LanPeer {
  nodeId: string;
  address: string;
  port: number;
  lastSeen: number;
}

export interface LanDiscoveryOptions {
  port?: number | null;
  group?: string | null;
  announceIntervalMs?: number;
  peerTtlMs?: number;
}

export const DEFAULT_DISCOVERY_PORT = 49599;
export const DEFAULT_MULTICAST_GROUP = '239.255.42.99';

const PROTOCOL = 'ghostlink-lan-v1';
const DEFAULT_ANNOUNCE_INTERVAL_MS = 5000;
// Peers stop being offered for resolution once their beacon goes quiet. Long
// enough to ride out a few dropped multicast packets, short enough that a
// laptop that left the network is not still advertised half an hour later.
const DEFAULT_PEER_TTL_MS = 30000;

export class LanDiscovery extends EventEmitter<LanDiscoveryEvents> {
  readonly node: LanDiscoveryHost;
  readonly port: number;
  readonly group: string;
  readonly announceIntervalMs: number;
  readonly peerTtlMs: number;
  readonly peers: Map<string, LanPeer>;
  private socket: dgram.Socket | null;
  private announceTimer: ReturnType<typeof setInterval> | null;
  started: boolean;

  constructor(node: LanDiscoveryHost, options: LanDiscoveryOptions = {}) {
    super();
    this.node = node;
    this.port = options.port || DEFAULT_DISCOVERY_PORT;
    this.group = options.group || DEFAULT_MULTICAST_GROUP;
    this.announceIntervalMs = options.announceIntervalMs || DEFAULT_ANNOUNCE_INTERVAL_MS;
    this.peerTtlMs = options.peerTtlMs || DEFAULT_PEER_TTL_MS;

    this.peers = new Map();

    this.socket = null;
    this.announceTimer = null;
    this.started = false;
  }

  start(): Promise<boolean> {
    if (this.started) return Promise.resolve(false);
    this.started = true;

    return new Promise<boolean>((resolve) => {
      let socket: dgram.Socket;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch (e) {
        this.started = false;
        resolve(false);
        return;
      }
      this.socket = socket;

      // Discovery is a convenience, never a reason to fail startup: a machine
      // with multicast blocked, no network, or the port already taken simply
      // goes without it.
      const giveUp = (err: Error): void => {
        logger.warn('lan-discovery', 'unavailable',
          `LAN discovery disabled: ${err.message}. Peers on this network will only be findable through the mesh.`,
          { error: err.message });
        try { socket.close(); } catch { /* already closed */ }
        this.socket = null;
        this.started = false;
        resolve(false);
      };

      socket.once('error', giveUp);

      socket.bind(this.port, () => {
        socket.removeListener('error', giveUp);
        socket.on('error', (err: Error) => {
          logger.warn('lan-discovery', 'socket-error', `LAN discovery socket error: ${err.message}`, { error: err.message });
        });

        try {
          socket.addMembership(this.group);
          socket.setMulticastTTL(1); // this subnet only — never leaves the LAN
          // Loopback stays ON so two GhostLink instances on one machine can
          // find each other, which is how most people test. Our own beacon
          // comes back to us as a result; _onBeacon drops it by NodeID.
          socket.setMulticastLoopback(true);
        } catch (e) {
          // Bound but not multicasting (common in containers). Still useful:
          // we can receive directed beacons even if we cannot join the group.
          const err = e as Error;
          logger.warn('lan-discovery', 'multicast-unavailable',
            `Could not join multicast group: ${err.message}`, { error: err.message });
        }

        socket.on('message', (buf, rinfo) => this._onBeacon(buf, rinfo));
        if (socket.unref) socket.unref();

        this.announce();
        this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
        if (this.announceTimer.unref) this.announceTimer.unref();

        logger.info('lan-discovery', 'started',
          `LAN discovery active on ${this.group}:${this.port}`,
          { group: this.group, port: this.port });
        resolve(true);
      });
    });
  }

  announce(): void {
    if (!this.socket || !this.node.identity) return;
    const beacon = JSON.stringify({
      p: PROTOCOL,
      nodeId: this.node.identity.nodeIdHex,
      port: this.node.port
    });
    try {
      this.socket.send(beacon, this.port, this.group);
    } catch {
      // A transient send failure (interface down, no route) is not worth
      // logging every few seconds.
    }
  }

  _onBeacon(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    let msg: { p?: unknown; nodeId?: unknown; port?: unknown } | null;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }

    if (!msg || msg.p !== PROTOCOL) return;
    if (typeof msg.nodeId !== 'string' || !/^[0-9a-f]{128}$/i.test(msg.nodeId)) return;
    if (typeof msg.port !== "number" || !Number.isInteger(msg.port) || msg.port <= 0 || msg.port > 65535) return;

    const nodeId = (msg.nodeId as string).toLowerCase();
    const port = msg.port as number;
    if (this.node.identity && nodeId === this.node.identity.nodeIdHex) return; // our own echo

    const known = this.peers.get(nodeId);
    this.peers.set(nodeId, {
      nodeId,
      address: rinfo.address,
      port,
      lastSeen: Date.now()
    });

    if (!known) {
      logger.info('lan-discovery', 'peer-seen',
        `Found ${nodeId.slice(0, 16)}… on the local network at ${rinfo.address}:${port}`,
        { nodeId, address: rinfo.address, port });
      this.emit('peer-discovered', { nodeId, address: rinfo.address, port });
    }
  }

  /** Drop beacons we have not heard in a while. */
  _prune(): void {
    const cutoff = Date.now() - this.peerTtlMs;
    for (const [nodeId, entry] of this.peers) {
      if (entry.lastSeen < cutoff) this.peers.delete(nodeId);
    }
  }

  /** NodeIDs currently visible on this network. */
  getNodeIds(): string[] {
    this._prune();
    return Array.from(this.peers.keys());
  }

  /** Where a locally-visible NodeID can be dialled, or null. */
  getPeer(nodeId: string): LanPeer | null {
    this._prune();
    return this.peers.get(String(nodeId).toLowerCase()) || null;
  }

  close(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.peers.clear();
    this.started = false;
  }
}
