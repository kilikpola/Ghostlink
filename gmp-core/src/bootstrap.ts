import { EventEmitter } from 'events';
import type { BootstrapEvents } from './events.js';
import { loadPublicPeers } from './public-peer-list.js';
import { PUBLIC_PEERS_FILE } from './paths.js';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import { writeFileAtomicSync } from './atomic-file.js';
import fs from 'fs';
import metrics from './metrics.js';
import type { PublicPeerEntry,
  CachedPeer,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';

/** The minimum a bootstrap dial needs; both CachedPeer and PublicPeerEntry satisfy it. */
/** A peer-cache entry, or a public-peer entry (which also carries tls, roles, operator). */
type DialableCandidate = Pick<CachedPeer, 'nodeId' | 'address' | 'port'> & Partial<Pick<PublicPeerEntry, 'tls' | 'roles' | 'operator'>>;

export class BootstrapManager extends EventEmitter<BootstrapEvents> {
  private node: GMPNodeLike;
  /** Read by GMPNode.bootstrapStatus and the health monitor. */
  minPeers: number;
  private parallelCount: number;
  /** Whether bootstrapping is off (tests, public peers); exposed for metrics. */
  private _disableBootstrap: boolean;
  publicPeersPath: string | null;
  /** Rung budgets (ms): stage1 = cache, stage2 = public; see start(). */
  stage1TimeoutMs: number;
  stage2TimeoutMs: number;
  lanTimeoutMs: number;
  peerExchangeTimeoutMs: number;
  /** No single ladder dial lasts longer than this. */
  dialTimeoutMs: number;
  /** Minimum gap between two dial starts within a rung. */
  dialStaggerMs: number;
  /** Rung 2 may dial LAN peers this node has never met (off by default). */
  lanAny: boolean;
  /** Reachability of public peers: demotion with backoff, never removal. */
  readonly publicPeerHealth: PublicPeerHealth;
  /** How the last run ended: winning rung (or 'manual'), elapsed ms, dials cancelled. */
  lastRun: { rung: LadderRung | 'connected' | 'manual' | null; ms: number; cancelled: number; attempts: number } | null = null;
  private _run: LadderRun | null = null;
  private rebootstrapBackoffInitialMs: number;
  /** Moved only by the bootstrap flow; exposed for metrics. */
  private _stage: BootstrapStage;
  private isBootstrapping: boolean;
  private failureCount: number;
  private dialingNodeIds: Set<string>;
  private failedAttempts: Set<string>;
  private rebootstrapTimer: NodeJS.Timeout | null;
  private closeListener: () => void;
  private attemptLog: DialAttempt[];
  private publicPeersSeen: number;

  constructor(node: GMPNodeLike, options: {
    minPeers?: number;
    parallelCount?: number;
    disableBootstrap?: boolean;
    publicPeersPath?: string | null;
    stage1TimeoutMs?: number;
    stage2TimeoutMs?: number;
    lanTimeoutMs?: number;
    peerExchangeTimeoutMs?: number;
    dialTimeoutMs?: number;
    dialStaggerMs?: number;
    lanAny?: boolean;
    /** Where public-peer health persists; absent: memory only. */
    healthFile?: string | null;
    rebootstrapBackoffInitialMs?: number;
  } = {}) {
    super();
    this.node = node;

    this.minPeers = options.minPeers ?? DEFAULTS.GMP_MIN_PEERS;
    this.parallelCount = options.parallelCount ?? 5;
    this._disableBootstrap = options.disableBootstrap ?? false;
    this.publicPeersPath = options.publicPeersPath ?? null;
    this.stage1TimeoutMs = options.stage1TimeoutMs ?? DEFAULTS.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS;
    this.stage2TimeoutMs = options.stage2TimeoutMs ?? DEFAULTS.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS;
    this.lanTimeoutMs = options.lanTimeoutMs ?? DEFAULTS.GMP_BOOTSTRAP_LAN_TIMEOUT_MS;
    this.peerExchangeTimeoutMs = options.peerExchangeTimeoutMs ?? DEFAULTS.GMP_BOOTSTRAP_PX_TIMEOUT_MS;
    this.dialTimeoutMs = options.dialTimeoutMs ?? DEFAULTS.GMP_BOOTSTRAP_DIAL_TIMEOUT_MS;
    this.dialStaggerMs = options.dialStaggerMs ?? DEFAULTS.GMP_BOOTSTRAP_DIAL_STAGGER_MS;
    this.lanAny = options.lanAny ?? DEFAULTS.GMP_LAN_BOOTSTRAP_ANY;
    this.publicPeerHealth = new PublicPeerHealth(options.healthFile ?? null);
    this.rebootstrapBackoffInitialMs = options.rebootstrapBackoffInitialMs ?? DEFAULTS.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS;

    this._stage = 'failed';
    this.isBootstrapping = false;
    this.failureCount = 0;

    this.dialingNodeIds = new Set();
    this.failedAttempts = new Set();
    this.rebootstrapTimer = null;
    this.attemptLog = [];
    this.publicPeersSeen = 0;

    this.closeListener = () => {
      this.checkAndTriggerRebootstrap();
    };
    this.node.on('close', this.closeListener);
  }

  /** Read-only view of the bootstrap stage, for metrics reporting. */
  get stage(): BootstrapStage {
    return this._stage;
  }

  /** Whether bootstrapping is off. Writable so it can be enabled after start. */
  get disableBootstrap(): boolean {
    return this._disableBootstrap;
  }

  set disableBootstrap(value: boolean) {
    this._disableBootstrap = value;
  }

  getDirectConnectionCount(): number {
    return Array.from(this.node.connections.values())
      .filter((link: GMPLinkLike) => link.state === 'connected' && !link.isVirtual).length;
  }

  /**
   * The bootstrap ladder. First success wins and cancels other dials:
   *
   *   1 cache          peer-cache entries, most recent first     stage1TimeoutMs (1.5 s)
   *   2 lan            known LAN-visible peers                    lanTimeoutMs (1 s)
   *                    (any LAN peer with GMP_LAN_BOOTSTRAP_ANY)
   *   3 public         public-peers.json hosts, shuffled, 3 in    stage2TimeoutMs (4 s)
   *                    flight, demoted hosts skipped unless all are
   *   4 peer-exchange  peers learned in earlier sessions          peerExchangeTimeoutMs (1 s)
   *   5 manual         bootstrap-failed; the app offers QR / paste
   *
   * Each dial is capped at dialTimeoutMs (2.5 s), staggered dialStaggerMs
   * (500 ms). Empty rungs are skipped. Worst case to rung 5: 7.5 s.
   */
  async start(): Promise<void> {
    if (this._disableBootstrap || this.isBootstrapping) return;

    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }

    this.isBootstrapping = true;
    this.dialingNodeIds.clear();
    this.failedAttempts.clear();
    this.attemptLog = [];
    this.publicPeersSeen = 0;

    metrics.increment('bootstrap.attempts');
    metrics.set('bootstrap.lastAttemptAt', Date.now());

    const run: LadderRun = { won: false, rung: null, cancelled: 0, t0: Date.now(), controllers: new Set() };
    this._run = run;
    const lan = this.node.lanDiscovery ?? null;

    const rungs: Array<{ rung: LadderRung; stage: BootstrapStage; budget: number; concurrency: number; candidates: () => DialableCandidate[]; watchLan?: boolean }> = [
      { rung: 'cache', stage: 'stage1', budget: this.stage1TimeoutMs, concurrency: this.parallelCount, candidates: () => this._cacheCandidates() },
      { rung: 'lan', stage: 'lan', budget: lan ? this.lanTimeoutMs : 0, concurrency: this.parallelCount, candidates: () => this._lanCandidates(), watchLan: !!lan },
      { rung: 'public', stage: 'stage2', budget: this.stage2TimeoutMs, concurrency: 3, candidates: () => this._publicCandidates() },
      { rung: 'peer-exchange', stage: 'peer-exchange', budget: this.peerExchangeTimeoutMs, concurrency: this.parallelCount, candidates: () => this._exchangeCandidates() },
    ];

    // Already connected to enough peers: nothing to bootstrap (as before the
    // ladder). At minPeers 0 (unattended hosts) that is always true, so the
    // ladder still runs once to link to the other listed hosts.
    if (this.minPeers > 0 && this.getDirectConnectionCount() >= this.minPeers) {
      run.won = true;
      run.rung = 'connected';
    }

    for (const r of rungs) {
      if (run.won) break;
      this._stage = r.stage;
      const candidates = r.candidates();
      logger.info('bootstrap', 'rung-start', `Bootstrap rung ${r.rung}: ${candidates.length} candidate(s)`, { rung: r.rung, candidates: candidates.length });
      await this._runRung(run, r.rung, candidates, r.budget, r.concurrency, r.watchLan ? lan : null);
      if (run.won) break;
    }
    this._run = null;

    if (run.won) {
      this._stage = 'sufficient';
      this.isBootstrapping = false;
      this.failureCount = 0;
      const count = this.getDirectConnectionCount();
      this.lastRun = { rung: run.rung, ms: Date.now() - run.t0, cancelled: run.cancelled, attempts: this.attemptLog.length };
      logger.info('bootstrap', 'complete', `Bootstrap reached the mesh via ${run.rung} in ${this.lastRun.ms} ms`, { ...this.lastRun, peersConnected: count });
      this.emit('bootstrap-complete', count);
      this.node.emit('bootstrap-complete', count);
      return;
    }

    if (this.minPeers === 0) {
      // Nothing required, so nothing failed: an unattended host serves on its
      // own. One INFO line, no WARN, no retry.
      this._stage = 'sufficient';
      this.isBootstrapping = false;
      this.failureCount = 0;
      const count = this.getDirectConnectionCount();
      this.lastRun = { rung: null, ms: Date.now() - run.t0, cancelled: run.cancelled, attempts: this.attemptLog.length };
      logger.info('bootstrap', 'serving-alone', `Bootstrap reached no other host in ${this.lastRun.ms} ms; this role requires none (minPeers 0), serving on its own`, { peersConnected: count, attempts: this.attemptLog.length });
      this.emit('bootstrap-complete', count);
      this.node.emit('bootstrap-complete', count);
      return;
    }

    this._stage = 'failed';
    this.isBootstrapping = false;
    const count = this.getDirectConnectionCount();
    this.lastRun = { rung: 'manual', ms: Date.now() - run.t0, cancelled: run.cancelled, attempts: this.attemptLog.length };

    const diagnosis = this.diagnose();
    logger.warn('bootstrap', 'failed', `Bootstrap reached no peer in ${this.lastRun.ms} ms (connected: ${count}) — ${diagnosis.reason}; manual entry (QR / paste) is the remaining way in`, {
      peersConnected: count,
      reason: diagnosis.reason,
      publicPeersConfigured: diagnosis.publicPeersConfigured,
      peersFile: diagnosis.peersFile
    });
    this.emit('bootstrap-failed', count, diagnosis);
    this.node.emit('bootstrap-failed', count, diagnosis);

    if (count < this.minPeers / 2) {
      const backoffInitial = this.rebootstrapBackoffInitialMs;
      const backoffs = [backoffInitial, backoffInitial * 2, backoffInitial * 4, backoffInitial * 10];
      const delay = backoffs[Math.min(this.failureCount, backoffs.length - 1)];
      this.failureCount++;

      logger.info('bootstrap', 'retry-scheduled', `Scheduling bootstrap retry in ${delay}ms`, { delay, failureCount: this.failureCount });

      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);

      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  // ── ladder rungs ─────────────────────────────────

  private _linked(nodeId: string): boolean {
    return !!this.node.getLinkByNodeId(nodeId) || (!!this.node.identity && nodeId === this.node.identity.nodeIdHex);
  }

  /** Rung 1: last known good first. */
  private _cacheCandidates(): DialableCandidate[] {
    const all = this.node.peerCache.getCandidates() || [];
    return [...all].filter((c) => !this._linked(c.nodeId)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  /**
   * Rung 2: LAN-visible peers. By default only NodeIDs already in the peer
   * cache are dialled, at the address the LAN reports.
   */
  private _lanCandidates(): DialableCandidate[] {
    const lan = this.node.lanDiscovery;
    if (!lan) return [];
    return lan.getNodeIds().map((id) => lan.getPeer(id)).filter((p): p is NonNullable<typeof p> => !!p)
      .filter((p) => this._lanEligible(p.nodeId))
      .map((p) => ({ nodeId: p.nodeId, address: p.address, port: p.port }));
  }

  private _lanEligible(nodeId: string): boolean {
    if (this._linked(nodeId)) return false;
    return this.lanAny || (this.node.peerCache.getCandidates() || []).some((c) => c.nodeId === nodeId);
  }

  /** Rung 3: bootstrap-role public hosts, shuffled; demoted ones only when all are. */
  private _publicCandidates(): DialableCandidate[] {
    // Only hosts that serve bootstrap: a relay- or storage-only host must never
    // see this node's real identity.
    const publicPeers = loadPublicPeers(this.publicPeersPath || undefined).filter((p) => p.roles.includes('bootstrap'));
    this.publicPeersSeen = publicPeers.length;
    const available = publicPeers.filter((p) => !this._linked(p.nodeId));
    const healthy = available.filter((p) => !this.publicPeerHealth.isDemoted(p.nodeId));
    return shuffle(healthy.length > 0 ? healthy : available);
  }

  /** Rung 4: peers learned from peer exchange (earlier sessions included). */
  private _exchangeCandidates(): DialableCandidate[] {
    const px = this.node.peerExchange;
    if (!px || typeof px.candidates !== 'function') return [];
    return px.candidates().filter((c) => !this._linked(c.nodeId)).map((c) => ({ nodeId: c.nodeId, address: c.address, port: c.port }));
  }

  /**
   * Dial `candidates`, `concurrency` at a time, until one wins, all have
   * failed, or `budget` ms pass. With `lan`, beacons arriving meanwhile join
   * the rung and it runs its full budget.
   */
  private _runRung(run: LadderRun, rung: LadderRung, candidates: DialableCandidate[], budget: number, concurrency: number, lan: LanSource | null): Promise<void> {
    if (budget <= 0 || (candidates.length === 0 && !lan)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const queue = [...candidates];
      let active = 0;
      let finished = false;
      const onBeacon = (p: { nodeId: string; address: string; port: number }): void => {
        if (this._lanEligible(p.nodeId) && !queue.some((q) => q.nodeId === p.nodeId)) {
          queue.push({ nodeId: p.nodeId, address: p.address, port: p.port });
          pump();
        }
      };
      const mine = new Set<AbortController>();
      // End the rung: stop taking candidates, abort this rung's dials still in
      // flight, and hand over only once they have settled — so no dial
      // outlives its rung or holds a peer the next rung wants to try.
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearStagger();
        if (lan) lan.off('peer-discovered', onBeacon);
        for (const c of mine) c.abort();
        if (active === 0) resolve();
      };
      // Dial starts are staggered, so a live host is not queued
      // behind dead ones that all started at once and hold every slot.
      let lastStart = -Infinity;
      let staggerTimer: ReturnType<typeof setTimeout> | null = null;
      const pump = (): void => {
        if (finished) return;
        if (run.won) return finish();
        while (active < concurrency && queue.length > 0) {
          const wait = lastStart + this.dialStaggerMs - Date.now();
          if (wait > 0) {
            if (!staggerTimer) staggerTimer = setTimeout(() => { staggerTimer = null; pump(); }, wait);
            break;
          }
          lastStart = Date.now();
          const c = queue.shift()!;
          active++;
          void this._ladderDial(run, rung, c, budget - (Date.now() - started), mine).then(() => {
            active--;
            if (finished) { if (active === 0) resolve(); return; }
            if (run.won || (!lan && active === 0 && queue.length === 0)) finish();
            else pump();
          });
        }
        if (!lan && active === 0 && queue.length === 0) finish();
      };
      const clearStagger = (): void => { if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null; } };
      const started = Date.now();
      const timer = setTimeout(finish, budget);
      if (lan) lan.on('peer-discovered', onBeacon);
      pump();
    });
  }

  /** One ladder dial: capped, cancellable, and cancelling everything else if it wins. */
  /**
   * True when the shipped public-peer list (union of all list files) names this
   * NodeID with roles that do NOT include "bootstrap". Applies to every rung
   * (cache, LAN, public, peer-exchange): the public rung already filters list
   * entries by role, but cache/LAN/exchange candidates are learned by NodeID
   * with no role, so this NodeID-keyed check is the chokepoint that stops a
   * poisoned peer-exchange entry from dialing a storage-/relay-only host.
   * Logged unconditionally when it fires.
   */
  private _roleBlockedFromBootstrap(nodeIdHex: string): boolean {
    const id = nodeIdHex.toLowerCase();
    for (const e of loadPublicPeers(this.publicPeersPath || undefined)) {
      if (e.nodeId && e.nodeId.toLowerCase() === id && !(e.roles || []).includes('bootstrap')) {
        logger.warn('bootstrap', 'role-blocked-dial',
          `Refusing to dial ${id.slice(0, 16)}… for bootstrap: the shipped list marks it ${JSON.stringify(e.roles)} (no bootstrap role)`,
          { nodeId: id, roles: e.roles });
        return true;
      }
    }
    return false;
  }

  private async _ladderDial(run: LadderRun, rung: LadderRung, c: DialableCandidate, remainingMs: number, rungControllers: Set<AbortController>): Promise<void> {
    const nodeIdHex = c.nodeId;
    // Failures are remembered per NodeID *and address*: a peer that failed at
    // a stale cached address may still answer where the LAN or a list says it is.
    const attemptKey = `${nodeIdHex}@${c.address}:${c.port}`;
    if (!nodeIdHex || this._linked(nodeIdHex) || this.dialingNodeIds.has(nodeIdHex) || this.failedAttempts.has(attemptKey)) return;
    // Role gate (keyed on NodeID, before any dial): never bootstrap through a
    // NodeID the shipped list marks with roles that do not include "bootstrap"
    // (e.g. the storage-only peer). Otherwise a peer that advertised that NodeID
    // via peer exchange could make us dial it directly, exposing our identity to
    // it, after which every store-forward deposit there is refused
    // (STORAGE_ON_BOOTSTRAP_HOST) — a targeted denial of offline delivery.
    if (this._roleBlockedFromBootstrap(nodeIdHex)) return;
    this.dialingNodeIds.add(nodeIdHex);
    const controller = new AbortController();
    run.controllers.add(controller);
    rungControllers.add(controller);
    const cap = Math.max(1, Math.min(this.dialTimeoutMs, remainingMs));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cap);
    try {
      const dialing = this.node.dial(c.address, c.port, {
        tls: c.tls === true || c.port === 443,
        nodeId: nodeIdHex,
        signal: controller.signal,
        ...(c.roles ? { infrastructure: { operator: c.operator ?? null } } : {}),
      });
      // Stop waiting the moment this dial is aborted, whatever the transport
      // does; a connection that still turns up later is closed on arrival.
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Dial cancelled')), { once: true });
      });
      dialing.then((late) => { if (controller.signal.aborted) late.link.destroy(); }, () => {});
      const res = await Promise.race([dialing, aborted]);
      if (run.won) {
        // Another dial got there first: this one is cancelled.
        run.cancelled++;
        res.link.destroy();
        return;
      }
      run.won = true;
      run.rung = rung;
      if (rung === 'public') this.publicPeerHealth.recordSuccess(nodeIdHex);
      for (const other of run.controllers) {
        if (other !== controller && !other.signal.aborted) { other.abort(); run.cancelled++; }
      }
    } catch (e: unknown) {
      if (run.won && controller.signal.aborted && !timedOut) return; // cancelled by the winner, not a failure
      const endedWithRung = controller.signal.aborted && !timedOut;
      const err = e as NodeJS.ErrnoException;
      this.attemptLog.push({
        address: c.address,
        port: c.port,
        nodeId: nodeIdHex,
        stage: rung === 'public' ? 'public' : rung === 'cache' ? 'cached' : rung,
        kind: timedOut || endedWithRung ? 'unreachable' : classifyDialError(err),
        message: timedOut || endedWithRung ? `no answer within the ${rung} rung's budget` : (err && err.message ? err.message : String(e)),
      });
      this.failedAttempts.add(attemptKey);
      this.node.peerCache.recordFailure(nodeIdHex);
      if (rung === 'public') this.publicPeerHealth.recordFailure(nodeIdHex);
    } finally {
      clearTimeout(timer);
      run.controllers.delete(controller);
      rungControllers.delete(controller);
      this.dialingNodeIds.delete(nodeIdHex);
    }
  }

  /** Dial one candidate. */
  async dialCandidate(candidate: DialableCandidate): Promise<void> {
    if (!candidate || !candidate.nodeId) return;

    const nodeIdHex = candidate.nodeId;
    if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) return;

    if (this.node.getLinkByNodeId(nodeIdHex)) return;
    if (this.dialingNodeIds.has(nodeIdHex)) return;
    if (this.failedAttempts.has(nodeIdHex)) return;

    this.dialingNodeIds.add(nodeIdHex);

    try {
      await this.node.dial(candidate.address, candidate.port, {
        tls: candidate.tls === true || candidate.port === 443,
        // Lets the node apply role separation by NodeID before connecting.
        nodeId: nodeIdHex,
        // A public-peer entry (it has roles) is infrastructure: remember its
        // operator for relay separation. Cached peers are ordinary peers.
        ...(candidate.roles ? { infrastructure: { operator: candidate.operator ?? null } } : {}),
      });
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      // Keep why it failed, not just that it did. "cannot reach the host" and
      // "reached it but it would not complete a handshake" send the user to
      // completely different fixes, and the UI is expected to say which.
      this.attemptLog.push({
        address: candidate.address,
        port: candidate.port,
        nodeId: nodeIdHex,
        stage: this._stage === 'stage2' ? 'public' : 'cached',
        kind: classifyDialError(err),
        message: err && err.message ? err.message : String(e)
      });
      this.failedAttempts.add(nodeIdHex);
      this.node.peerCache.recordFailure(nodeIdHex);
    } finally {
      this.dialingNodeIds.delete(nodeIdHex);
    }
  }

  /**
   * Reduce this run's failures to the most actionable explanation: empty peer
   * list, handshake rejection, then unreachable host.
   */
  diagnose(): BootstrapDiagnosis {
    const publicAttempts = this.attemptLog.filter(a => a.stage === 'public');
    const connected = this.getDirectConnectionCount();

    let reason: BootstrapFailureReason;
    if (connected > 0) {
      // Reached some peers, fewer than minPeers: a thin mesh, not a broken one.
      reason = 'insufficient-peers';
    } else if (this.publicPeersSeen === 0) {
      reason = 'no-public-peers-configured';
    } else if (publicAttempts.length === 0) {
      // The list was non-empty but nothing was dialled: every entry was already
      // linked, or the batch was empty after filtering.
      reason = 'no-public-peers-attempted';
    } else if (publicAttempts.some(a => a.kind === 'handshake')) {
      reason = 'handshake-failed';
    } else {
      reason = 'peers-unreachable';
    }

    return {
      reason,
      peersConnected: connected,
      publicPeersConfigured: this.publicPeersSeen,
      peersFile: this.publicPeersPath || PUBLIC_PEERS_FILE,
      attempts: this.attemptLog.slice(0, 8)
    };
  }

  attemptCandidates(): void {
    if (!this.isBootstrapping) return;
    if (this.getDirectConnectionCount() >= this.minPeers) return;

    const candidates = this.node.peerCache.getCandidates() || [];
    const active = candidates.filter(c => !this.dialingNodeIds.has(c.nodeId) && !this.failedAttempts.has(c.nodeId) && !this.node.getLinkByNodeId(c.nodeId));

    if (active.length > 0) {
      const toDial = active.slice(0, this.parallelCount - this.dialingNodeIds.size);
      toDial.forEach(c => this.dialCandidate(c));
    }
  }

  checkAndTriggerRebootstrap(): void {
    if (this._disableBootstrap || this.isBootstrapping || this.rebootstrapTimer) return;
    const count = this.getDirectConnectionCount();
    if (count < this.minPeers / 2) {
      this.failureCount = 0;
      const delay = this.rebootstrapBackoffInitialMs;
      logger.info('bootstrap', 'trigger-rebootstrap', `Peers below critical threshold (${count} < ${this.minPeers / 2}). Scheduling re-bootstrap in ${delay}ms.`, { peersConnected: count });
      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);
      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  close(): void {
    this.node.off('close', this.closeListener);
    if (this._run) for (const c of this._run.controllers) c.abort();
    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }
  }
}

export type BootstrapFailureReason =
  | 'insufficient-peers'
  | 'no-public-peers-configured'
  | 'no-public-peers-attempted'
  | 'handshake-failed'
  | 'peers-unreachable';

export interface DialAttempt {
  address: string;
  port: number;
  nodeId: string;
  stage: 'cached' | 'lan' | 'public' | 'peer-exchange';
  kind: 'unreachable' | 'handshake' | 'unknown';
  message: string;
}

export interface BootstrapDiagnosis {
  reason: BootstrapFailureReason;
  peersConnected: number;
  publicPeersConfigured: number;
  peersFile: string;
  attempts: DialAttempt[];
}

/** Socket-level errors: the peer was never reached. Anything else came from the handshake. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);

export function classifyDialError(err: NodeJS.ErrnoException | null | undefined): DialAttempt['kind'] {
  if (!err) return 'unknown';
  if (err.code && UNREACHABLE_CODES.has(err.code)) return 'unreachable';
  const msg = (err.message || '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg.includes('connection timeout') || msg.includes('dial timeout')) return 'unreachable';
  if (
    msg.includes('handshake') ||
    msg.includes('hello') ||
    msg.includes('protocol version') ||
    msg.includes('signature') ||
    msg.includes('nodeid') ||
    msg.includes('timestamp')
  ) return 'handshake';
  return 'unknown';
}

export type LadderRung = 'cache' | 'lan' | 'public' | 'peer-exchange';
export type BootstrapStage = 'stage1' | 'lan' | 'stage2' | 'peer-exchange' | 'failed' | 'sufficient';

interface LadderRun {
  won: boolean;
  /** 'connected': the node already had minPeers when the run started. */
  rung: LadderRung | 'connected' | null;
  cancelled: number;
  t0: number;
  controllers: Set<AbortController>;
}

/** What rung 2 reads from LAN discovery. */
interface LanSource {
  getNodeIds(): string[];
  getPeer(nodeId: string): { nodeId: string; address: string; port: number } | null;
  on(event: 'peer-discovered', fn: (p: { nodeId: string; address: string; port: number }) => void): unknown;
  off(event: 'peer-discovered', fn: (p: { nodeId: string; address: string; port: number }) => void): unknown;
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Reachability of shipped public peers. A failed dial demotes a host for
 * base x 2^(failures-1), capped; a success clears it. Demoted hosts are tried
 * only when no other remains. Nothing is removed from the list.
 */
export class PublicPeerHealth {
  static readonly BASE_MS = 60_000;
  static readonly MAX_MS = 6 * 60 * 60 * 1000;
  private readonly entries = new Map<string, { failures: number; nextTryAt: number; lastOkAt: number | null }>();
  clock: () => number = () => Date.now();

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [id, e] of Object.entries(raw || {})) this.entries.set(id, e as { failures: number; nextTryAt: number; lastOkAt: number | null });
      } catch { /* unreadable health is no health: start fresh, lose nothing that matters */ }
    }
  }

  get(nodeId: string): { failures: number; nextTryAt: number; lastOkAt: number | null } | null {
    return this.entries.get(nodeId) ?? null;
  }

  isDemoted(nodeId: string): boolean {
    const e = this.entries.get(nodeId);
    return !!e && e.failures > 0 && e.nextTryAt > this.clock();
  }

  recordFailure(nodeId: string): void {
    const e = this.entries.get(nodeId) ?? { failures: 0, nextTryAt: 0, lastOkAt: null };
    e.failures++;
    e.nextTryAt = this.clock() + Math.min(PublicPeerHealth.MAX_MS, PublicPeerHealth.BASE_MS * 2 ** (e.failures - 1));
    this.entries.set(nodeId, e);
    this.save();
  }

  recordSuccess(nodeId: string): void {
    this.entries.set(nodeId, { failures: 0, nextTryAt: 0, lastOkAt: this.clock() });
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileAtomicSync(this.file, JSON.stringify(Object.fromEntries(this.entries))); } catch { /* best effort */ }
  }
}
