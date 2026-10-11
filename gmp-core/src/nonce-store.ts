import fs from 'fs';
import type { NoEvents } from './events.js';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import { NONCE_STATE_FILE, NONCE_CLAIMS_FILE } from './paths.js';
import { writeFileAtomicSync, cleanStaleTempFiles } from './atomic-file.js';
import { withFileLock } from './file-lock.js';
import { ClaimLog, type ClaimRecord } from './claim-log.js';
import { StateAuthenticationError } from './types.js';
import { refuse } from './state-refusal.js';

// Resolved from the package root, not process.cwd(), so every launch location
// shares one state file.
const DEFAULT_STATE_FILE = NONCE_STATE_FILE;

/**
 * v1 kept claims among the counter entries, v2 in their own map, v3 in the
 * append-only claim log. Older files are migrated on read; unknown versions are
 * refused (see _onUnsupportedVersion).
 */
const CURRENT_STATE_VERSION = 3;
const SUPPORTED_STATE_VERSIONS = new Set([1, 2, 3]);

/**
 * An entry this many retention windows old means the clock jumped, not that the
 * entry aged out.
 */
const CLOCK_JUMP_FACTOR = 10;

/**
 * Persisted half of GhostLink's replay protection.
 *
 * Invariants (weakening any of these is a security regression):
 *   I0. Every claim-log offset is a record boundary.
 *   I1. A session-key fingerprint is claimed at most once, across processes and
 *       restarts. Cross-process atomicity rests on withFileLock.
 *   I2. A high-water mark never decreases (Math.max everywhere).
 *   I3. A claim reported successful has been appended and fsynced.
 *   I4. Loaded state is merged into memory, never assigned over it.
 *
 * Storage:
 *   nonce-state.json  per-session counters; pruned, rewritten in batches.
 *   nonce-claims.log  permanent claims; append-only, one sealed record each.
 *                     A checkpoint (claim-log.ts) bounds replay on startup.
 *
 * Known gap: the claim log's length is not authenticated, so truncating its
 * tail past the last checkpoint goes undetected. The data directory is outside
 * the threat model (SECURITY.md §2).
 */


interface NonceStateEntry {
  highWaterMark: number;
  /** Highest nonce this side has sent on this session. */
  sendHighWater?: number;
  /** Highest nonce received from the peer on this session. */
  recvHighWater?: number;
  firstSeen?: number;
  lastActivity: number;
}

/**
 * A used session-key fingerprint. Keyed by fingerprint alone, never by peer;
 * peerNodeId is diagnostic only.
 */
interface LegacyClaim {
  /** Hex NodeID of the peer this key was first claimed with. Not part of the key. */
  peerNodeId: string;
  claimedAt: number;
}

interface NonceState {
  /** Per-session counters, keyed `${peerHex}:${fingerprint}`. Pruned by age. */
  entries: Record<string, NonceStateEntry>;
  /** Version 2 only; read for migration. */
  claims?: Record<string, LegacyClaim>;
  version: number;
}

/** The nonce store's at-rest key for a seed phrase. */
export function deriveNonceStoreKey(seedPhrase: string): Buffer {
  return crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
}

export class NonceStore extends EventEmitter<NoEvents> {
  private stateFile: string;
  private pruneAgeMs: number;
  private state: NonceState;
  private encryptionKey: Buffer | null;
  private _loaded: boolean;
  private _dirty: boolean;
  private _saveTimer: NodeJS.Timeout | null;
  private lockTimeoutMs: number;
  private claimLog: ClaimLog;
  private readonly strictState: boolean;

  constructor({ stateFile = DEFAULT_STATE_FILE, pruneAgeMs, seedPhrase, lockTimeoutMs, claimsFile, strictState }: {
    stateFile?: string;
    pruneAgeMs?: number;
    seedPhrase?: string;
    lockTimeoutMs?: number;
    claimsFile?: string;
    /** Refuse unauthenticated state instead of discarding it (GMP_STRICT_STATE). */
    strictState?: boolean;
  } = {}) {
    super();
    this.strictState = strictState ?? DEFAULTS.GMP_STRICT_STATE;
    this.stateFile = stateFile;
    this.lockTimeoutMs = lockTimeoutMs ?? 5000;
    // Unique temp names mean a process killed mid-write leaves its file behind.
    cleanStaleTempFiles(this.stateFile);
    this.pruneAgeMs = pruneAgeMs ?? DEFAULTS.GMP_NONCE_PRUNE_AGE_MS;
    this.state = {
      entries: {},
      version: CURRENT_STATE_VERSION,
    };
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = deriveNonceStoreKey(seedPhrase);
    }

    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;

    // A custom state file gets its own claim log beside it, never the shared default.
    this.claimLog = new ClaimLog({
      filePath: claimsFile
        ?? (stateFile === DEFAULT_STATE_FILE ? NONCE_CLAIMS_FILE : `${stateFile}.claims.log`),
      encryptionKey: this.encryptionKey,
      lockTimeoutMs: this.lockTimeoutMs,
      strictState: this.strictState,
    });
  }

  /** Where the append-only claim log lives. */
  get claimsFile(): string {
    return this.claimLog.path;
  }

  /** How many session keys have been claimed. Loads on first use. */
  get claimCount(): number {
    if (!this._loaded) this.load();
    return this.claimLog.size;
  }

  /**
   * Attach the at-rest key and merge on-disk state with claims already taken
   * in memory during startup.
   *
   * Returns false if the merged state could not be written.
   */
  setEncryptionKey(key: Buffer | null): boolean {
    this.encryptionKey = key;
    const carriedForward = this._entryCount() > 0;
    const heldClaims = this.claimLog.pendingCount;

    this.claimLog.setEncryptionKey(key);
    this.load();

    // Claims taken before the key existed are still only in memory. They are
    // the reason this method has a return value at all.
    if (!this.claimLog.flushPending()) {
      const message =
        `${heldClaims} session key claim(s) made before the encryption key was configured could not be ` +
        `written to ${this.claimLog.path}. They are honoured in memory, but a restart would accept a ` +
        `session key this node has already used.`;
      logger.error('nonce-store', 'state-merge-persist-failed', message, { claimsFile: this.claimLog.path });
      if (this.strictState) {
        throw refuse({ what: message, file: this.claimLog.path, action: 'fix-access' });
      }
      return false;
    }

    if (!carriedForward || !this.encryptionKey) return true;

    // Something was claimed before the key existed. It is only merged in
    // memory so far, and the whole point of the merge is that it outlives this
    // process.
    if (!this._saveNow()) {
      const message =
        `Merged nonce state could not be written to ${this.stateFile}. Claims made before the ` +
        `encryption key was configured are held in memory only, so a restart would accept a ` +
        `session key this node has already used.`;
      logger.error('nonce-store', 'state-merge-persist-failed', message, { stateFile: this.stateFile });
      if (this.strictState) {
        throw refuse({ what: message, file: this.stateFile, action: 'fix-access' });
      }
      return false;
    }
    return true;
  }

  private _entryCount(): number {
    return Object.keys(this.state.entries).length;
  }

  private _getKey(peerNodeId: Uint8Array, sessionKeyFingerprint: string): string {
    const peerHex = Buffer.from(peerNodeId).toString('hex');
    return `${peerHex}:${sessionKeyFingerprint}`;
  }

  /**
   * A state file that exists but cannot be authenticated. Continuing resets
   * every high-water mark, so this logs at ERROR and is fatal under
   * GMP_STRICT_STATE.
   */
  private _onUnauthenticatedState(error: Error): void {
    logger.error(
      'nonce-store',
      'state-authentication-failed',
      `Nonce state file exists but could not be authenticated; replay protection is being reset: ${error.message}`,
      { err: error.message, stateFile: this.stateFile, strict: this.strictState }
    );
    if (this.strictState) {
      throw refuse({
        what: `the nonce state file could not be authenticated (${error.message}).`,
        file: this.stateFile,
        action: 'move-aside',
        loses: 'replay protection for the sessions it covers: every per-session nonce high-water mark in it, so a peer could replay frames this node already accepted on those sessions. Session-key claims live in the separate claim log and are not affected.',
      });
    }
  }

  /**
   * A valid state file in a format version this build does not know (usually a
   * downgrade). Handled like an authentication failure.
   */
  private _onUnsupportedVersion(version: unknown): void {
    logger.error(
      'nonce-store',
      'state-version-unsupported',
      `Nonce state at ${this.stateFile} is version ${String(version)}, which this build cannot read; ` +
      `replay protection would be reset. Supported versions: ${[...SUPPORTED_STATE_VERSIONS].join(', ')}.`,
      { stateFile: this.stateFile, version: String(version), strict: this.strictState }
    );
    if (this.strictState) {
      throw refuse({
        what: `the nonce state file is format version ${String(version)}, which this build cannot read (supported: ${[...SUPPORTED_STATE_VERSIONS].join(', ')}).`,
        file: this.stateFile,
        action: 'move-aside',
        cause: 'a newer build wrote this file and an older build is now running (a downgrade). Prefer running the newer build again.',
        loses: 'replay protection for the sessions it covers: every per-session nonce high-water mark in it, so a peer could replay frames this node already accepted on those sessions.',
      });
    }
  }

  /** Upgrade an older file, returning claims to move into the claim log. */
  private _migrateToCurrent(loaded: NonceState): { state: NonceState; claims: ClaimRecord[] } {
    const collected = new Map<string, ClaimRecord>();

    const remember = (fingerprint: string, peerNodeId: string, claimedAt: number) => {
      const existing = collected.get(fingerprint);
      if (existing && existing.peerNodeId !== peerNodeId) {
        logger.error(
          'nonce-store',
          'session-key-collision',
          `The same session key fingerprint is claimed by two different peers — session key generation ` +
          `may be broken (fingerprint ${fingerprint.slice(0, 12)}…)`,
          {
            fingerprint: fingerprint.slice(0, 12),
            peerA: existing.peerNodeId.slice(0, 16),
            peerB: peerNodeId.slice(0, 16),
          }
        );
      }
      if (!existing || claimedAt < existing.claimedAt) {
        collected.set(fingerprint, { fingerprint, peerNodeId, claimedAt });
      }
    };

    // v2 kept claims in their own map here.
    for (const [fingerprint, claim] of Object.entries(loaded.claims ?? {})) {
      remember(fingerprint, claim.peerNodeId, claim.claimedAt);
    }

    // v1 stored claims as counter entries; promote every entry's fingerprint.
    // Over-claiming is the safe direction.
    if (loaded.version < 2) {
      for (const [compositeKey, entry] of Object.entries(loaded.entries)) {
        const separator = compositeKey.indexOf(':');
        if (separator <= 0) continue;
        const fingerprint = compositeKey.slice(separator + 1);
        if (!fingerprint) continue;
        remember(fingerprint, compositeKey.slice(0, separator), entry.lastActivity);
      }
    }

    return {
      state: { entries: loaded.entries, version: CURRENT_STATE_VERSION },
      claims: [...collected.values()],
    };
  }

  /** Read the persisted state, or null if there is nothing usable. */
  private _readPersistedState(): { state: NonceState; migratedClaims: ClaimRecord[] } | null {
    if (!this.encryptionKey) return null;
    try {
      if (!fs.existsSync(this.stateFile)) return null;

      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; version?: number };
      if (!parsed || !parsed.iv || !parsed.ciphertext || parsed.version !== 1) {
        logger.warn('nonce-store', 'format-mismatch', 'Nonce state file format mismatch or plaintext, starting fresh.');
        return null;
      }

      const iv = Buffer.from(parsed.iv, 'hex');
      const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
      const authTag = encryptedBlob.slice(0, 16);
      const ciphertext = encryptedBlob.slice(16);

      // Separate catch so an authentication failure is distinguishable from a
      // missing or malformed file.
      let decrypted: Buffer;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
        decipher.setAuthTag(authTag);
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (err) {
        this._onUnauthenticatedState(err as Error);
        return null;
      }

      const stateObj = JSON.parse(decrypted.toString('utf8')) as NonceState;
      if (!stateObj || !stateObj.entries) return null;

      if (!SUPPORTED_STATE_VERSIONS.has(stateObj.version)) {
        // A newer format version must not silently discard marks and claims.
        this._onUnsupportedVersion(stateObj.version);
        return null;
      }

      if (stateObj.version === CURRENT_STATE_VERSION) {
        return { state: stateObj, migratedClaims: [] };
      }
      const migrated = this._migrateToCurrent(stateObj);
      return { state: migrated.state, migratedClaims: migrated.claims };
    } catch (err) {
      // A strict-mode refusal must not be absorbed here. This catch exists to
      // survive unreadable or malformed files by starting fresh, which is the
      // precise behaviour strict mode is meant to prevent.
      if (err instanceof StateAuthenticationError) throw err;
      const error = err as Error;
      logger.warn('nonce-store', 'load-failed', `Failed to load state file, starting fresh: ${error.message}`, { err: error.message });
      return null;
    }
  }

  /**
   * Merge one session's persisted counters with memory: counters take the max,
   * firstSeen the earlier, lastActivity the later.
   */
  private _mergeEntry(mine: NonceStateEntry, theirs: NonceStateEntry): NonceStateEntry {
    // Legacy entries carry only the aggregate mark. Falling back to it rather
    // than to zero keeps a pre-directional state file from reopening the
    // window the aggregate had already closed.
    const sendHighWater = Math.max(
      mine.sendHighWater ?? mine.highWaterMark,
      theirs.sendHighWater ?? theirs.highWaterMark,
    );
    const recvHighWater = Math.max(
      mine.recvHighWater ?? mine.highWaterMark,
      theirs.recvHighWater ?? theirs.highWaterMark,
    );
    const seen = [mine.firstSeen, theirs.firstSeen].filter((v): v is number => typeof v === 'number');

    return {
      highWaterMark: Math.max(mine.highWaterMark, theirs.highWaterMark, sendHighWater, recvHighWater),
      sendHighWater,
      recvHighWater,
      ...(seen.length ? { firstSeen: Math.min(...seen) } : {}),
      lastActivity: Math.max(mine.lastActivity, theirs.lastActivity),
    };
  }

  /**
   * Fold persisted state into the live state as a union. Returns whether memory
   * holds anything not yet on disk.
   */
  private _mergeState(loaded: NonceState | null): boolean {
    if (!loaded) return this._entryCount() > 0;

    let carriedForward = false;
    const merged: Record<string, NonceStateEntry> = { ...loaded.entries };

    for (const [key, mine] of Object.entries(this.state.entries)) {
      const theirs = loaded.entries[key];
      if (!theirs) {
        merged[key] = mine;
        carriedForward = true;
        continue;
      }
      const combined = this._mergeEntry(mine, theirs);
      // Only a mark that actually moved is worth a write.
      if (
        combined.highWaterMark !== theirs.highWaterMark ||
        combined.sendHighWater !== (theirs.sendHighWater ?? theirs.highWaterMark) ||
        combined.recvHighWater !== (theirs.recvHighWater ?? theirs.highWaterMark)
      ) {
        carriedForward = true;
      }
      merged[key] = combined;
    }

    this.state = { entries: merged, version: CURRENT_STATE_VERSION };
    return carriedForward;
  }

  /** Bring the persisted state in, merging rather than replacing. */
  load(): this {
    const read = this._readPersistedState();
    if (this._mergeState(read?.state ?? null)) {
      // Mark dirty so setEncryptionKey()'s flush has something to write and
      // the batched timer retries if that flush fails.
      this._dirty = true;
    }

    this.claimLog.load();
    this._drainMigratedClaims(read?.migratedClaims ?? []);
    // Deduplicating the log is a startup job and never touches the handshake
    // path; it declines unless the file is both large and provably redundant.
    this.claimLog.compactIfNeeded();

    this._loaded = true;
    this._pruneOldEntries();
    return this;
  }

  /**
   * Move migrated claims into the claim log, skipping any it already holds, and
   * mark the state dirty so the next write drops the legacy claims map.
   */
  private _drainMigratedClaims(claims: ClaimRecord[]): void {
    if (claims.length === 0) return;

    const fresh = claims.filter(c => !this.claimLog.has(c.fingerprint));
    if (fresh.length > 0 && !this.claimLog.append(fresh).ok) {
      logger.error(
        'nonce-store',
        'claim-migration-failed',
        `Could not move ${fresh.length} session key claim(s) into ${this.claimLog.path}; ` +
        `they are held in memory and the state file still carries them.`,
        { claimsFile: this.claimLog.path, count: fresh.length },
      );
      return;
    }

    logger.info(
      'nonce-store',
      'claims-migrated',
      `Moved ${fresh.length} session key claim(s) into the append-only log ` +
      `(${claims.length} read from the state file, ${this.claimLog.size} claims held in total).`,
      { claimsFile: this.claimLog.path, migrated: fresh.length, total: this.claimLog.size },
    );
    this._dirty = true;
  }

  /**
   * Mark the state dirty for a batched write within a second. Used on the
   * per-frame path; claims use _saveNow() instead.
   */
  save(): void {
    this._dirty = true;
    if (this._saveTimer) return;

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 1000);
  }

  /** Write the state now and report whether it reached disk. */
  private _saveNow(): boolean {
    if (!this.encryptionKey) return false;
    if (!this._dirty) return true;
    try {
      // Re-read and merge under an exclusive lock so concurrent writers never
      // erase each other's state.
      withFileLock(this.stateFile, () => {
        this._mergeState(this._readPersistedState()?.state ?? null);
        writeFileAtomicSync(this.stateFile, this._serialize());
      }, { timeoutMs: this.lockTimeoutMs });
      this._dirty = false;
      return true;
    } catch (err) {
      const error = err as Error;
      logger.error('nonce-store', 'save-failed', `Failed to save state: ${error.message}`, { err: error.message });
      return false;
    }
  }

  /** The encrypted on-disk envelope for the current state. */
  private _serialize(): string {
    const plaintextJson = JSON.stringify(this.state);
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

  /**
   * Drop counter entries idle past the retention window. Claims are never
   * pruned. A cycle is skipped when entries look implausibly old (clock jump).
   */
  private _pruneOldEntries(): void {
    const now = Date.now();
    const implausible = this.pruneAgeMs * CLOCK_JUMP_FACTOR;
    const stale: string[] = [];

    for (const [key, entry] of Object.entries(this.state.entries)) {
      const idle = now - entry.lastActivity;
      if (idle > implausible) {
        logger.warn(
          'nonce-store',
          'prune-skipped-clock-jump',
          `Skipping this prune cycle: an entry appears ${Math.round(idle / 86_400_000)} days idle against a ` +
          `${Math.round(this.pruneAgeMs / 86_400_000)} day retention window, which points at a clock jump ` +
          `rather than genuine age. No counters were removed.`,
          { stateFile: this.stateFile, idleMs: idle, pruneAgeMs: this.pruneAgeMs }
        );
        return;
      }
      if (idle > this.pruneAgeMs) stale.push(key);
    }

    for (const key of stale) delete this.state.entries[key];
    if (stale.length > 0) this.save();
  }

  /** Accept a raw session key or a fingerprint, fingerprinted as link.js does. */
  private _fingerprint(sessionKey: Uint8Array | string): string {
    if (typeof sessionKey === 'string') return sessionKey;
    return crypto.createHash('sha256').update(Buffer.from(sessionKey)).digest('hex').slice(0, 32);
  }

  /**
   * Record send/receive counter progress for a session. Counters only move
   * forward.
   */
  updateCounters(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
    sendCounter: number,
    recvCounter: number,
  ): void {
    if (!this._loaded) this.load();

    const key = this._getKey(peerNodeId, this._fingerprint(sessionKey));
    const now = Date.now();
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: Math.max(sendCounter, recvCounter),
        sendHighWater: sendCounter,
        recvHighWater: recvCounter,
        firstSeen: now,
        lastActivity: now,
      };
    } else {
      // Fall back to the aggregate mark: older entries carry only highWaterMark.
      entry.sendHighWater = Math.max(entry.sendHighWater ?? entry.highWaterMark, sendCounter);
      entry.recvHighWater = Math.max(entry.recvHighWater ?? entry.highWaterMark, recvCounter);
      // The aggregate has to cover both directions. checkNonce reads it on its
      // own, so leaving it behind the send counter would let checkNonce accept
      // a nonce this session has already moved past.
      entry.highWaterMark = Math.max(entry.highWaterMark, entry.sendHighWater, entry.recvHighWater);
      entry.firstSeen = entry.firstSeen ?? now;
      entry.lastActivity = now;
    }
    this.save();
  }

  /**
   * Replay check for a reconnecting session: both counters must be strictly
   * above the recorded marks. The record advances only on acceptance.
   */
  checkAndUpdate(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
    sendNonce: number,
    recvNonce: number,
  ): { allowed: boolean; reason?: string } {
    if (!this._loaded) this.load();

    const key = this._getKey(peerNodeId, this._fingerprint(sessionKey));
    const now = Date.now();
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: Math.max(sendNonce, recvNonce),
        sendHighWater: sendNonce,
        recvHighWater: recvNonce,
        firstSeen: now,
        lastActivity: now,
      };
      this.save();
      return { allowed: true };
    }

    // A legacy entry has only highWaterMark. Defaulting to zero would accept a
    // reconnect at 1/1 against a persisted mark of 100 — the exact replay this
    // check exists to stop. Falling back to the aggregate fails closed instead.
    const sendMark = entry.sendHighWater ?? entry.highWaterMark;
    const recvMark = entry.recvHighWater ?? entry.highWaterMark;

    if (sendNonce <= sendMark) {
      return {
        allowed: false,
        reason: `Replayed or reused send nonce: got ${sendNonce}, high-water mark is ${sendMark}`,
      };
    }
    if (recvNonce <= recvMark) {
      return {
        allowed: false,
        reason: `Replayed or reused recv nonce: got ${recvNonce}, high-water mark is ${recvMark}`,
      };
    }

    entry.sendHighWater = sendNonce;
    entry.recvHighWater = recvNonce;
    // Both counters, not just recv: an accepted pair of 150/101 would otherwise
    // leave the aggregate at 101 and let checkNonce accept 120 afterwards.
    entry.highWaterMark = Math.max(entry.highWaterMark, sendNonce, recvNonce);
    entry.lastActivity = now;
    this.save();
    return { allowed: true };
  }

  /** The stored counters for a session, or null if it has never been seen. */
  getEntry(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
  ): NonceStateEntry | null {
    if (!this._loaded) this.load();
    return this.state.entries[this._getKey(peerNodeId, this._fingerprint(sessionKey))] ?? null;
  }

  /**
   * Claim a session key once and only once, globally by fingerprint. A repeat
   * means AES-GCM key reuse, so the connection is refused. The in-memory half
   * of this check is sessionKeyLRUSet in link.js.
   */
  claimSessionKey(
    peerNodeId: Uint8Array,
    sessionKeyFingerprint: string,
  ): { valid: boolean; reason?: string } {
    if (!this._loaded) this.load();

    // O(1), no I/O, and the common case for a peer that is reconnecting with a
    // key it has already burnt.
    if (this.claimLog.has(sessionKeyFingerprint)) {
      return {
        valid: false,
        reason: `Session key already used (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
      };
    }

    const peerHex = Buffer.from(peerNodeId).toString('hex');
    const record: ClaimRecord = {
      fingerprint: sessionKeyFingerprint,
      peerNodeId: peerHex,
      claimedAt: Date.now(),
    };

    // Durable (appended and fsynced) before success is reported. Without a key
    // yet, the record is held in memory until setEncryptionKey() writes it.
    const outcome = this.claimLog.append([record]);

    // A conflict means another process won the race for this fingerprint:
    // an ordinary reuse refusal, not a persistence failure.
    if (outcome.conflicts.length > 0) {
      logger.warn(
        'nonce-store',
        'claim-race-lost',
        `Session key claimed concurrently by another writer; refusing this one ` +
        `(fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { claimsFile: this.claimLog.path, peerNodeId: peerHex.slice(0, 16) }
      );
      return {
        valid: false,
        reason: `Session key already used (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…, ` +
                `claimed concurrently by another process)`,
      };
    }

    if (!outcome.ok) {
      logger.error(
        'nonce-store',
        'state-claim-persist-failed',
        `Rejecting session key claim: the claim could not be appended to ${this.claimLog.path} ` +
        `(${outcome.reason ?? 'failed'}), and a claim that is not on disk is a claim the next ` +
        `process will not honour (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { claimsFile: this.claimLog.path, peerNodeId: peerHex.slice(0, 16), reason: outcome.reason }
      );
      return {
        valid: false,
        reason: 'Session key claim could not be persisted; refusing the connection rather than ' +
                'accepting a key that would be re-accepted after a restart',
      };
    }

    return { valid: true };
  }

  checkNonce(peerNodeId: Uint8Array, sessionKeyFingerprint: string, nonce: number): { valid: boolean; reason?: string } {
    if (!this._loaded) {
      this.load();
    }

    const key = this._getKey(peerNodeId, sessionKeyFingerprint);
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: nonce,
        sendHighWater: nonce,
        recvHighWater: nonce,
        firstSeen: Date.now(),
        lastActivity: Date.now(),
      };
      this.save();
      return { valid: true };
    }

    if (nonce <= entry.highWaterMark) {
      return {
        valid: false,
        reason: `Reused or old nonce: received ${nonce}, high-water mark is ${entry.highWaterMark}`,
      };
    }

    // Raise the directional marks with the aggregate so checkAndUpdate stays consistent.
    const previousAggregate = entry.highWaterMark;
    entry.sendHighWater = Math.max(entry.sendHighWater ?? previousAggregate, nonce);
    entry.recvHighWater = Math.max(entry.recvHighWater ?? previousAggregate, nonce);
    entry.highWaterMark = Math.max(previousAggregate, nonce);
    entry.lastActivity = Date.now();
    this.save();
    return { valid: true };
  }

  close(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // Best effort: a failure here is already logged by _saveNow(), and there is
    // nothing left to refuse at shutdown.
    this._saveNow();
    // Leaves a current snapshot behind, so a clean stop never costs the next
    // start a replay of everything since the last threshold crossing.
    this.claimLog.close();
  }
}