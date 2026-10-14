import { EventEmitter } from 'events';
import type { NoEvents } from './events.js';
import type {
  TopologyAnnouncePayload,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';
import { DEFAULTS } from './config-defaults.js';
import metrics from './metrics.js';
import { signMessage, verifySignature, sha512, bytesToHex, hexToBytes, stringToBytes } from './identity.js';
import logger from './logger.js';
import crypto from 'crypto';
import { PeerSampler, requesterKey } from './topology-sample.js';
import { SubnetTokenBucket } from './relay/token-bucket.js';
import { ghostAddressFromNodeId, normalizeGhostAddress } from './ghost-address.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

class LRUSet<T extends string = string> {
  private maxSize: number;
  private set: Set<T>;
  private list: T[];

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    this.set = new Set<T>();
    this.list = [];
  }

  has(key: T): boolean {
    return this.set.has(key);
  }

  add(key: T): void {
    if (this.set.has(key)) return;
    if (this.list.length >= this.maxSize) {
      const oldest = this.list.shift();
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
    this.set.add(key);
    this.list.push(key);
  }
}

interface AnnouncementEntry extends TopologyAnnouncePayload {
  announcerNodeId: string;
  connectedToNodeId: string;
  sequenceNumber: number;
  timestamp: number;
  withdrawn: boolean;
  ttl: number;
  // Origin authentication: announces are flooded, so the keys are carried,
  // bound to announcerNodeId by hash, and the fields are signed.
  announcerStaticPubKey?: string;
  announcerSigningPubKey?: string;
  signature?: string;
}

/**
 * The exact bytes covered by an announce signature: every semantically
 * meaningful field except ttl (which every hop decrements) and the signature
 * itself. Both signer and verifier must build this identically.
 */
function announceSigningBytes(a: AnnouncementEntry): Uint8Array {
  return stringToBytes(
    'ghost-mesh-topology-announce-v1' +
    a.announcerNodeId + '|' +
    a.connectedToNodeId + '|' +
    a.sequenceNumber + '|' +
    a.timestamp + '|' +
    (a.withdrawn ? '1' : '0')
  );
}

/** A route query for a named destination, carried in PEER_REQUEST. */
export interface RouteQuery {
  id: string;
  /** A NodeID (128 hex), or — for resolving what users share — a Ghost Address in `ghost`. */
  target?: string;
  ghost?: string;
  ttl: number;
}

/** What is being looked for: a named NodeID, or the NodeID behind a named Ghost Address. */
type Selector = { target: string } | { ghost: string };

function matches(sel: Selector, nodeHex: string): boolean {
  if ('target' in sel) return nodeHex === sel.target;
  try { return ghostAddressFromNodeId(nodeHex) === sel.ghost; } catch { return false; }
}

/** Its answer, carried in PEER_RESPONSE: signed edges from the answerer to the target, or null. */
export interface RouteAnswer {
  id: string;
  /** The NodeID the path ends at (the resolved one, for a Ghost Address query). */
  target: string;
  path: AnnouncementEntry[] | null;
}

const HEX_NODE_ID = /^[0-9a-f]{128}$/;
const MAX_QUERY_TTL = 8;
/** Neighbours a query is forwarded to at most, leaves excluded: bounds amplification. */
const MAX_QUERY_FANOUT = 8;
/** Per-link route-query budget: a link cannot turn the node into an amplifier. */
const QUERY_RATE_PER_MINUTE = 30;
const QUERY_BURST = 10;
const HOP_WAIT_MS = 800;

/**
 * Topology.
 *
 * - A node's own edges are signed once per validity window and cached.
 * - A peer is shown a fixed sample of at most `sampleSize` edges per
 *   (requester address key, epoch); see topology-sample.ts.
 * - Nothing is flooded. A withdrawal goes only to peers shown that edge.
 * - Routes to unsampled destinations are found on demand by querying a named
 *   NodeID, forwarded at most `routeQueryTtl` hops to at most
 *   MAX_QUERY_FANOUT neighbours, rate limited per link and deduplicated.
 *
 * Announces are sent with ttl 1 for compatibility with older flooding nodes.
 */
export class TopologyManager extends EventEmitter<NoEvents> {
  private node: GMPNodeLike;
  private sequenceNumber: number;
  private seenSequenceNumbers: LRUSet;
  private lsdb: Map<string, Map<string, AnnouncementEntry>>;
  private announceInterval: ReturnType<typeof setInterval> | null;
  private readonly ttl: number;
  readonly announceIntervalMs: number;
  readonly validityMs: number;
  readonly sampleSize: number;
  readonly sampleEpochMs: number;
  readonly routeQueryTtl: number;
  /** Own edges, signed, by neighbour. Re-signed when half the validity window has passed. */
  private ownEdges = new Map<string, AnnouncementEntry>();
  /** Which of our edges (and sequence numbers) each neighbour has been shown. */
  private sentTo = new Map<string, Map<string, number>>();
  /** Bumped on every link change: invalidates the neighbour list and sample caches. */
  private linkVersion = 0;
  private directHexCache: { version: number; hexes: string[] } | null = null;
  private sampleCache = new Map<string, string[]>();
  private sampleCacheTag = '';
  private sampler: PeerSampler | null = null;
  private seenQueries = new LRUSet(4096);
  private pendingAnswers = new Map<string, (a: RouteAnswer) => void>();
  private queryTokens = new SubnetTokenBucket(() => ({ ratePerMinute: QUERY_RATE_PER_MINUTE, burst: QUERY_BURST }), () => Date.now());
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** Diagnostics and tests. */
  readonly stats = { signatures: 0, announcesSent: 0, queriesAnswered: 0, queriesForwarded: 0 };

  constructor(node: GMPNodeLike, options: {
    announceIntervalMs?: number; sequenceNumLruSize?: number; topologyTtl?: number;
    validityMs?: number; sampleSize?: number; sampleEpochMs?: number; routeQueryTtl?: number;
  } = {}) {
    super();
    this.node = node;
    this.sequenceNumber = 0;

    this.ttl = options.topologyTtl || DEFAULTS.GMP_TOPOLOGY_TTL;
    const lruSize = options.sequenceNumLruSize || DEFAULTS.GMP_SEQUENCE_NUM_LRU_SIZE;
    this.seenSequenceNumbers = new LRUSet(lruSize);
    this.validityMs = options.validityMs || DEFAULTS.GMP_TOPOLOGY_ANNOUNCE_VALIDITY_MS;
    this.sampleSize = options.sampleSize ?? DEFAULTS.GMP_TOPOLOGY_SAMPLE_SIZE;
    this.sampleEpochMs = options.sampleEpochMs || DEFAULTS.GMP_TOPOLOGY_SAMPLE_EPOCH_MS;
    this.routeQueryTtl = Math.min(MAX_QUERY_TTL, options.routeQueryTtl || DEFAULTS.GMP_ROUTE_QUERY_TTL);

    this.lsdb = new Map();

    const announceIntervalMs = options.announceIntervalMs || DEFAULTS.GMP_REANNOUNCE_INTERVAL_MS;
    this.announceIntervalMs = announceIntervalMs;
    this.announceInterval = setInterval(() => {
      this.announceAllDirectLinks();
    }, announceIntervalMs);

    if (this.announceInterval && this.announceInterval.unref) {
      this.announceInterval.unref();
    }
  }

  // ── Own edges: signed once, cached ─────────────────

  private _signEdge(peerHex: string, withdrawn: boolean): AnnouncementEntry {
    this.sequenceNumber++;
    this.stats.signatures++;
    return this.signOwnAnnounce({
      announcerNodeId: this.node.identity!.nodeIdHex,
      connectedToNodeId: peerHex,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      withdrawn,
      ttl: 1,
    });
  }

  /** Our signed edge to `peerHex`, from the cache while it is fresh. */
  private _ownEdge(peerHex: string): AnnouncementEntry {
    const cached = this.ownEdges.get(peerHex);
    if (cached && Date.now() - cached.timestamp < this.validityMs / 2) return cached;
    const signed = this._signEdge(peerHex, false);
    this.ownEdges.set(peerHex, signed);
    return signed;
  }

  private _directLinks(): GMPLinkLike[] {
    const out: GMPLinkLike[] = [];
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) out.push(link);
    }
    return out;
  }

  private _sampler(): PeerSampler | null {
    if (!this.sampler && this.node.identity && this.node.identity.signingPrivKey) {
      this.sampler = new PeerSampler(PeerSampler.secretFrom(this.node.identity.signingPrivKey), () => this.sampleEpochMs);
    }
    return this.sampler;
  }

  private _directHexes(): string[] {
    if (!this.directHexCache || this.directHexCache.version !== this.linkVersion) {
      this.directHexCache = { version: this.linkVersion, hexes: this._directLinks().map((l) => toHex(l.remoteNodeId)) };
    }
    return this.directHexCache.hexes;
  }

  /**
   * The keyed sample of neighbours whose edges `link` may see, cached per
   * (address key, link set, epoch).
   */
  sampleFor(link: GMPLinkLike): string[] {
    const sampler = this._sampler();
    if (!sampler) return [];
    const tag = `${this.linkVersion}|${sampler.epoch()}`;
    if (tag !== this.sampleCacheTag) { this.sampleCache.clear(); this.sampleCacheTag = tag; }
    const key = requesterKey(link);
    let ranked = this.sampleCache.get(key);
    if (!ranked) {
      // One extra, so the requester itself can be dropped from its own sample.
      ranked = sampler.pick(key, this._directHexes(), (h) => h, this.sampleSize + 1);
      this.sampleCache.set(key, ranked);
    }
    const requester = link.remoteNodeId ? toHex(link.remoteNodeId) : null;
    return ranked.filter((h) => h !== requester).slice(0, this.sampleSize);
  }

  /** The same keyed sample, over any candidate list (peer exchange uses it). */
  pickSample<T>(link: GMPLinkLike, candidates: T[], idOf: (t: T) => string, size: number): T[] {
    const sampler = this._sampler();
    return sampler ? sampler.pick(requesterKey(link), candidates, idOf, size) : [];
  }

  /** Send `link` whatever of its sample it has not been shown at the current signed version. */
  private _sendSample(link: GMPLinkLike): void {
    const peerHex = link.remoteNodeId ? toHex(link.remoteNodeId) : null;
    if (!peerHex) return;
    const sent = this.sentTo.get(peerHex) ?? new Map<string, number>();
    for (const edgePeer of this.sampleFor(link)) {
      const edge = this._ownEdge(edgePeer);
      if (sent.get(edgePeer) === edge.sequenceNumber) continue; // already has this one
      try {
        link.sendTopologyAnnounce(edge);
        this.stats.announcesSent++;
        sent.set(edgePeer, edge.sequenceNumber);
      } catch {
        // socket closing
      }
    }
    this.sentTo.set(peerHex, sent);
  }

  private _scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildRoutingTable();
    }, 20);
    if (this.rebuildTimer.unref) this.rebuildTimer.unref();
  }

  // ── Link lifecycle ─────────────────────────────────

  handleLinkEstablished(peerNodeIdHex: string): void {
    this.linkVersion++;
    const peerHex = toHex(peerNodeIdHex);
    const link = this.node.getLinkByNodeId(peerHex);
    if (link && link.state === 'connected' && !link.isVirtual) this._sendSample(link);
    this.rebuildRoutingTable();
  }

  handleLinkClosed(peerNodeIdHex: string): void {
    this.linkVersion++;
    const peerHex = toHex(peerNodeIdHex);
    this.ownEdges.delete(peerHex);
    this.sentTo.delete(peerHex);
    // Withdraw only where the edge was shown: signed once, sent to those peers.
    let withdrawal: AnnouncementEntry | null = null;
    for (const link of this._directLinks()) {
      const other = toHex(link.remoteNodeId);
      const sent = this.sentTo.get(other);
      if (!sent || !sent.has(peerHex)) continue;
      withdrawal = withdrawal ?? (this.node.identity ? this._signEdge(peerHex, true) : null);
      if (!withdrawal) break;
      try { link.sendTopologyAnnounce(withdrawal); this.stats.announcesSent++; } catch { /* closing */ }
      sent.delete(peerHex);
    }
    this.rebuildRoutingTable();
  }

  /**
   * Each interval, send every neighbour only what is new in its sample: edges
   * that entered it or were re-signed at half validity.
   */
  announceAllDirectLinks(): void {
    if (!this.node.identity) return;
    for (const link of this._directLinks()) this._sendSample(link);
    this.rebuildRoutingTable();
  }

  /** Attach our identity keys and signature to an announce we originate. */
  private signOwnAnnounce(announce: AnnouncementEntry): AnnouncementEntry {
    const id = this.node.identity;
    if (!id || !id.signingPrivKey || !id.signingPubKey || !id.staticPubKey) {
      // Without keys we cannot sign; leave it unsigned and let verifiers drop
      // it rather than silently flooding a forgeable announce.
      return announce;
    }
    const withKeys: AnnouncementEntry = {
      ...announce,
      announcerStaticPubKey: bytesToHex(id.staticPubKey),
      announcerSigningPubKey: bytesToHex(id.signingPubKey),
    };
    const sig = signMessage(id.signingPrivKey, announceSigningBytes(withKeys));
    withKeys.signature = bytesToHex(sig);
    return withKeys;
  }

  /**
   * Whether an announce came from the node it names: carried keys hash to
   * announcerNodeId and the Ed25519 signature verifies.
   */
  private isAnnounceAuthentic(a: AnnouncementEntry): boolean {
    if (!a.announcerStaticPubKey || !a.announcerSigningPubKey || !a.signature) {
      return false;
    }
    try {
      const staticPub = hexToBytes(a.announcerStaticPubKey);
      const signingPub = hexToBytes(a.announcerSigningPubKey);
      const nodeIdHex = String(a.announcerNodeId).toLowerCase();
      // Bind the keys to the claimed NodeID. Accept either hash, matching the
      // handshake's support for static- and signing-key-derived NodeIDs.
      const staticHashHex = bytesToHex(sha512(staticPub)).toLowerCase();
      const signingHashHex = bytesToHex(sha512(signingPub)).toLowerCase();
      if (nodeIdHex !== staticHashHex && nodeIdHex !== signingHashHex) {
        return false;
      }
      // The hash binds only the static key. For a direct neighbour, also
      // require the signing key from its authenticated handshake.
      const neighbour = this.node.getLinkByNodeId(nodeIdHex);
      if (neighbour && neighbour.remoteSigningPubkey &&
          bytesToHex(neighbour.remoteSigningPubkey).toLowerCase() !== a.announcerSigningPubKey.toLowerCase()) {
        return false;
      }
      return verifySignature(signingPub, announceSigningBytes(a), hexToBytes(a.signature));
    } catch {
      return false;
    }
  }

  private _fresh(a: AnnouncementEntry): boolean {
    return Number.isFinite(a.timestamp) && Math.abs(Date.now() - a.timestamp) <= this.validityMs;
  }

  handleReceivedAnnounce(announce: AnnouncementEntry, incomingLink: GMPLinkLike | null): void {
    metrics.increment('routing.announcements');

    if (announce.ttl <= 0) return;

    // Origin authentication before anything else. The session key on the link
    // this arrived over only authenticates the relaying hop; its claimed
    // announcer must prove itself.
    if (!this.isAnnounceAuthentic(announce)) {
      metrics.increment('routing.announcementsRejected');
      logger.warn('topology', 'unsigned-or-forged-announce',
        `Rejected topology announce for ${String(announce.announcerNodeId).slice(0, 16)}: missing or invalid signature`);
      if (incomingLink && typeof (incomingLink as { _penalizeUntrusted?: (r: string) => void })._penalizeUntrusted === 'function') {
        (incomingLink as { _penalizeUntrusted: (r: string) => void })._penalizeUntrusted('Forged topology announce');
      }
      return;
    }
    // A cached edge is re-sent for half a validity window; one older than the
    // window is stale, and replaying it must not resurrect a dead link.
    if (!this._fresh(announce)) return;

    this.seenSequenceNumbers.add(`${announce.announcerNodeId}:${announce.sequenceNumber}`);
    // Stored, never passed on. A repeat of what we hold still
    // refreshes the routes it supports.
    if (!this.updateLSDB({ ...announce, ttl: 0 })) this._scheduleRebuild();
  }

  // ── On-demand routes for a named destination ───────────────────

  /** Find a route to `targetHex` if none exists; resolves true if one does afterwards. */
  async queryRoute(targetHex: string, timeoutMs = 3000): Promise<boolean> {
    const target = toHex(targetHex).toLowerCase();
    if (this.node.routingTable.getBestRoute(target)) return true;
    if (!HEX_NODE_ID.test(target)) return false;
    return (await this._query({ target }, timeoutMs)) !== null;
  }

  /**
   * Resolve a Ghost Address to a NodeID on demand. Queries only confirm an
   * address the asker already has; guessing is bounded by the per-link budget.
   */
  async queryGhost(address: string, timeoutMs = 3000): Promise<string | null> {
    const ghost = normalizeGhostAddress(address);
    if (!ghost) return null;
    return this._query({ ghost }, timeoutMs);
  }

  /**
   * Resolve a Ghost Address to EVERY distinct authentic NodeID that matches it,
   * within the query's normal lifetime. A Ghost Address is only 45 bits, so more
   * than one identity can map to it (including a ground-to-collide impostor);
   * first-wins (queryGhost) would silently pick one. The caller treats >1 as
   * ambiguous and never auto-picks. Returns [] if none resolve.
   */
  async queryGhostAll(address: string, timeoutMs = 3000): Promise<string[]> {
    const ghost = normalizeGhostAddress(address);
    if (!this.node.identity || !ghost) return [];
    const id = crypto.randomBytes(16).toString('hex');
    this.seenQueries.add(id);
    const paths = await this._askAll({ ghost }, this.routeQueryTtl, id, null, timeoutMs);
    for (const path of paths) for (const edge of path) this.updateLSDB({ ...edge, ttl: 0 });
    this.rebuildRoutingTable();
    const ends = new Set<string>();
    for (const path of paths) {
      const end = toHex(path[path.length - 1].connectedToNodeId);
      if (this.node.routingTable.getBestRoute(end)) ends.add(end);
    }
    return [...ends];
  }

  private async _query(sel: Selector, timeoutMs: number): Promise<string | null> {
    if (!this.node.identity) return null;
    const id = crypto.randomBytes(16).toString('hex');
    this.seenQueries.add(id);
    const found = await this._ask(sel, this.routeQueryTtl, id, null, timeoutMs);
    if (!found) return null;
    for (const edge of found.path) this.updateLSDB({ ...edge, ttl: 0 });
    this.rebuildRoutingTable();
    const end = toHex(found.path[found.path.length - 1].connectedToNodeId);
    return this.node.routingTable.getBestRoute(end) ? end : null;
  }

  /**
   * Up to MAX_QUERY_FANOUT neighbours to ask, excluding the asker; neighbours
   * with other links first.
   */
  private _queryTargets(exclude: string | null): GMPLinkLike[] {
    const self = this.node.identity ? this.node.identity.nodeIdHex : '';
    const direct = this._directLinks().filter((l) => toHex(l.remoteNodeId) !== exclude);
    const known = (l: GMPLinkLike): boolean => {
      const edges = this.lsdb.get(toHex(l.remoteNodeId));
      return !!edges && [...edges.keys()].some((k) => k !== self);
    };
    return [...direct.filter(known), ...direct.filter((l) => !known(l))].slice(0, MAX_QUERY_FANOUT);
  }

  private _ask(sel: Selector, ttl: number, id: string, exclude: string | null, timeoutMs: number): Promise<{ via: string; path: AnnouncementEntry[] } | null> {
    const asked = this._queryTargets(exclude);
    if (asked.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let outstanding = asked.length;
      let done = false;
      const finish = (v: { via: string; path: AnnouncementEntry[] } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const l of asked) this.pendingAnswers.delete(`${id}|${toHex(l.remoteNodeId)}`);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (timer.unref) timer.unref();
      for (const link of asked) {
        const via = toHex(link.remoteNodeId);
        this.pendingAnswers.set(`${id}|${via}`, (a) => {
          const path = a.path && this._validPath(via, sel, a.path) ? a.path : null;
          if (path) finish({ via, path });
          else if (--outstanding === 0) finish(null);
        });
        try {
          link.sendRouteQuery({ id, ttl, ...sel });
        } catch {
          if (--outstanding === 0) finish(null);
        }
      }
    });
  }

  /**
   * Like _ask, but collects EVERY authentic matching path rather than resolving
   * on the first. Waits until all asked neighbours answer or the lifetime
   * (timeoutMs) elapses — the same budget as _ask, no new timeout. Used only for
   * Ghost Address resolution, where a 45-bit collision means several distinct
   * identities can legitimately answer.
   */
  private _askAll(sel: Selector, ttl: number, id: string, exclude: string | null, timeoutMs: number): Promise<AnnouncementEntry[][]> {
    const asked = this._queryTargets(exclude);
    if (asked.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      let outstanding = asked.length;
      let done = false;
      const paths: AnnouncementEntry[][] = [];
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const l of asked) this.pendingAnswers.delete(`${id}|${toHex(l.remoteNodeId)}`);
        resolve(paths);
      };
      const timer = setTimeout(finish, timeoutMs);
      if (timer.unref) timer.unref();
      for (const link of asked) {
        const via = toHex(link.remoteNodeId);
        this.pendingAnswers.set(`${id}|${via}`, (a) => {
          if (a.path && this._validPath(via, sel, a.path)) paths.push(a.path);
          if (--outstanding === 0) finish();
        });
        try {
          link.sendRouteQuery({ id, ttl, ...sel });
        } catch {
          if (--outstanding === 0) finish();
        }
      }
    });
  }

  /** Every edge authentic and fresh, chained from `via` to a node matching `sel`. */
  private _validPath(via: string, sel: Selector, path: AnnouncementEntry[]): boolean {
    if (!Array.isArray(path) || path.length === 0 || path.length > MAX_QUERY_TTL) return false;
    let from = via;
    for (const edge of path) {
      if (!edge || edge.withdrawn || toHex(edge.announcerNodeId) !== from) return false;
      if (!this.isAnnounceAuthentic(edge) || !this._fresh(edge)) return false;
      from = toHex(edge.connectedToNodeId);
    }
    return matches(sel, from);
  }

  handleRouteQuery(link: GMPLinkLike, rq: RouteQuery): void {
    const peerHex = link.remoteNodeId ? toHex(link.remoteNodeId) : null;
    if (!peerHex || !rq || typeof rq.id !== 'string' || rq.id.length > 64) return;
    const ttl = Number(rq.ttl);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_QUERY_TTL) return;
    let sel: Selector;
    if (typeof rq.target === 'string' && HEX_NODE_ID.test(rq.target.toLowerCase())) {
      sel = { target: rq.target.toLowerCase() };
    } else {
      const ghost = typeof rq.ghost === 'string' ? normalizeGhostAddress(rq.ghost) : null;
      if (!ghost) return;
      sel = { ghost };
    }
    if (!this.queryTokens.take(peerHex)) return; // over budget: silence
    const reply = (path: AnnouncementEntry[] | null): void => {
      const target = path ? toHex(path[path.length - 1].connectedToNodeId) : ('target' in sel ? sel.target : '');
      try { link.sendRouteAnswer({ id: rq.id, target, path }); } catch { /* closing */ }
      // Our own edge in the answer counts as shown: if it goes away, this
      // peer gets the withdrawal (otherwise it keeps a dead route until the
      // edge expires).
      if (path && path[0]) {
        const shown = this.sentTo.get(peerHex) ?? new Map<string, number>();
        shown.set(toHex(path[0].connectedToNodeId), path[0].sequenceNumber);
        this.sentTo.set(peerHex, shown);
      }
    };
    if (this.seenQueries.has(rq.id)) return reply(null); // a loop, or a replay
    this.seenQueries.add(rq.id);
    this.stats.queriesAnswered++;

    // Directly connected to it? Answer with our cached edge. A Ghost Address
    // must match exactly one neighbour; ambiguity answers nothing.
    const direct = this._directLinks().map((l) => toHex(l.remoteNodeId)).filter((h) => h !== peerHex && matches(sel, h));
    if (direct.length === 1) return reply([this._ownEdge(direct[0])]);
    if (direct.length > 1 || ttl <= 1 || !this.node.identity) return reply(null);

    this.stats.queriesForwarded++;
    void this._ask(sel, ttl - 1, rq.id, peerHex, HOP_WAIT_MS * (ttl - 1)).then((found) => {
      if (!found) return reply(null);
      for (const edge of found.path) this.updateLSDB({ ...edge, ttl: 0 });
      reply([this._ownEdge(found.via), ...found.path]);
    });
  }

  handleRouteAnswer(link: GMPLinkLike, ra: RouteAnswer): void {
    const peerHex = link.remoteNodeId ? toHex(link.remoteNodeId) : null;
    if (!peerHex || !ra || typeof ra.id !== 'string') return;
    const pending = this.pendingAnswers.get(`${ra.id}|${peerHex}`);
    if (pending) pending(ra);
  }

  /** Store an announce. Returns whether the database changed. */
  updateLSDB(announce: AnnouncementEntry): boolean {
    const announcerHex = toHex(announce.announcerNodeId);
    const connectedHex = toHex(announce.connectedToNodeId);

    if (!this.lsdb.has(announcerHex)) {
      this.lsdb.set(announcerHex, new Map());
    }
    const announcerMap = this.lsdb.get(announcerHex)!;
    const existing = announcerMap.get(connectedHex);

    if (existing) {
      if (announce.sequenceNumber < existing.sequenceNumber) return false;
      if (announce.sequenceNumber === existing.sequenceNumber && announce.timestamp <= existing.timestamp) return false;
    }

    announcerMap.set(connectedHex, announce);

    this.rebuildRoutingTable();
    return true;
  }

  rebuildRoutingTable(): void {
    if (!this.node.identity || !this.node.identity.nodeIdHex) return;
    const ourNodeIdHex = this.node.identity.nodeIdHex;

    interface QueueEntry {
      nodeIdHex: string;
      nextHopHex: string;
      hopCount: number;
    }

    const queue: QueueEntry[] = [];
    const visited = new Set<string>([ourNodeIdHex]);
    const newRoutes = new Map<string, { nextHopHex: string; hopCount: number }>();

    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        visited.add(peerHex);
        newRoutes.set(peerHex, { nextHopHex: peerHex, hopCount: 1 });
        queue.push({ nodeIdHex: peerHex, nextHopHex: peerHex, hopCount: 1 });
      }
    }

    while (queue.length > 0) {
      const { nodeIdHex, nextHopHex, hopCount } = queue.shift()!;
      const neighbors = this.lsdb.get(nodeIdHex);
      if (neighbors) {
        for (const [nbrHex, edge] of neighbors.entries()) {
          if (edge.withdrawn || !this._fresh(edge)) continue;
          if (!visited.has(nbrHex)) {
            visited.add(nbrHex);
            newRoutes.set(nbrHex, { nextHopHex, hopCount: hopCount + 1 });
            queue.push({ nodeIdHex: nbrHex, nextHopHex, hopCount: hopCount + 1 });
          }
        }
      }
    }

    const activeRoutes = this.node.routingTable.getAllRoutes();
    for (const route of activeRoutes) {
      const dest = route.destinationNodeId;
      const nextHop = route.nextHopNodeId;
      const newRoute = newRoutes.get(dest);
      if (!newRoute || newRoute.nextHopHex !== nextHop) {
        this.node.routingTable.removeRoute(dest, nextHop);
      }
    }
    for (const [dest, newRoute] of newRoutes.entries()) {
      this.node.routingTable.addRoute(dest, newRoute.nextHopHex, newRoute.hopCount);
    }
  }

  close(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}