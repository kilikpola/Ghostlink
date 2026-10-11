import http from 'http';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import type { NodeIdentity, KeyRotationPayload } from './types.js';
import type { RelayStats } from './relay/relay-server.js';

interface Registry {
  'peers.current': number;
  'peers.peak': number;
  'peers.totalConnected': number;
  'peers.totalDisconnected': number;
  'routing.tableSize': number;
  'routing.messagesForwarded': number;
  'routing.droppedNoRoute': number;
  'routing.droppedTTL': number;
  'routing.announcements': number;
  'routing.announcementsRejected': number;
  'network.bytesSent': number;
  'network.bytesReceived': number;
  'network.messagesReceived': number;
  'network.messagesSent': number;
  'security.rateLimitHits': number;
  'security.handshakeFailures': number;
  'security.reputationBans': number;
  'security.keyRotations': number;
  'bootstrap.attempts': number;
  'bootstrap.lastAttemptAt': number | null;
  'bootstrap.status': string;
}

/** Registry keys holding numbers, so `+=` type-checks and status strings cannot be incremented. */
type NumericRegistryKey = {
  [K in keyof Registry]: Registry[K] extends number ? K : never;
}[keyof Registry];

interface LinkInstance {
  state: string;
  isVirtual: boolean;
  remoteNodeId: Uint8Array | null;
  socket?: { remoteAddress?: string; remotePort?: number };
  isInitiator?: boolean;
}

interface NodeInstance {
  identity?: NodeIdentity;
  /** Present on nodes running the relay tier. */
  relayServer?: { getStats(): RelayStats } | null;
  connections: Map<string, LinkInstance>;
  virtualConnections: Map<string, LinkInstance>;
  /** RoutingTable's public surface. */
  routingTable?: {
    getAllRoutes(): Array<{ hopCount: number }>;
    getBestRoute(dest: string): { nextHopNodeId: string; hopCount: number } | null;
  };
  rotateKey?(newIdentity: unknown): KeyRotationPayload;
  bootstrap?: { stage: string; disableBootstrap?: boolean };
}

interface MetricsJSON {
  timestamp: string;
  /** Relay counters; null when the relay is off. */
  relay: RelayStats | null;
  node: {
    nodeId: string;
    uptimeSeconds: number;
    version: string;
  };
  peers: {
    current: number;
    peak: number;
    totalConnected: number;
    totalDisconnected: number;
  };
  routing: {
    tableSize: number;
    messagesForwarded: number;
    droppedNoRoute: number;
    droppedTTL: number;
    announcements: number;
  };
  network: {
    bytesSent: number;
    bytesReceived: number;
    messagesReceived: number;
    messagesSent: number;
  };
  security: {
    rateLimitHits: number;
    handshakeFailures: number;
    reputationBans: number;
    keyRotations: number;
  };
  bootstrap: {
    attempts: number;
    lastAttemptAt: number | null;
    status: string;
  };
}

interface HealthJSON {
  status: string;
  reason?: string;
}

interface PeerJSON {
  nodeId: string;
  address: string;
  port: number;
  type: string;
  isVirtual: boolean;
}

interface RotateKeyBody {
  newSeedPhrase?: string;
}

interface PingBody {
  targetNodeId?: string;
}

class MetricsTracker {
  private startTime: number;
  private registry: Registry;
  private server: http.Server | null;
  private nodeInstance: NodeInstance | null;
  private nodeManagerInstance: import('./gmp-node-manager.js').GMPNodeManager | null;

  constructor() {
    this.startTime = Date.now();
    this.registry = {
      'peers.current': 0,
      'peers.peak': 0,
      'peers.totalConnected': 0,
      'peers.totalDisconnected': 0,
      'routing.tableSize': 0,
      'routing.messagesForwarded': 0,
      'routing.droppedNoRoute': 0,
      'routing.droppedTTL': 0,
      'routing.announcements': 0,
      'routing.announcementsRejected': 0,
      'network.bytesSent': 0,
      'network.bytesReceived': 0,
      'network.messagesReceived': 0,
      'network.messagesSent': 0,
      'security.rateLimitHits': 0,
      'security.handshakeFailures': 0,
      'security.reputationBans': 0,
      'security.keyRotations': 0,
      'bootstrap.attempts': 0,
      'bootstrap.lastAttemptAt': null,
      'bootstrap.status': 'healthy',
    };
    this.server = null;
    this.nodeInstance = null;
    this.nodeManagerInstance = null;
  }

  increment(key: NumericRegistryKey, count: number = 1): void {
    if (this.registry[key] !== undefined) {
      this.registry[key] += count;
    }
  }

  set(key: keyof Registry, value: number | null): void {
    if (this.registry[key] !== undefined) {
      this.registry[key] = value as never;
    }
  }

  registerNode(node: NodeInstance, manager: import('./gmp-node-manager.js').GMPNodeManager | null = null): void {
    this.nodeInstance = node;
    if (manager) this.nodeManagerInstance = manager;
  }

  startServer(port?: number): void {
    if (this.server) return;
    const metricsPort = port || config.GMP_METRICS_PORT || 9090;

    this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' ||
                      remoteAddr === '::1' ||
                      remoteAddr === '::ffff:127.0.0.1' ||
                      remoteAddr === 'localhost';

      if (!isLocal) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access forbidden: localhost only' }));
        return;
      }

      // A local browser page also connects from 127.0.0.1, and POST /rotate-key
      // replaces the node's identity. So require a loopback Host (defeats DNS
      // rebinding), refuse any request carrying Origin (only browsers send it),
      // and require JSON on mutating endpoints (forces an unanswered preflight).
      const hostHeader = (req.headers.host || '').toLowerCase();
      const hostName = hostHeader.replace(/:\d+$/, '');
      const hostAllowed = hostName === '127.0.0.1' || hostName === 'localhost' ||
                          hostName === '[::1]' || hostName === '::1';
      if (!hostAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access forbidden: unexpected Host header' }));
        return;
      }

      if (req.headers.origin !== undefined) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access forbidden: cross-origin requests are not allowed' }));
        return;
      }

      const isMutating = req.method === 'POST';
      if (isMutating) {
        const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported Media Type: application/json required' }));
          return;
        }
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        const payload = this.getMetricsJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'GET' && req.url === '/health') {
        const payload = this.getHealthJSON();
        res.writeHead(payload.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'GET' && req.url === '/peers') {
        const payload = this.getPeersJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'POST' && req.url === '/rotate-key') {
        this.handleRotateKey(req, res);
      } else if (req.method === 'POST' && req.url === '/ping') {
        this.handlePing(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.on('error', (err: Error) => {
      logger.error('metrics', 'server-error', `Metrics server error: ${err.message}`, { err });
    });

    this.server.listen(metricsPort, '127.0.0.1', () => {
      logger.info('metrics', 'server-started', `Metrics server listening on http://127.0.0.1:${metricsPort}/metrics`);
    });
  }

  stopServer(): void {
    if (this.server) {
      try {
        this.server.close();
        logger.info('metrics', 'server-stopped', 'Metrics server stopped');
      } catch (_e) {
        // Ignore close error
      }
      this.server = null;
    }
  }

  getMetricsJSON(): MetricsJSON {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    let nodeId = 'unknown';
    let version = '1.0.0';
    let currentPeers = this.registry['peers.current'];
    let routingTableSize = this.registry['routing.tableSize'];
    let bootstrapStatus = 'healthy';

    if (this.nodeInstance) {
      if (this.nodeInstance.identity && this.nodeInstance.identity.nodeIdHex) {
        nodeId = this.nodeInstance.identity.nodeIdHex.slice(0, 16);
      }
      currentPeers = Array.from(this.nodeInstance.connections.values())
        .filter((link: LinkInstance) => link.state === 'connected' && !link.isVirtual).length;
      if (currentPeers > this.registry['peers.peak']) {
        this.registry['peers.peak'] = currentPeers;
      }
      if (this.nodeInstance.routingTable) {
        routingTableSize = this.nodeInstance.routingTable.getAllRoutes().length;
      }
      if (this.nodeInstance.bootstrap) {
        bootstrapStatus = this.nodeInstance.bootstrap.stage === 'failed' ? 'degraded' : 'healthy';
      }
    }

    return {
      timestamp: new Date().toISOString(),
      relay: this.nodeInstance && this.nodeInstance.relayServer ? this.nodeInstance.relayServer.getStats() : null,
      node: {
        nodeId,
        uptimeSeconds,
        version
      },
      peers: {
        current: currentPeers,
        peak: this.registry['peers.peak'],
        totalConnected: this.registry['peers.totalConnected'],
        totalDisconnected: this.registry['peers.totalDisconnected']
      },
      routing: {
        tableSize: routingTableSize,
        messagesForwarded: this.registry['routing.messagesForwarded'],
        droppedNoRoute: this.registry['routing.droppedNoRoute'],
        droppedTTL: this.registry['routing.droppedTTL'],
        announcements: this.registry['routing.announcements']
      },
      network: {
        bytesSent: this.registry['network.bytesSent'],
        bytesReceived: this.registry['network.bytesReceived'],
        messagesReceived: this.registry['network.messagesReceived'],
        messagesSent: this.registry['network.messagesSent']
      },
      security: {
        rateLimitHits: this.registry['security.rateLimitHits'],
        handshakeFailures: this.registry['security.handshakeFailures'],
        reputationBans: this.registry['security.reputationBans'],
        keyRotations: this.registry['security.keyRotations']
      },
      bootstrap: {
        attempts: this.registry['bootstrap.attempts'],
        lastAttemptAt: this.registry['bootstrap.lastAttemptAt'],
        status: bootstrapStatus
      }
    };
  }

  getHealthJSON(): HealthJSON {
    let status = 'ok';
    let reason = '';

    if (this.nodeInstance) {
      const currentPeers = Array.from(this.nodeInstance.connections.values())
        .filter((link: LinkInstance) => link.state === 'connected' && !link.isVirtual).length;

      if (this.nodeInstance.bootstrap && !this.nodeInstance.bootstrap.disableBootstrap && currentPeers === 0) {
        status = 'degraded';
        reason = 'No active peer connections';
      }
    }

    const res: HealthJSON = { status };
    if (reason) res.reason = reason;
    return res;
  }

  getPeersJSON(): PeerJSON[] {
    const peers: PeerJSON[] = [];
    if (this.nodeInstance) {
      for (const link of this.nodeInstance.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId) {
          peers.push({
            nodeId: Buffer.from(link.remoteNodeId).toString('hex'),
            address: link.socket ? link.socket.remoteAddress || 'unknown' : 'unknown',
            port: link.socket ? link.socket.remotePort || 0 : 0,
            type: link.isInitiator ? 'outgoing' : 'incoming',
            isVirtual: false
          });
        }
      }
      for (const link of this.nodeInstance.virtualConnections.values()) {
        if (link.state === 'connected' && link.remoteNodeId) {
          peers.push({
            nodeId: Buffer.from(link.remoteNodeId).toString('hex'),
            address: 'virtual',
            port: 0,
            type: link.isInitiator ? 'outgoing' : 'incoming',
            isVirtual: true
          });
        }
      }
    }
    return peers;
  }

  handleRotateKey(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { newSeedPhrase } = JSON.parse(body) as RotateKeyBody;
        if (!newSeedPhrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing newSeedPhrase' }));
          return;
        }

        if (!this.nodeInstance) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node not running' }));
          return;
        }

        const { deriveIdentityFromSeedPhrase } = await import('./identity.js');
        const newIdentity = await deriveIdentityFromSeedPhrase(newSeedPhrase);
        if (!this.nodeInstance.rotateKey) {
          throw new Error('Node does not support key rotation');
        }
        const cert = this.nodeInstance.rotateKey(newIdentity);

        try {
          const configPath = path.join(process.cwd(), 'gmp-core', 'data', 'config.json');
          let fileConfig: Record<string, unknown> = {};
          if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
          }
          fileConfig.GMP_SEED_PHRASE = newSeedPhrase;
          // The file holds the plaintext seed phrase: tighten an existing file
          // too, since writeFileSync's mode only applies on creation.
          fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
          fs.chmodSync(configPath, 0o600);
        } catch (e) {
          const err = e as Error;
          logger.warn('metrics', 'rotate-config-failed', `Could not update config.json: ${err.message}`);
        }

        this.increment('security.keyRotations');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, newNodeId: newIdentity.nodeIdHex, cert }));
      } catch (err) {
        const error = err as Error;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }

  handlePing(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', async () => {
      // Hoisted so the catch can disarm the timeout before answering.
      let cleanup: (() => void) | null = null;
      try {
        const { targetNodeId } = JSON.parse(body) as PingBody;
        if (!targetNodeId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetNodeId' }));
          return;
        }

        if (!this.nodeManagerInstance || !this.nodeInstance) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node not running' }));
          return;
        }

        const targetHex = targetNodeId.trim();
        const start = Date.now();

        let hops = 1;
        const route = this.nodeInstance.routingTable?.getBestRoute(targetHex);
        if (route && route.hopCount) {
          hops = route.hopCount;
        }

        const onMessage = (data: { fromNodeId: string; payload: Buffer | string }): void => {
          if (data.fromNodeId === targetHex) {
            try {
              const payloadStr = Buffer.isBuffer(data.payload) ? data.payload.toString('utf8') : data.payload;
              const payload = JSON.parse(payloadStr);
              if (payload.type === 'virtual-pong') {
                const rtt = Date.now() - start;
                cleanup?.();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, rtt, hops }));
              }
            } catch (_e) {}
          }
        };

        cleanup = (): void => {
          this.nodeManagerInstance?.off('message', onMessage);
          clearTimeout(timeout);
        };

        const timeout = setTimeout(() => {
          cleanup?.();
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ping timeout' }));
        }, 10000);

        this.nodeManagerInstance.on('message', onMessage);

        await this.nodeManagerInstance.sendMessage(
          targetHex,
          JSON.stringify({ type: 'virtual-ping', timestamp: start })
        );
      } catch (err) {
        cleanup?.();
        if (res.headersSent) return;
        const error = err as Error;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
}

const metrics = new MetricsTracker();
export default metrics;