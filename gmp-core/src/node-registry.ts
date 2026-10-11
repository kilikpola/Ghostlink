/**
 * NodeRegistry — maps each identity (the NodeID a seed derives) to its own
 * GMPNodeManager for bridge sessions.
 *
 * - The seed chooses the node: sessions with the same seed share one node.
 * - A manager supplied by the host (Electron, CLI) is adopted as the default
 *   node for sessions that send no seed.
 * - Created nodes get <dataRoot>/nodes/<NodeID prefix>/, except an identity
 *   whose claim log already lives in the process-wide data directory.
 * - At most maxNodes created nodes; they run until stopAll(). Adopted managers
 *   are the host's to stop.
 */

import fs from 'fs';
import path from 'path';
import { GMPNodeManager } from './gmp-node-manager.js';
import { deriveIdentityFromSeedPhrase } from './identity.js';
import { deriveNonceStoreKey } from './nonce-store.js';
import { ClaimLog } from './claim-log.js';
import { DATA_DIR, NONCE_CLAIMS_FILE } from './paths.js';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import type { GMPNodeManagerOptions } from './types.js';

export class RegistryError extends Error {
  readonly code: 'NO_SEED' | 'REGISTRY_FULL';

  constructor(code: 'NO_SEED' | 'REGISTRY_FULL', message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export interface NodeRegistryOptions {
  /** Most nodes the registry will create (adopted ones not counted). */
  maxNodes?: number;
  /** Parent of the per-identity nodes/ directories. */
  dataRoot?: string;
  /** Port a created node binds when the client asks for none. */
  defaultPort?: number;
  /** Extra options for every created manager (tests: transport, metrics port). */
  managerOptions?: Partial<GMPNodeManagerOptions>;
}

interface Entry {
  nodeId: string;
  manager: GMPNodeManager;
  adopted: boolean;
  /** Pending start, shared by concurrent acquires of the same identity. */
  ready: Promise<GMPNodeManager>;
}

export class NodeRegistry {
  private readonly maxNodes: number;
  private readonly dataRoot: string;
  private readonly defaultPort: number;
  private readonly managerOptions: Partial<GMPNodeManagerOptions>;
  private readonly entries = new Map<string, Entry>();
  private readonly creating = new Map<string, Promise<Entry>>();
  private defaultManager: GMPNodeManager | null = null;
  /** NodeID (or 'default') using the process-wide data directory. */
  private rootHolder: string | null = null;

  constructor(options: NodeRegistryOptions = {}) {
    this.maxNodes = options.maxNodes ?? 8;
    this.dataRoot = path.resolve(options.dataRoot ?? DATA_DIR);
    this.defaultPort = options.defaultPort ?? DEFAULTS.GMP_PORT;
    this.managerOptions = options.managerOptions ?? {};
  }

  /** The host's own node: used by sessions that send no seed. */
  adopt(manager: GMPNodeManager): void {
    this.defaultManager = manager;
    if (!manager.dataDir) this.rootHolder = 'default';
  }

  get default(): GMPNodeManager | null {
    return this.defaultManager;
  }

  /** NodeIDs of every node the registry knows, adopted included once started. */
  list(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return [...this.entries.values()].filter((e) => !e.adopted).length;
  }

  /**
   * The started node for a seed phrase — existing or newly created. With no
   * seed, the adopted default node (started if its host has not yet).
   */
  async acquire(seedPhrase?: string, requestedPort?: number): Promise<GMPNodeManager> {
    if (!seedPhrase) {
      if (!this.defaultManager) {
        throw new RegistryError('NO_SEED', 'No seed phrase given and the bridge has no node of its own');
      }
      return this._startAdopted(this.defaultManager);
    }

    const identity = await deriveIdentityFromSeedPhrase(seedPhrase);
    const nodeId = Buffer.from(identity.nodeId).toString('hex');

    if (this.defaultManager && (await this.defaultManager.resolveNodeId()) === nodeId) {
      return this._startAdopted(this.defaultManager);
    }

    const existing = this.entries.get(nodeId);
    if (existing) return existing.ready;

    let pending = this.creating.get(nodeId);
    if (!pending) {
      pending = this._create(nodeId, seedPhrase, requestedPort);
      this.creating.set(nodeId, pending);
      pending.finally(() => this.creating.delete(nodeId)).catch(() => {});
    }
    return (await pending).ready;
  }

  private async _startAdopted(manager: GMPNodeManager): Promise<GMPNodeManager> {
    if (!manager.node) await manager.start();
    const nodeId = manager.getNodeId();
    if (!this.entries.has(nodeId)) {
      this.entries.set(nodeId, { nodeId, manager, adopted: true, ready: Promise.resolve(manager) });
    }
    return manager;
  }

  private async _create(nodeId: string, seedPhrase: string, requestedPort?: number): Promise<Entry> {
    if (this.size >= this.maxNodes) {
      throw new RegistryError('REGISTRY_FULL', `The bridge already runs its limit of ${this.maxNodes} nodes`);
    }

    const dataDir = this._dataDirFor(nodeId, seedPhrase);
    const port = this._portFor(requestedPort);
    const manager = new GMPNodeManager({
      ...this.managerOptions,
      seedPhrase,
      GMP_PORT: port,
      ...(dataDir ? { dataDir } : {}),
    });

    const entry: Entry = {
      nodeId,
      manager,
      adopted: false,
      ready: manager.start().then(() => manager),
    };
    this.entries.set(nodeId, entry);
    try {
      await entry.ready;
    } catch (err) {
      this.entries.delete(nodeId);
      if (this.rootHolder === nodeId) this.rootHolder = null;
      throw err;
    }
    logger.info('node-registry', 'node-created', `Started node ${nodeId.slice(0, 16)}… for a bridge session`, {
      port: manager.node ? manager.node.port : port,
      dataDir: dataDir ?? DATA_DIR,
    });
    return entry;
  }

  /**
   * Undefined means the process-wide paths, reserved for the identity whose
   * claim log already lives there while nothing else uses them.
   */
  private _dataDirFor(nodeId: string, seedPhrase: string): string | undefined {
    if (this.rootHolder === null && this.dataRoot === path.resolve(DATA_DIR)) {
      const legacyLog = ClaimLog.scopedPath(NONCE_CLAIMS_FILE, deriveNonceStoreKey(seedPhrase));
      if (fs.existsSync(legacyLog)) {
        this.rootHolder = nodeId;
        return undefined;
      }
    }
    return path.join(this.dataRoot, 'nodes', nodeId.slice(0, 32));
  }

  /** The requested port, else the default; ephemeral if another node has it. */
  private _portFor(requestedPort?: number): number {
    const wanted = Number(requestedPort) || this.defaultPort;
    const taken = new Set(
      [...this.entries.values(), ...(this.defaultManager ? [{ manager: this.defaultManager }] : [])]
        .map((e) => e.manager.node?.port)
        .filter((p) => p !== undefined),
    );
    if (taken.has(wanted)) {
      logger.info('node-registry', 'port-in-use', `Port ${wanted} is held by another node; using an ephemeral port`, { wanted });
      return 0;
    }
    return wanted;
  }

  /** Stop every node the registry created. Adopted nodes belong to their host. */
  async stopAll(): Promise<void> {
    const created = [...this.entries.values()].filter((e) => !e.adopted);
    this.entries.clear();
    if (this.rootHolder !== 'default') this.rootHolder = null;
    await Promise.all(created.map((e) => e.manager.stop().catch(() => {})));
  }
}
