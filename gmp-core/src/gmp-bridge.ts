import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { resolve } from 'path';
import { GMPNodeManager } from './gmp-node-manager.js';
import { NodeRegistry, RegistryError } from './node-registry.js';
import config from './config.js';
import logger from './logger.js';
import { ghostAddressFromNodeId } from './ghost-address.js';
import type { BridgeMessage } from './types.js';
import { PACKAGE_ROOT } from './paths.js';

const DEFAULT_BRIDGE_PORT = config.GMP_BRIDGE_PORT || 3002;
const DEFAULT_BRIDGE_HOST = config.GMP_BRIDGE_HOST || '127.0.0.1';

function isLocalIP(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function isPrivateLANIP(ip: string): boolean {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export interface BridgeOptions {
  /** Most nodes the bridge creates for seed phrases (default 8). */
  maxNodes?: number;
  /** Supply a registry (tests); otherwise one is built. */
  registry?: NodeRegistry;
  /**
   * A per-launch secret the client must present (as a WebSocket subprotocol) to
   * connect, regardless of Origin. When set (Electron passes a CSPRNG token),
   * any connection without it is refused — so another local process or user
   * cannot drive the node. Omitted for the CLI/self-host path (Origin/IP only).
   */
  authToken?: string;
  /**
   * Explicit opt-in to start a bridge WITHOUT an auth token (localhost dev /
   * self-host). Without this (or GMP_BRIDGE_ALLOW_TOKENLESS=1) startBridge
   * refuses to start when no token is given, so a tokenless bridge can never be
   * created by accident. When used, a warning is logged on every start.
   */
  allowTokenless?: boolean;
}

export interface BridgeHandle {
  wss: WebSocketServer;
  /** The host's node (the managerInstance argument), if any. */
  manager: GMPNodeManager | null;
  registry: NodeRegistry;
  /** Local port actually bound (differs from bridgePort when that was 0). */
  port: number;
  /** Stop listening, drop sessions, and stop the nodes the bridge created. */
  close(): Promise<void>;
}

/** One WebSocket client and the node it is bound to; only that node's events reach it. */
interface Session {
  ws: WebSocket;
  manager: GMPNodeManager | null;
}

export async function startBridge(
  managerInstance: GMPNodeManager | null = null,
  bridgePort: number = DEFAULT_BRIDGE_PORT,
  bridgeHost: string = DEFAULT_BRIDGE_HOST,
  options: BridgeOptions = {}
): Promise<BridgeHandle> {
  const registry = options.registry ?? new NodeRegistry({ maxNodes: options.maxNodes, defaultPort: config.GMP_PORT });
  if (managerInstance) registry.adopt(managerInstance);
  const sessions = new Set<Session>();

  const lanMode = bridgeHost === '0.0.0.0';
  const authToken = options.authToken ?? null;
  const allowTokenless = options.allowTokenless === true || process.env.GMP_BRIDGE_ALLOW_TOKENLESS === '1';
  const isAllowedIP = (ip: string): boolean => isLocalIP(ip) || (lanMode && isPrivateLANIP(ip));

  // Refuse to start a tokenless bridge unless explicitly allowed, so one is
  // never created by accident (any local process could otherwise drive the node).
  if (!authToken && !allowTokenless) {
    throw new Error(
      'startBridge: refusing to start without an auth token. Pass { authToken } ' +
      '(the Electron app does), or explicitly opt into a localhost dev/self-host ' +
      'bridge with { allowTokenless: true } or GMP_BRIDGE_ALLOW_TOKENLESS=1.');
  }
  if (!authToken) {
    logger.warn('bridge', 'tokenless-bridge',
      'Bridge started WITHOUT an auth token (explicit dev/self-host opt-in). Any local ' +
      'process or user that passes the Origin/IP checks can drive this node. Use the ' +
      'token path (Electron) for an untrusted multi-user host.');
  }

  if (lanMode) {
    logger.warn('bridge', 'lan-mode-enabled', 'Bridge bound to all interfaces — only use on trusted LAN, never expose to internet', { bridgeHost });
  }

  let tlsAvailable = false;
  let certPathUsed: string | null = null;
  let httpsServer: https.Server | undefined;
  try {
    // Certs live at the repo root; this file runs from dist/, so check the
    // package root and then the repo root.
    const candidates = process.env.GMP_BRIDGE_CERT && process.env.GMP_BRIDGE_KEY
      ? [{ cert: resolve(process.env.GMP_BRIDGE_CERT), key: resolve(process.env.GMP_BRIDGE_KEY) }]
      : [
          { cert: resolve(PACKAGE_ROOT, 'cert.pem'), key: resolve(PACKAGE_ROOT, 'key.pem') },
          { cert: resolve(PACKAGE_ROOT, '..', 'cert.pem'), key: resolve(PACKAGE_ROOT, '..', 'key.pem') }
        ];

    let loaded: { cert: Buffer; key: Buffer; path: string } | null = null;
    let lastErr: Error | null = null;
    for (const c of candidates) {
      try {
        loaded = { cert: readFileSync(c.cert), key: readFileSync(c.key), path: c.cert };
        break;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    if (!loaded) throw lastErr || new Error('no cert/key pair found');

    httpsServer = https.createServer({ cert: loaded.cert, key: loaded.key });
    tlsAvailable = true;
    certPathUsed = loaded.path;
    logger.info('bridge', 'tls-enabled', `Bridge TLS available for wss:// (cert: ${loaded.path})`);
  } catch (e) {
    const err = e as Error;
    logger.warn('bridge', 'tls-unavailable',
      'cert.pem / key.pem not found — bridge serves plain ws:// only. ' +
      'https:// frontends cannot connect until certs exist. ' +
      'Generate with: mkcert -cert-file cert.pem -key-file key.pem <LAN-IP> localhost',
      { error: err.message });
  }

  // Echo the client's first offered subprotocol so a browser WebSocket that
  // presents the bridge token (as a subprotocol) gets a confirmed handshake.
  // The token itself is validated in upgradeAllowed before this runs.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>): string | false => {
      const first = protocols.values().next().value;
      return first ?? false;
    },
  });

  // Constant-time check that one of the offered WebSocket subprotocols equals
  // the per-launch bridge token. Never logs the token value.
  const tokenPresented = (req: http.IncomingMessage): boolean => {
    if (!authToken) return true;
    const header = req.headers['sec-websocket-protocol'];
    const offered = (Array.isArray(header) ? header.join(',') : (header || ''))
      .split(',').map((s) => s.trim()).filter(Boolean);
    const want = Buffer.from(authToken);
    return offered.some((p) => {
      const got = Buffer.from(p);
      return got.length === want.length && timingSafeEqual(got, want);
    });
  };

  const rejectUpgrade = (socket: net.Socket, status: number, message: string): void => {
    try { socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`); } catch (_e) {}
    try { socket.destroy(); } catch (_e) {}
  };

  const upgradeAllowed = (req: http.IncomingMessage, socket: net.Socket): boolean => {
    const remoteAddr = req.socket.remoteAddress;
    if (!remoteAddr || !isAllowedIP(remoteAddr)) {
      logger.warn('bridge', 'client-rejected-ip', `WebSocket connection from unauthorized IP: ${remoteAddr}`, { remoteAddr });
      rejectUpgrade(socket, 401, lanMode
        ? 'Unauthorized: Only localhost and private LAN (RFC1918) connections are allowed'
        : 'Unauthorized: Only localhost connections are allowed');
      return false;
    }
    // Per-launch token: when set, it is required regardless of Origin, so
    // another local process/user (which passes the IP check and may send no
    // Origin) still cannot connect. Checked before Origin; never logs the token.
    if (!tokenPresented(req)) {
      logger.warn('bridge', 'client-rejected-token', 'WebSocket connection without a valid bridge token refused');
      rejectUpgrade(socket, 401, 'Unauthorized: a valid bridge token is required');
      return false;
    }
    // Origin is an additional cross-site control. A browser attacking 127.0.0.1
    // connects from 127.0.0.1. The opaque 'null' origin (sandboxed iframes) is
    // always refused. A missing Origin is accepted only for the tokenless
    // CLI/self-host path; with a token set, the token gate above already applied.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'file://') {
      if (origin === 'null') {
        logger.warn('bridge', 'client-rejected-origin',
          'WebSocket connection with opaque "null" origin refused — this is how a sandboxed ' +
          'iframe on any site would reach the bridge.', { origin });
        rejectUpgrade(socket, 403, 'Forbidden: Opaque origin not allowed');
        return false;
      }
      if (origin !== 'null') {
        try {
          const url = new URL(origin);
          if (!(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1' || (lanMode && isPrivateLANIP(url.hostname)))) {
            logger.warn('bridge', 'client-rejected-origin', `WebSocket connection from unauthorized origin: ${origin}`, { origin });
            rejectUpgrade(socket, 403, 'Forbidden: Origin not allowed');
            return false;
          }
        } catch (_e) {
          rejectUpgrade(socket, 400, 'Bad Request: Invalid Origin');
          return false;
        }
      }
    }
    return true;
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    if (!upgradeAllowed(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const handleRequest = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GhostLink GMP bridge — WebSocket endpoint.\n');
  };

  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);
  if (httpsServer) {
    httpsServer.on('request', handleRequest);
    httpsServer.on('upgrade', handleUpgrade);
  }

  const listener = net.createServer((socket: net.Socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch (_e) {} });
    socket.once('data', (chunk: Buffer) => {
      socket.pause();
      socket.unshift(chunk);
      const isTls = chunk && chunk.length > 0 && chunk[0] === 0x16;
      const target = (isTls && httpsServer) ? httpsServer : httpServer;
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  await new Promise<void>((res, rej) => {
    listener.once('error', rej);
    listener.listen(bridgePort, bridgeHost, res);
  });

  const sendTo = (session: Session, eventObj: BridgeMessage): void => {
    if (session.ws.readyState !== WebSocket.OPEN) return;
    try {
      session.ws.send(JSON.stringify(eventObj));
    } catch (e) {
      const err = e as Error;
      logger.error('bridge', 'client-send-failed', `Failed to send message to client: ${err.message}`, { err });
    }
  };

  /** Deliver a node's event to the sessions bound to that node only. */
  const publish = (m: GMPNodeManager, eventObj: BridgeMessage): void => {
    for (const session of sessions) {
      if (session.manager === m) sendTo(session, eventObj);
    }
  };

  const startedMessage = (m: GMPNodeManager): BridgeMessage => ({
    type: 'started',
    nodeId: m.getNodeId(),
    address: '127.0.0.1',
    port: m.node ? m.node.port : null,
    ghostAddress: ghostAddressFromNodeId(m.getNodeId())
  });

  const wired = new WeakSet<GMPNodeManager>();
  const wireManagerEvents = (m: GMPNodeManager): void => {
    if (wired.has(m)) return;
    wired.add(m);

    m.on('peer-connected', ({ nodeId, address, port, transport }) => {
      publish(m, { type: 'peer-connected', nodeId, address, port, transport });
    });

    m.on('peer-disconnected', ({ nodeId }) => {
      publish(m, { type: 'peer-disconnected', nodeId });
    });

    m.on('message', ({ fromNodeId, payload, via }) => {
      publish(m, { type: 'message', fromNodeId, payload, ...(via ? { via } : {}) });
    });

    // Store-and-forward state. localId is the client's own ID for
    // the message; each state comes from the protocol, never from a clock.
    m.on('sf-stored', (e) => publish(m, { type: 'sf-stored', ...e }));
    m.on('sf-delivered', (e) => publish(m, { type: 'sf-delivered', ...e }));
    m.on('sf-expired', (e) => publish(m, { type: 'sf-expired', ...e }));
    m.on('storage-status', (e) => publish(m, { type: 'storage-status', ...e }));

    m.on('bootstrap-complete', ({ peersConnected }) => {
      publish(m, { type: 'bootstrap-complete', peersConnected });
    });

    m.on('bootstrap-failed', ({ peersConnected, diagnosis }) => {
      // The reason travels with the event so the UI can say which of the three
      // failures this is, instead of guessing one message for all of them.
      publish(m, {
        type: 'bootstrap-failed',
        peersConnected,
        reason: diagnosis ? diagnosis.reason : 'unknown',
        publicPeersConfigured: diagnosis ? diagnosis.publicPeersConfigured : 0,
        peersFile: diagnosis ? diagnosis.peersFile : null,
        attempts: diagnosis ? diagnosis.attempts : []
      });
    });

    m.on('external-address', ({ address, port }) => {
      publish(m, { type: 'external-address', address, port });
    });

    m.on('routing-degraded', (data) => {
      publish(m, { type: 'routing-degraded', ...data });
    });
  };

  if (managerInstance) {
    wireManagerEvents(managerInstance);
  }

  const notStarted = (session: Session): void => {
    sendTo(session, { type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' });
  };

  wss.on('connection', (ws: WebSocket) => {
    const session: Session = { ws, manager: null };
    sessions.add(session);

    // A client that sends no seed uses the host's node, as it always has.
    const host = registry.default;
    if (host && host.node) {
      session.manager = host;
      sendTo(session, startedMessage(host));
    }

    ws.on('message', async (data: Buffer) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as BridgeMessage;
        // Valid JSON is not necessarily an object: `null` made `msg.type` below
        // throw inside this async handler, an unhandled rejection that killed
        // the bridge process.
        if (!msg || typeof msg !== 'object') throw new Error('not an object');
      } catch (_e) {
        sendTo(session, { type: 'error', code: 'INVALID_JSON', message: 'Failed to parse JSON' });
        return;
      }

      const requestId = typeof msg.requestId === 'string' || typeof msg.requestId === 'number' ? msg.requestId : undefined;

      switch (msg.type) {
        case 'start': {
          // The node is chosen by the seed phrase, never by the session: the
          // same seed from any session reaches the same node, a different seed
          // a different, isolated one. No seed means the host's node.
          const seedPhrase = typeof msg.seedPhrase === 'string' && msg.seedPhrase ? msg.seedPhrase : undefined;
          const port = Number(msg.port) || undefined;
          let m: GMPNodeManager;
          try {
            m = await registry.acquire(seedPhrase, port);
          } catch (err) {
            const error = err as Error;
            sendTo(session, {
              type: 'error',
              code: 'START_FAILED',
              reason: err instanceof RegistryError ? err.code : 'NODE_START_FAILED',
              message: error.message
            });
            return;
          }
          wireManagerEvents(m);
          session.manager = m;
          sendTo(session, startedMessage(m));
          break;
        }

        case 'connect': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          const res = await m.connectToPeer(String(msg.address), Number(msg.port));
          sendTo(session, { type: 'connect-result', ...res });
          break;
        }

        case 'send':
        case 'sendDirect': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          try {
            const destinationNodeId = String(msg.destinationNodeId);
            const payload = String(msg.payload);
            if (msg.type === 'send') await m.sendMessage(destinationNodeId, payload);
            else await m.sendDirect(destinationNodeId, payload);
          } catch (err) {
            const error = err as Error;
            sendTo(session, { type: 'error', code: error.name || 'SEND_FAILED', message: error.message });
          }
          break;
        }

        case 'getStatus': {
          const m = session.manager;
          if (!m) {
            sendTo(session, { type: 'status', status: 'offline', peers: [] });
            return;
          }
          try {
            sendTo(session, { type: 'status', ...m.getStatus() });
          } catch (err) {
            const error = err as Error;
            sendTo(session, { type: 'error', code: 'STATUS_FAILED', message: error.message });
          }
          break;
        }

        case 'resolve': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          try {
            const result = await m.lookupGhostAddress(String(msg.address));
            sendTo(session, { type: 'resolve-result', requestId, ...result });
          } catch (err) {
            const error = err as Error;
            sendTo(session, { type: 'error', code: 'RESOLVE_FAILED', message: error.message });
          }
          break;
        }

        // Decide whether a presented NodeID may be accepted for a pinned
        // contact. The decision is made HERE (main process), using gmp-core's
        // verified rotations; the renderer only sends the NodeIDs and shows the
        // result. accept | update-pin | mismatch.
        case 'pin-check': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          const presentedNodeId = typeof msg.presentedNodeId === 'string' ? msg.presentedNodeId : '';
          if (!presentedNodeId) {
            sendTo(session, { type: 'error', code: 'PIN_CHECK_FAILED', message: 'presentedNodeId is required', requestId });
            break;
          }
          const pinnedNodeId = typeof msg.pinnedNodeId === 'string' && msg.pinnedNodeId ? msg.pinnedNodeId : null;
          const decision = m.pinDecision(pinnedNodeId, presentedNodeId);
          sendTo(session, { type: 'pin-result', requestId, decision, contactId: msg.contactId });
          break;
        }

        // Deposit a message for an offline contact. The reply is the
        // manager's 'sf-stored' event (SENT, stored) or an sf-failed error.
        case 'sf-send': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          const localId = typeof msg.localId === 'string' && msg.localId ? msg.localId : undefined;
          try {
            await m.storeForwardSend(String(msg.destinationNodeId), String(msg.payload), localId);
          } catch (err) {
            const error = err as Error & { code?: string };
            sendTo(session, { type: 'sf-failed', localId, code: error.code || error.name || 'SF_FAILED', message: error.message });
          }
          break;
        }

        // Poll the mailbox now: the app came to the foreground or the network changed.
        case 'sf-poll': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          const reason = msg.reason === 'foreground' || msg.reason === 'network' ? msg.reason : 'manual';
          m.pollMailbox(reason).catch(() => {});
          break;
        }

        // The app's contact list: whose channels to poll.
        case 'sf-contacts': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          const ids = Array.isArray(msg.nodeIds) ? msg.nodeIds.filter((x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{128}$/i.test(x)) : [];
          m.setMailboxContacts(ids);
          sendTo(session, { type: 'storage-status', ...m.storageStatus() });
          break;
        }

        case 'connectNode': {
          const m = session.manager;
          if (!m || !m.node) return notStarted(session);
          try {
            let result;
            if (typeof msg.address === 'string' && msg.address) {
              result = await m.connectByGhostAddress(msg.address);
            } else if (typeof msg.nodeId === 'string' && msg.nodeId) {
              result = await m.connectByNodeId(msg.nodeId);
            } else {
              result = { connected: false, transport: 'no-target' };
            }
            sendTo(session, { type: 'connect-result', requestId, ...result });
          } catch (err) {
            const error = err as Error;
            sendTo(session, { type: 'error', code: 'CONNECT_FAILED', message: error.message });
          }
          break;
        }

        default: {
          sendTo(session, { type: 'error', code: 'UNKNOWN_COMMAND', message: `Unknown command type: ${msg.type}` });
        }
      }
    });

    ws.on('close', () => {
      sessions.delete(session);
    });

    ws.on('error', () => {
      sessions.delete(session);
    });
  });

  const schemes = tlsAvailable ? 'ws:// and wss://' : 'ws:// only';
  logger.info('bridge', 'server-started',
    `GMP bridge listening on ${bridgeHost}:${bridgePort} (${schemes}, scheme auto-detected per connection)`,
    { tls: tlsAvailable, certPath: certPathUsed });

  const boundAddress = listener.address();
  const close = async (): Promise<void> => {
    for (const session of sessions) {
      try { session.ws.terminate(); } catch (_e) {}
    }
    sessions.clear();
    await new Promise<void>((res) => wss.close(() => res()));
    await new Promise<void>((res) => listener.close(() => res()));
    httpServer.close();
    if (httpsServer) httpsServer.close();
    await registry.stopAll();
  };

  return {
    wss,
    manager: managerInstance,
    registry,
    port: boundAddress && typeof boundAddress === 'object' ? boundAddress.port : bridgePort,
    close,
  };
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  process.argv[1].endsWith('gmp-bridge.js')
);

if (isMain) {
  const port = process.env.GMP_BRIDGE_PORT ? parseInt(process.env.GMP_BRIDGE_PORT) : DEFAULT_BRIDGE_PORT;
  const host = process.env.GMP_BRIDGE_HOST || DEFAULT_BRIDGE_HOST;
  // The standalone bridge makes nodes per client session; it is not a public peer.
  logger.info('gmp-bridge', 'standalone', `Standalone bridge on ${host}:${port}: no node of its own; nodes are created per client session. This process is not a GMP public peer (that is \`gmp public-peer\`).`);
  void import('./claim-log-diagnostic.js')
    .then(({ logStartupClaimLogCheck }) => (process.env.GMP_SEED_PHRASE ? logStartupClaimLogCheck('gmp-bridge', process.env.GMP_SEED_PHRASE) : null))
    // The standalone bridge is the explicit self-host entry, so it opts into a
    // tokenless bridge (startBridge logs a warning on every start).
    .finally(() => startBridge(null, port, host, { allowTokenless: true }).catch((e) => {
      logger.error('gmp-bridge', 'start-refused', (e as Error).message);
      process.exit(1);
    }));
}