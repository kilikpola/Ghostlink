import { EventEmitter } from 'events';
import type { GMPNodeManagerEvents } from './events.js';
import type { GMPNode } from './link.js';
import { createGMPNode, type CreateNodeOptions } from './node-factory.js';
import { loadConfigDetailed } from './config.js';
import type { ConfigIssue } from './config.js';
import metrics from './metrics.js';
import logger from './logger.js';
import { ghostAddressFromNodeId, normalizeGhostAddress, findNodeIdsForAddress } from './ghost-address.js';
import { pinOnPresented, type PinDecision } from './contact-pin.js';
import type {
  GMPConfig,
  GMPNodeManagerOptions,
  GMPNodeConstructorOptions,
  GMPLinkLike,
} from './types.js';
import type { BootstrapDiagnosis } from './bootstrap.js';
import { loadPublicPeers, queryPublicAddress } from './public-peer-list.js';
import { deriveIdentityFromSeedPhrase } from './identity.js';
import crypto from 'crypto';
import path from 'path';
import { DATA_DIR } from './paths.js';
import { StoreForward, parseStoragePeer } from './storage/store-forward.js';
import type { StorageAddress } from './storage/storage-client.js';
import { SfPollScheduler } from './storage/sf-scheduler.js';
import { sampleResources, reportAgainst, fdPressure } from './resource-sample.js';

/** How long a direct dial to a LAN-discovered peer may take before falling back to the mesh. */
const LAN_DIAL_TIMEOUT_MS = 5000;

/**
 * How a peer is reached, as shown in the UI. A relay not separated from hosts
 * that know this node's identity is reported as 'relayed-unseparated'.
 */
export type PeerTransport = 'direct' | 'relayed' | 'relayed-unseparated';

function transportOf(link: { socket?: { isRelayed?: boolean; separation?: string } | null }): PeerTransport {
  const socket = link.socket;
  if (!socket || !socket.isRelayed) return 'direct';
  return socket.separation === 'separated' ? 'relayed' : 'relayed-unseparated';
}

function toHex(nodeId: string | Buffer | Uint8Array): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return String(nodeId);
}

export class GMPNodeManager extends EventEmitter<GMPNodeManagerEvents> {
  private readonly options: GMPNodeManagerOptions;
  /** Resolved once, at construction: explicit option > env > config file > default. */
  private readonly config: GMPConfig;
  private readonly configIssues: ConfigIssue[];
  /** The live node; null before start() and after stop(). */
  private _node: GMPNode | null;
  private connToNodeId: Map<string, string>;
  private externalAddress: { address: string; port: number } | null;
  private discoveringExternal: boolean;
  /** Sealed store-and-forward client; null before start(). */
  private _sf: StoreForward | null = null;
  private _sfScheduler: SfPollScheduler | null = null;
  private _resourceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GMPNodeManagerOptions = {}) {
    super();
    this.options = options;
    const resolved = loadConfigDetailed({ ...options });
    // Unattended hosts (public peer, relay, storage) default to strict state;
    // user clients do not. An explicit GMP_STRICT_STATE always wins.
    const unattended = !!options.isPublicPeer || resolved.config.GMP_RELAY_ENABLED || resolved.config.GMP_STORAGE_ENABLED;
    this.config = resolved.sources.GMP_STRICT_STATE === 'default'
      ? { ...resolved.config, GMP_STRICT_STATE: unattended }
      : resolved.config;
    // Hosts others bootstrap from default to GMP_MIN_PEERS 0, so a lone host
    // does not retry bootstrap forever. An explicit value wins.
    if (unattended && resolved.sources.GMP_MIN_PEERS === 'default') {
      this.config = { ...this.config, GMP_MIN_PEERS: 0 };
    }
    this.configIssues = resolved.issues;
    this._node = null;
    this.connToNodeId = new Map();
    this.externalAddress = null;
    this.discoveringExternal = false;
  }

  /** Read-only access to the live node for the bridge and CLI. */
  get node(): GMPNode | null {
    return this._node;
  }

  /**
   * Learn this node's external address from a public peer via BINDING_REQUEST.
   * Runs once per peer-connected until it succeeds.
   */
  private async discoverExternalAddress(): Promise<void> {
    if (!this._node || this.externalAddress || this.discoveringExternal) return;
    const peers = loadPublicPeers();
    if (peers.length === 0) return;

    this.discoveringExternal = true;
    try {
      const found = await queryPublicAddress(this._node as never, peers, 5000);
      this.externalAddress = found;
      logger.info('gmp-node-manager', 'external-address', `External address is ${found.address}:${found.port}`, found);
      this.emit('external-address', found);
    } catch (e) {
      const err = e as Error;
      logger.warn('gmp-node-manager', 'external-address-failed', `Could not determine external address: ${err.message}`, { err: err.message });
    } finally {
      this.discoveringExternal = false;
    }
  }

  /** This manager's state directory; null means the process-wide default. */
  get dataDir(): string | null {
    return this.options.dataDir ?? null;
  }

  /**
   * The NodeID this manager runs (or will run) as; null without a seed. Used by
   * the node registry.
   */
  async resolveNodeId(): Promise<string | null> {
    if (this._node && this._node.identity) return this._node.identity.nodeIdHex;
    const seedPhrase = this.options.GMP_SEED_PHRASE || this.options.seedPhrase;
    if (!seedPhrase) return null;
    const identity = await deriveIdentityFromSeedPhrase(seedPhrase);
    return Buffer.from(identity.nodeId).toString('hex');
  }

  private _starting: Promise<{ nodeId: string; address: string; port: number }> | null = null;

  /**
   * Start the node. Concurrent calls share one attempt (the bridge and its
   * host can both ask for the same node); a call after a completed start
   * still throws.
   */
  start(): Promise<{ nodeId: string; address: string; port: number }> {
    if (this._starting) return this._starting;
    if (this._node) {
      return Promise.reject(new Error('GMPNodeManager already started'));
    }
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  private async _start(): Promise<{ nodeId: string; address: string; port: number }> {

    const seedPhrase = this.options.GMP_SEED_PHRASE || this.options.seedPhrase;

    for (const issue of this.configIssues) {
      logger.warn('gmp-node-manager', 'config-value-ignored',
        `Ignoring ${issue.source} config value for ${issue.key}: ${issue.reason}`,
        { key: issue.key, source: issue.source, reason: issue.reason });
    }

    // isPublicPeer is deliberately not forwarded: it never has been, and
    // turning it on changes the bind address and adds a strict per-IP limiter
    // on the deployed public peer. See ARCHITECTURE_BASELINE.md §11.
    const nodeOptions: GMPNodeConstructorOptions = {
      config: this.config,
      dataDir: this.options.dataDir,
      seedPhrase,
      transport: this.options.transport,
      ...(this.options.disableBootstrap ? { disableBootstrap: true } : {}),
    };

    this._node = createGMPNode(nodeOptions as CreateNodeOptions);

    this._node.on('connection', ({ connId, link, peerNodeId }: { connId: string; link: GMPLinkLike; peerNodeId: Uint8Array }) => {
      const nodeIdHex = toHex(peerNodeId);
      this.connToNodeId.set(connId, nodeIdHex);

      const address = link.socket ? link.socket.remoteAddress : null;
      const port = link.socket ? link.socket.remotePort : null;

      metrics.increment('peers.totalConnected');
      this.emit('peer-connected', { nodeId: nodeIdHex, address, port, transport: transportOf(link) });
      void this.discoverExternalAddress();
      this._onSfPeer(nodeIdHex, link);
    });

    this._node.on('close', ({ connId }: { connId: string }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      if (nodeIdHex) {
        this.connToNodeId.delete(connId);
        metrics.increment('peers.totalDisconnected');
        this.emit('peer-disconnected', { nodeId: nodeIdHex });
      }
    });

    this._node.on('message', ({ connId, msg }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      let fromHex = nodeIdHex;
      if (!fromHex && this._node) {
        const link = this._node.links.get(connId);
        if (link && link.remoteNodeId) {
          fromHex = toHex(link.remoteNodeId);
        }
      }

      if (fromHex) {
        try {
          const msgStr = Buffer.from(msg).toString('utf8');
          const parsed = JSON.parse(msgStr);
          if (parsed && parsed.type === 'virtual-ping') {
            this.sendMessage(fromHex, JSON.stringify({ type: 'virtual-pong', timestamp: parsed.timestamp }))
              .catch(() => {});
            return;
          }
          // A contact telling us, end to end, where its mailbox is.
          if (parsed && parsed.type === 'gmp-sf-mailbox') {
            const m = parsed.mailbox;
            if (this._sf && m && typeof m.address === 'string' && Number.isInteger(m.port) && m.port > 0 && m.port < 65536) {
              this._sf.setMailbox(fromHex, {
                address: m.address,
                port: m.port,
                ...(typeof m.nodeId === 'string' && /^[0-9a-f]{128}$/.test(m.nodeId) ? { nodeId: m.nodeId } : {}),
              });
            }
            return;
          }
        } catch { }
      }

      if (fromHex) {
        this.emit('message', { fromNodeId: fromHex, payload: Buffer.from(msg).toString('utf8') });
      }
    });

    this._node.on('bootstrap-complete', (peersConnected: number) => {
      this.emit('bootstrap-complete', { peersConnected });
    });

    this._node.on('bootstrap-failed', (peersConnected: number, diagnosis?: BootstrapDiagnosis) => {
      this.emit('bootstrap-failed', { peersConnected, diagnosis: diagnosis ?? null });
    });

    this._node.on('routing-degraded', (data) => {
      this.emit('routing-degraded', data);
    });

    try {
      await this._node.loadIdentity(seedPhrase);

      metrics.registerNode(this._node, this);
      metrics.startServer(this.config.GMP_METRICS_PORT);

      await this._node.listen();
      if (this.options.storeForward !== false) this._startStoreForward(seedPhrase);
      this._startResourceLog();
    } catch (err) {
      // Leave no half-started node behind, so start() can be retried.
      metrics.stopServer();
      try { this._node.close(); } catch { }
      this._node = null;
      this.connToNodeId.clear();
      throw err;
    }

    return {
      nodeId: this._node.identity.nodeIdHex,
      address: '127.0.0.1',
      port: this._node.port
    };
  }

  async stop(): Promise<void> {
    if (!this._node) return;
    if (this._resourceTimer) clearInterval(this._resourceTimer);
    this._resourceTimer = null;
    if (this._sfScheduler) this._sfScheduler.stop();
    this._sfScheduler = null;
    this._sf = null;

    metrics.stopServer();

    if (this._node.topologyManager) {
      for (const link of this._node.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
          try {
            this._node.topologyManager.handleLinkClosed(link.remoteNodeId);
          } catch { }
        }
      }
    }

    await new Promise(r => setTimeout(r, 100));

    if (this._node.peerCache) {
      try {
        this._node.peerCache.save();
      } catch { }
    }

    this._node.close();
    this._node = null;
    this.connToNodeId.clear();
  }

  // ── Resource self-measurement ───────

  /**
   * Every GMP_RESOURCE_LOG_INTERVAL_MS, log RSS, heap, open fds and links with
   * per-link deltas. Off (0) by default.
   */
  private _startResourceLog(): void {
    const ms = Number(this.config.GMP_RESOURCE_LOG_INTERVAL_MS) || 0;
    const node = this._node;
    if (ms <= 0 || !node) return;
    const baseline = sampleResources(node as never);
    const frac = Number(this.config.GMP_FD_WARN_FRACTION);
    const warnAt = frac > 0 && frac <= 1 ? frac : 0.8;
    // A soft limit below the connection cap is handled where the cap lives:
    // GMPNode.listen clamps it and logs link/connection-cap (every start).
    let fdMismatchWarned = false;
    const log = (): void => {
      if (!this._node) return;
      const r = reportAgainst(baseline, sampleResources(this._node as never));
      logger.info('gmp-node-manager', 'resource-sample',
        `rss ${(r.rssBytes / 1048576).toFixed(1)} MiB, fds ${r.openFds ?? '?'}/${r.fdLimit ?? '?'} (hard ${r.fdHardLimit ?? '?'}), links ${r.links} (${r.connected} connected) from ${r.distinctAddresses} address(es), max ${r.maxLinksPerAddress} per address` +
        (r.rssPerLinkBytes !== null ? `, ${(r.rssPerLinkBytes / 1024).toFixed(1)} KiB and ${r.fdsPerLink ?? '?'} fds per link over baseline` : ''),
        { ...r, baselineRssBytes: baseline.rssBytes, baselineFds: baseline.openFds, cap: this.config.GMP_RATE_LIMIT_MAX_GLOBAL });
      // Ground truth vs what the node can explain: fds at start plus one per
      // link. The live pressure check (rate-limiter) only sees connections;
      // descriptors held by anything else show up here.
      if (r.openFds !== null && baseline.openFds !== null) {
        const expected = baseline.openFds + r.links;
        const gap = r.openFds - expected;
        const tolerance = Math.max(16, Math.round(0.1 * (r.fdLimit ?? 0)));
        if (Math.abs(gap) > tolerance && !fdMismatchWarned) {
          fdMismatchWarned = true;
          logger.warn('gmp-node-manager', 'fd-count-mismatch',
            `Open descriptors ${r.openFds} vs ${expected} explained by links (${baseline.openFds} at start + ${r.links} links): ${gap > 0 ? `${gap} held by something other than connections` : `${-gap} fewer than expected`}; the connection-based pressure check cannot see these`,
            { openFds: r.openFds, expected, gap, links: r.links, baselineFds: baseline.openFds, fdLimit: r.fdLimit });
        } else if (Math.abs(gap) <= tolerance / 2) {
          fdMismatchWarned = false;
        }
      }
      const p = fdPressure(r);
      if (p !== null && p >= warnAt) {
        logger.warn('gmp-node-manager', 'fd-pressure',
          `Open descriptors ${r.openFds} of soft limit ${r.fdLimit} (${Math.round(p * 100)}%, warn at ${Math.round(warnAt * 100)}%): at the limit new connections are dropped with no error logged`,
          { openFds: r.openFds, fdLimit: r.fdLimit, fdHardLimit: r.fdHardLimit, fraction: Math.round(p * 1000) / 1000, warnAt, links: r.links });
      }
    };
    log();
    this._resourceTimer = setInterval(log, ms);
    this._resourceTimer.unref?.();
  }

  // ── Sealed store-and-forward ─────────────

  /** This user's mailbox: the self-hosted peer if configured, else the first listed storage host. */
  private _ownMailbox(): StorageAddress | null {
    const self = parseStoragePeer(this.config.GMP_SF_STORAGE_PEER);
    if (self) return self;
    const listed = loadPublicPeers(this._node?.bootstrap?.publicPeersPath || undefined)
      .filter((p) => p.roles.includes('storage'))
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))[0];
    return listed
      ? { address: listed.address, port: listed.port, nodeId: listed.nodeId, tls: listed.tls, operator: listed.operator }
      : null;
  }

  private _startStoreForward(seedPhrase: string | undefined): void {
    const node = this._node;
    if (!node) return;
    const dir = this.options.dataDir ?? DATA_DIR;
    this._sf = new StoreForward({
      host: node as never,
      stateFile: path.join(dir, 'store-forward.state'),
      encryptionKey: seedPhrase ? crypto.pbkdf2Sync(seedPhrase, 'ghostlink-sf-client-v1', 100000, 32, 'sha256') : null,
      strictState: this.config.GMP_STRICT_STATE === true,
      fetchBuckets: this.config.GMP_SF_FETCH_BUCKETS,
      decoyChannels: this.config.GMP_SF_DECOY_CHANNELS,
      cursorQuantumMs: this.config.GMP_SF_CURSOR_QUANTUM_MS,
      ttlMs: this.config.GMP_SF_TTL_MS,
      ownMailbox: () => this._ownMailbox(),
    });
    this._sf.on('stored', (e) => this.emit('sf-stored', e));
    this._sf.on('delivered', (e) => this.emit('sf-delivered', e));
    this._sf.on('expired', (e) => this.emit('sf-expired', e));
    this._sf.on('message', (m) => this.emit('message', { fromNodeId: m.fromNodeId, payload: m.payload, via: 'mailbox' }));
    this._sf.on('poll-complete', () => this.emit('storage-status', this.storageStatus()));
    this._sfScheduler = new SfPollScheduler(this.config.GMP_SF_POLL_INTERVAL_MS, (reason) => this._sf ? this._sf.poll(reason) : Promise.resolve());
    this._sfScheduler.start();
  }

  /** Every authenticated contact: remember its static key; tell app contacts where our mailbox is. */
  private _onSfPeer(nodeIdHex: string, link: GMPLinkLike): void {
    if (!this._sf || !link.remoteStaticPubkey) return;
    this._sf.learnContact(nodeIdHex, link.remoteStaticPubkey);
    const announce = this._sf.mailboxAnnouncement();
    if (announce && this._sf.isPollContact(nodeIdHex)) {
      link.send(JSON.stringify({ type: 'gmp-sf-mailbox', mailbox: announce })).catch(() => {});
    }
  }

  /** Deposit a message for an offline contact. Resolves on the host's STORE_ACK (SENT, stored). */
  async storeForwardSend(destinationNodeId: string, payload: string, localId?: string): Promise<{ localId: string }> {
    if (!this._sf) throw new Error('GMPNodeManager not started');
    return this._sf.send(toHex(destinationNodeId), payload, localId);
  }

  /** Poll now ('foreground', 'network', ...). The interval schedule re-arms from here. */
  async pollMailbox(reason: string): Promise<void> {
    if (!this._sfScheduler) throw new Error('GMPNodeManager not started');
    await this._sfScheduler.trigger(reason);
  }

  /** The app's contacts: whose channels to poll, and whom to tell about our mailbox. */
  setMailboxContacts(nodeIds: string[]): void {
    if (!this._sf) throw new Error('GMPNodeManager not started');
    this._sf.setPollContacts(nodeIds.map((n) => toHex(n)));
    if (this._node) {
      for (const link of this._node.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId) this._onSfPeer(toHex(link.remoteNodeId), link as never);
      }
    }
  }

  storageStatus(): { host: string | null; separation: 'separated' | 'unseparated' | 'none'; selfHosted: boolean; pending: number } {
    return this._sf ? this._sf.status() : { host: null, separation: 'none', selfHosted: false, pending: 0 };
  }

  get storeForward(): StoreForward | null {
    return this._sf;
  }

  async connectToPeer(address: string, port: number, options: { tls?: boolean } = {}): Promise<{ nodeId: string | null; connected: boolean }> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    try {
      const result = await this._node.dial(address, port, { tls: options.tls === true || port === 443 });
      const nodeIdHex = toHex(result.peerNodeId);
      return { nodeId: nodeIdHex, connected: true };
    } catch {
      return { nodeId: null, connected: false };
    }
  }

  private async _getOrConnect(destinationNodeId: string | Uint8Array): Promise<GMPLinkLike> {
    const destHex = toHex(destinationNodeId);

    if (!this._node) throw new Error('GMPNodeManager not started');

    let link = this._node.getLinkByNodeId(destHex);
    if (link && link.state === 'connected') {
      return link;
    }

    const prefix = destHex.slice(0, 64);
    link = this._node.virtualConnections.get(prefix);
    if (link && link.state === 'connected') {
      return link;
    }

    // Routes are no longer flooded: ask for one to this named
    // destination before concluding there is none.
    let route = this._node.routingTable.getBestRoute(destHex);
    if (!route && this._node.topologyManager) {
      await this._node.topologyManager.queryRoute(destHex);
      route = this._node?.routingTable.getBestRoute(destHex) ?? null;
    }
    if (!route) {
      const err = new Error('No route to destination');
      err.name = 'NoRouteError';
      throw err;
    }

    try {
      const result = await this._node.dialVirtual(Buffer.from(destHex, 'hex'));
      return result.link;
    } catch (e) {
      const err = new Error(`Failed to route message: ${(e as Error).message}`);
      err.name = 'NoRouteError';
      throw err;
    }
  }

  async sendMessage(destinationNodeId: string | Uint8Array, encryptedPayload: string): Promise<void> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    const link = await this._getOrConnect(destinationNodeId);
    await link.send(encryptedPayload);
  }

  async sendDirect(destinationNodeId: string | Uint8Array, encryptedPayload: string): Promise<void> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    const destHex = toHex(destinationNodeId);
    const link = this._node.getLinkByNodeId(destHex);
    if (!link || link.state !== 'connected') {
      const err = new Error('No direct connection to peer');
      err.name = 'NoPeerError';
      throw err;
    }
    await link.send(encryptedPayload);
  }

  getNodeId(): string {
    if (!this._node) throw new Error('GMPNodeManager not started');
    return this._node.identity.nodeIdHex;
  }

  getGhostAddress(): string {
    return ghostAddressFromNodeId(this.getNodeId());
  }

  resolveGhostAddress(address: string): { reason: string; nodeId?: string; candidates?: string[] } {
    const normalized = normalizeGhostAddress(address);
    if (!normalized) return { reason: 'invalid-address' };
    if (!this._node) return { reason: 'not-found' };
    const knownNodeIds: string[] = [];
    // Direct connections
    for (const link of this._node.connections.values()) {
      if (link.remoteNodeId) knownNodeIds.push(toHex(link.remoteNodeId));
    }
    // Virtual connections
    for (const link of this._node.virtualConnections.values()) {
      if (link.remoteNodeId) knownNodeIds.push(toHex(link.remoteNodeId));
    }
    // Routing table entries (topology-announced peers)
    if (this._node.routingTable) {
      const allRoutes = this._node.routingTable.getAllRoutes();
      if (Array.isArray(allRoutes)) {
        for (const route of allRoutes) {
          const dest = route.destinationNodeId;
          if (dest && !knownNodeIds.includes(dest)) knownNodeIds.push(dest);
        }
      }
    }
    // Peers beaconing on the local network. This makes them resolvable, not
    // connected — being on the same network is not consent to a session.
    if (this._node.lanDiscovery) {
      for (const id of this._node.lanDiscovery.getNodeIds()) {
        if (!knownNodeIds.includes(id)) knownNodeIds.push(id);
      }
    }
    const matches = findNodeIdsForAddress(knownNodeIds, normalized);
    if (matches.length === 0) return { reason: 'not-found' };
    if (matches.length > 1) return { reason: 'ambiguous', nodeId: matches[0], candidates: matches };
    return { reason: 'ok', nodeId: matches[0] };
  }

  /**
   * Resolve a Ghost Address to a NodeID, refusing to auto-pick when the 45-bit
   * address is ambiguous. Local knowledge AND the mesh are both consulted and
   * merged: a confident single local match can still be shadowed by a distinct
   * identity elsewhere that ground a colliding address, so the mesh is queried
   * even when local resolves. >1 distinct NodeID across local+mesh is ambiguous
   * and is logged unconditionally (NodeID prefixes only, never key material).
   */
  async lookupGhostAddress(address: string): Promise<{ reason: string; nodeId?: string; candidates?: string[] }> {
    const local = this.resolveGhostAddress(address);
    if (local.reason === 'invalid-address') return local;

    const candidates = new Set<string>();
    if (local.reason === 'ok' && local.nodeId) candidates.add(local.nodeId.toLowerCase());
    if (local.reason === 'ambiguous' && local.candidates) {
      for (const c of local.candidates) candidates.add(c.toLowerCase());
    }
    if (this._node && this._node.topologyManager) {
      try {
        for (const id of await this._node.topologyManager.queryGhostAll(address)) {
          candidates.add(id.toLowerCase());
        }
      } catch { /* mesh query failed; fall back to whatever local knew */ }
    }

    const list = [...candidates];
    if (list.length === 0) return { reason: 'not-found' };
    if (list.length === 1) return { reason: 'ok', nodeId: list[0] };

    // Family 5: a firing that records nothing is a firing that did not happen.
    logger.warn('gmp-node-manager', 'ghost-address-ambiguous',
      `More than one identity matches this Ghost Address; refusing to auto-pick`,
      { address: normalizeGhostAddress(address) ?? undefined, candidates: list.map((x) => x.slice(0, 16)), count: list.length });
    return { reason: 'ambiguous', nodeId: list[0], candidates: list };
  }

  /**
   * Decide whether a presented NodeID may be accepted for a contact pinned to
   * `pinnedNodeId` (null = no pin yet, trust-on-first-use). Runs here, in the
   * main process where the node and its KeyRotationManager live: the renderer
   * never makes this call, it only sends the presented NodeID and displays the
   * result. `rotationVerified` is taken from gmp-core's own verified rotations
   * (KeyRotationManager.isRotationVerified), never from a renderer-observed
   * event. A mismatch is logged (contact-key-mismatch) inside pinOnPresented.
   */
  pinDecision(pinnedNodeId: string | null, presentedNodeId: string): PinDecision {
    const krm = this._node
      ? (this._node as unknown as { keyRotationManager?: { isRotationVerified(a: string, b: string): boolean } }).keyRotationManager
      : null;
    const rotationVerified = !!(pinnedNodeId && krm && krm.isRotationVerified(pinnedNodeId, presentedNodeId));
    return pinOnPresented({ pinnedNodeId, presentedNodeId, rotationVerified });
  }

  async connectByGhostAddress(address: string): Promise<{ connected: boolean; transport: string }> {
    const result = await this.lookupGhostAddress(address);
    if (result.reason !== 'ok' || !result.nodeId) {
      return { connected: false, transport: 'failed' };
    }
    return this.connectByNodeId(result.nodeId);
  }

  async connectByNodeId(nodeId: string): Promise<{ connected: boolean; transport: string }> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    if (nodeId === this.getNodeId()) return { connected: false, transport: 'self' };
    // Check direct connections
    const existing = this._node.getLinkByNodeId(nodeId);
    if (existing && existing.state === 'connected') {
      return { connected: true, transport: existing.isVirtual ? 'virtual' : 'direct' };
    }
    // Check virtual connections (keyed by prefix of nodeId)
    const prefix = nodeId.slice(0, 64);
    const vLink = this._node.virtualConnections.get(prefix);
    if (vLink && vLink.state === 'connected') {
      return { connected: true, transport: 'virtual' };
    }
    // Seen on the LAN: dial it directly. A beacon is unauthenticated, so the
    // handshake decides — the link is kept only if the peer proves it holds
    // the NodeID we asked for. Anything else falls through to the mesh.
    const lanPeer = this._node.lanDiscovery ? this._node.lanDiscovery.getPeer(nodeId) : null;
    if (lanPeer) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const dialed = this._node.dial(lanPeer.address, lanPeer.port, { nodeId });
        const { link, peerNodeId } = await Promise.race([
          dialed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('LAN dial timed out')), LAN_DIAL_TIMEOUT_MS);
          })
        ]);
        if (toHex(peerNodeId) === nodeId.toLowerCase()) {
          return { connected: true, transport: 'lan' };
        }
        logger.warn('gmp-node-manager', 'lan-identity-mismatch',
          'LAN peer answered with a different NodeID than its beacon claimed; dropping the link',
          { expected: nodeId.slice(0, 16), address: lanPeer.address });
        link.destroy();
      } catch {
        // Unreachable or timed out: try the mesh instead.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    try {
      await this._node.dialVirtual(Buffer.from(nodeId, 'hex'));
      return { connected: true, transport: 'virtual' };
    } catch {
      return { connected: false, transport: 'failed' };
    }
  }

  getStatus(): {
    status: string;
    externalAddress: { address: string; port: number } | null;
    peers: Array<{ nodeId: string; address: string | null; port: number | null; isVirtual: boolean; transport: PeerTransport | 'virtual' }>;
    storage?: ReturnType<GMPNodeManager['storageStatus']>;
  } {
    if (!this._node) {
      return { status: 'offline', externalAddress: null, peers: [] };
    }

    const health = this._node.getHealthReport();

    const peers: Array<{ nodeId: string; address: string | null; port: number | null; isVirtual: boolean; transport: PeerTransport | 'virtual' }> = [];
    for (const link of this._node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        peers.push({
          nodeId: toHex(link.remoteNodeId),
          address: link.socket ? link.socket.remoteAddress : null,
          port: link.socket ? link.socket.remotePort : null,
          isVirtual: false,
          transport: transportOf(link)
        });
      }
    }
    for (const link of this._node.virtualConnections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        peers.push({
          nodeId: toHex(link.remoteNodeId),
          address: 'virtual',
          port: 0,
          isVirtual: true,
          transport: 'virtual'
        });
      }
    }

    return {
      ...(health ?? {}),
      // getHealthReport() is null without a health monitor.
      status: health?.status ?? 'healthy',
      externalAddress: this.externalAddress,
      peers,
      storage: this.storageStatus(),
    };
  }
}

