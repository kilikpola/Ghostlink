import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DEFAULTS } from './config-defaults.js';
import { StateAuthenticationError } from './types.js';
import { refuse } from './state-refusal.js';
import logger from './logger.js';
import { PEER_CACHE_FILE } from './paths.js';
import { writeFileAtomicSync, cleanStaleTempFiles } from './atomic-file.js';
import { withFileLock } from './file-lock.js';
import type { CachedPeer } from './types.js';

const DEFAULT_CACHE_FILE = PEER_CACHE_FILE;

export class PeerCache {
  private filePath: string;
  /** Read by key rotation (via PeerCacheLike) to find a rotated peer's entry. */
  cache: CachedPeer[];
  private encryptionKey: Buffer | null;
  private pruneInterval: NodeJS.Timeout | null;
  private readonly strictState: boolean;
  private readonly maxSize: number;
  private readonly pruneAgeDays: number;
  private readonly pruneFailureThreshold: number;

  constructor({ filePath, seedPhrase, strictState, maxSize, pruneAgeDays, pruneFailureThreshold }: {
    filePath?: string;
    seedPhrase?: string;
    /** Refuse unauthenticated state instead of discarding it (GMP_STRICT_STATE). */
    strictState?: boolean;
    maxSize?: number;
    pruneAgeDays?: number;
    pruneFailureThreshold?: number;
  } = {}) {
    // Set before anything below can load the file: the load path reads strictState.
    this.strictState = strictState ?? DEFAULTS.GMP_STRICT_STATE;
    this.maxSize = maxSize || DEFAULTS.GMP_PEER_CACHE_MAX_SIZE;
    this.pruneAgeDays = pruneAgeDays || DEFAULTS.GMP_PEER_CACHE_PRUNE_AGE_DAYS;
    this.pruneFailureThreshold = pruneFailureThreshold || DEFAULTS.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD;
    this.filePath = filePath || DEFAULT_CACHE_FILE;
    this.cache = [];
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        const error = err as Error;
        logger.error('peer-cache', 'mkdir-failed', `Failed to create data directory: ${error.message}`, { err: error.message });
      }
    }

    // Unique temp names mean a process killed mid-write leaves its file behind.
    cleanStaleTempFiles(this.filePath);

    this.load();
    this.prune();

    this.pruneInterval = setInterval(() => {
      this.prune();
    }, 24 * 60 * 60 * 1000);

    if (this.pruneInterval && this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  /** Attach the at-rest key and merge on-disk peers with those already in memory. */
  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    const hadEntries = this.cache.length > 0;
    this.load();
    if (hadEntries && this.encryptionKey) {
      this.save();
    }
  }

  /**
   * A cache file that cannot be authenticated: logged at ERROR, fatal under
   * GMP_STRICT_STATE.
   */
  private _onUnauthenticatedState(error: Error): void {
    logger.error(
      'peer-cache',
      'state-authentication-failed',
      `Peer cache exists but could not be authenticated; discarding it: ${error.message}`,
      { err: error.message, cacheFile: this.filePath, strict: this.strictState }
    );
    if (this.strictState) {
      throw refuse({
        what: `the peer cache could not be authenticated (${error.message}).`,
        file: this.filePath,
        action: 'move-aside',
        loses: 'the list of peers this node has met; it bootstraps from the public peer list instead. No replay protection is lost.',
      });
    }
  }

  /** Read the persisted cache, or null if there is nothing usable. */
  private _readPersistedCache(): CachedPeer[] | null {
    if (!this.encryptionKey) return null;
    try {
      if (!fs.existsSync(this.filePath)) return null;

      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; version?: number };
      if (!parsed || !parsed.iv || !parsed.ciphertext || parsed.version !== 1) {
        logger.warn('peer-cache', 'format-mismatch', 'Cache file format mismatch or plaintext, starting fresh.');
        return null;
      }

      const iv = Buffer.from(parsed.iv, 'hex');
      const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
      const authTag = encryptedBlob.slice(0, 16);
      const ciphertext = encryptedBlob.slice(16);

      // Separate catch so an authentication failure is distinguishable from a
      // missing file or a syntax error — see _onUnauthenticatedState.
      let decrypted: Buffer;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
        decipher.setAuthTag(authTag);
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (err) {
        this._onUnauthenticatedState(err as Error);
        return null;
      }

      const parsedCache = JSON.parse(decrypted.toString('utf8')) as unknown;
      if (Array.isArray(parsedCache)) return parsedCache as CachedPeer[];

      logger.warn('peer-cache', 'format-mismatch', 'Cache file format mismatch or plaintext, starting fresh.');
      return null;
    } catch (err) {
      // See the note in NonceStore._readPersistedState(): a strict-mode refusal
      // has to pass straight through this catch, not be turned into a fresh
      // start.
      if (err instanceof StateAuthenticationError) throw err;
      const error = err as Error;
      logger.warn('peer-cache', 'load-failed', `Failed to load cache, starting fresh: ${error.message}`, { err: error.message });
      return null;
    }
  }

  /**
   * Merge one peer's memory and disk records: latest sighting, larger
   * success/failure tallies, earliest first contact.
   */
  private _mergePeer(mine: CachedPeer, theirs: CachedPeer): CachedPeer {
    const newer = mine.lastSeen >= theirs.lastSeen ? mine : theirs;
    const failedAt = [mine.lastFailedAt, theirs.lastFailedAt].filter(
      (v): v is number => typeof v === 'number',
    );

    return {
      ...newer,
      nodeId: mine.nodeId,
      lastSeen: Math.max(mine.lastSeen, theirs.lastSeen),
      firstSeen: Math.min(mine.firstSeen, theirs.firstSeen),
      connectionCount: Math.max(mine.connectionCount, theirs.connectionCount),
      failureCount: Math.max(mine.failureCount, theirs.failureCount),
      lastFailedAt: failedAt.length ? Math.max(...failedAt) : null,
      // Address and port come from `newer` via the spread: the most recent
      // sighting is the one worth dialling.
      signingPubKey: newer.signingPubKey ?? mine.signingPubKey ?? theirs.signingPubKey,
    };
  }

  /**
   * Fold the persisted cache into the live one: the union of both, keyed by
   * NodeID, never a replacement.
   */
  private _mergeCache(loaded: CachedPeer[] | null): void {
    if (!loaded) return;

    const byId = new Map<string, CachedPeer>();
    for (const peer of loaded) {
      if (peer && typeof peer.nodeId === 'string') byId.set(peer.nodeId, peer);
    }
    for (const mine of this.cache) {
      if (!mine || typeof mine.nodeId !== 'string') continue;
      const theirs = byId.get(mine.nodeId);
      byId.set(mine.nodeId, theirs ? this._mergePeer(mine, theirs) : mine);
    }
    this.cache = [...byId.values()];
  }

  /** Bring the persisted cache in, merging rather than replacing. */
  load(): void {
    this._mergeCache(this._readPersistedCache());
    if (!Array.isArray(this.cache)) {
      this.cache = [];
    }
  }

  save(): void {
    if (!this.encryptionKey) {
      return;
    }
    try {
      // Re-read and merge under the lock so concurrent writers keep each other's peers.
      withFileLock(this.filePath, () => {
        this._mergeCache(this._readPersistedCache());
        writeFileAtomicSync(this.filePath, this._serialize());
      });
    } catch (err) {
      const error = err as Error;
      logger.error('peer-cache', 'save-failed', `Failed to save cache: ${error.message}`, { err: error.message });
    }
  }

  /** The encrypted on-disk envelope for the current cache. */
  private _serialize(): string {
    const plaintextJson = JSON.stringify(this.cache);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString('hex'),
      ciphertext: Buffer.concat([authTag, ciphertext]).toString('hex'),
      version: 1,
    }, null, 2);
  }

  recordSuccess(nodeId: string, address: string, port: number, signingPubKey: string | null = null): void {
    if (!nodeId) return;

    const now = Date.now();
    let entry = this.cache.find(e => e.nodeId === nodeId);

    if (entry) {
      entry.address = address;
      entry.port = port;
      delete entry.inbound;
      entry.lastSeen = now;
      entry.connectionCount++;
      entry.failureCount = 0;
      if (signingPubKey) {
        entry.signingPubKey = signingPubKey;
      }
    } else {
      entry = {
        nodeId,
        address,
        port,
        firstSeen: now,
        lastSeen: now,
        connectionCount: 1,
        lastFailedAt: null,
        failureCount: 0,
      };
        // Record the signing key on first contact; key rotation depends on it.
        if (signingPubKey) {
          entry.signingPubKey = signingPubKey;
        }
      this.cache.push(entry);
    }

    const maxSize = this.maxSize;
    if (this.cache.length > maxSize) {
      this.cache.sort((a, b) => this.getScore(b) - this.getScore(a));
      this.cache = this.cache.slice(0, maxSize);
    }

    this.save();
  }

  recordFailure(nodeId: string): void {
    if (!nodeId) return;

    const entry = this.cache.find(e => e.nodeId === nodeId);
    if (entry) {
      entry.lastFailedAt = Date.now();
      entry.failureCount++;
      this.save();
    }
  }

  replaceNodeId(oldNodeId: string, newNodeId: string, newPublicKey: string): boolean {
    const entry = this.cache.find(e => e.nodeId === oldNodeId);
    if (entry) {
      entry.nodeId = newNodeId;
      entry.signingPubKey = newPublicKey;
      this.save();
      return true;
    }
    return false;
  }

  getScore(entry: CachedPeer): number {
    const now = Date.now();
    const ageMs = now - entry.lastSeen;
    let recencyBonus = 0.1;

    if (ageMs < 60 * 60 * 1000) {
      recencyBonus = 1.0;
    } else if (ageMs < 24 * 60 * 60 * 1000) {
      recencyBonus = 0.7;
    } else if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      recencyBonus = 0.4;
    }

    return (entry.connectionCount / (entry.failureCount + 1)) * recencyBonus;
  }

  /** An inbound peer: remember its signing key, not its address. */
  recordInbound(nodeId: string, signingPubKey: string | null = null): void {
    if (!nodeId) return;
    const now = Date.now();
    const entry = this.cache.find(e => e.nodeId === nodeId);
    if (entry) {
      entry.lastSeen = now;
      if (signingPubKey) entry.signingPubKey = signingPubKey;
    } else {
      this.cache.push({
        nodeId,
        address: '',
        port: 0,
        firstSeen: now,
        lastSeen: now,
        connectionCount: 0,
        lastFailedAt: null,
        failureCount: 0,
        inbound: true,
        ...(signingPubKey ? { signingPubKey } : {}),
      });
    }
    this.save();
  }

  /** Dialable entries only: an inbound-only entry has no address to dial. */
  private _dialable(entry: CachedPeer): boolean {
    return !entry.inbound && !!entry.address && entry.port > 0;
  }

  getCandidates(): CachedPeer[] {
    return this.cache.filter((e) => this._dialable(e)).sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  getDirectPeers24h(): CachedPeer[] {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return this.cache.filter(entry => this._dialable(entry) && entry.lastSeen >= oneDayAgo && entry.connectionCount > 0);
  }

  prune(): void {
    const pruneAgeDays = this.pruneAgeDays;
    const failureThreshold = this.pruneFailureThreshold;
    const cutoffTime = Date.now() - pruneAgeDays * 24 * 60 * 60 * 1000;

    this.cache = this.cache.filter(entry => {
      const isDead = entry.failureCount > failureThreshold && entry.lastSeen < cutoffTime;
      return !isDead;
    });
    this.save();
  }

  close(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}