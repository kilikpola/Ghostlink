import fs from 'fs';
import crypto from 'crypto';
import { DEFAULTS } from './config-defaults.js';
import logger from './logger.js';
import { withFileLock } from './file-lock.js';
import { writeFileAtomicSync, cleanStaleTempFiles } from './atomic-file.js';
import { refuse } from './state-refusal.js';

/**
 * Append-only log of session-key claims. Claims are permanent, so appending
 * keeps each claim O(1) instead of rewriting the whole set.
 *
 * Record framing:
 *   [4 bytes big-endian length][IV(12) ‖ GCM tag(16) ‖ ciphertext]
 *
 * Each record authenticates on its own, so damage cannot invalidate earlier
 * records, and a half-written tail is detected exactly by its length prefix.
 */

/** Binds a record to this log, so one cannot be spliced in from another file. */
const RECORD_AAD = Buffer.from('gmp-nonce-claim-v1');
/** A different context for the checkpoint, so the two can never be confused. */
const CHECKPOINT_AAD = Buffer.from('gmp-nonce-ckpt-v1');
const CHECKPOINT_VERSION = 2;

/** Bytes before `coveredBytes` digested to tie a checkpoint to its log. */
const CHECKPOINT_ANCHOR_BYTES = 4096;

/** Check the consumedBytes invariant after every mutation (GMP_DEBUG_ASSERTS). */
export const DEBUG_ASSERTS = /^(1|true)$/i.test(process.env.GMP_DEBUG_ASSERTS ?? '');
const ASSERT_BOUNDARIES = DEBUG_ASSERTS;

/** Above this size the boundary check skips the full framing walk. */
const DEEP_ASSERT_MAX_BYTES = 1024 * 1024;

/** Records allowed past the checkpoint before a new one is written (~1s of replay). */
const CHECKPOINT_EVERY_RECORDS = 25_000;

/**
 * Tail length at which a checkpoint is written inline rather than deferred, so
 * the replay bound never depends on the event loop yielding.
 */
const CHECKPOINT_CEILING_RECORDS = CHECKPOINT_EVERY_RECORDS * 2;

const LENGTH_PREFIX_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A longer declared record means broken framing, not a truncated file. */
const MAX_RECORD_BYTES = 64 * 1024;

/** Compact only when the log is both large and provably redundant. */
const COMPACT_MIN_BYTES = 8 * 1024 * 1024;
const COMPACT_MIN_REDUNDANCY = 0.1;

interface ClaimPayload {
  /** Session-key fingerprint. The identity of the claim. */
  f: string;
  /** Hex NodeID of the peer it was first claimed with. Diagnostic only. */
  p: string;
  /** Claim timestamp, epoch ms. */
  t: number;
}

/** Why _consumeTail stopped; decides what append() may do next. */
type TailState =
  /** Every byte parsed as a complete, authentic record. */
  | 'clean'
  /** A final record was still being written when a process stopped. Ordinary. */
  | 'partial'
  /** A record failed authentication, or a length header was not plausible. */
  | 'corrupt'
  /**
   * The file could not be read (EMFILE, EACCES, EIO...). Says nothing about its
   * contents and must never be treated as damage.
   */
  | 'unreadable';

export interface AppendOutcome {
  /** True when every requested fingerprint is claimed on disk afterwards. */
  ok: boolean;
  /**
   * Fingerprints another writer claimed first. For claimSessionKey this means
   * the race was lost; check it before `ok`.
   */
  conflicts: string[];
  /** Why `ok` is false. Absent when the only outcome was conflicts. */
  reason?: 'corrupt' | 'failed';
}

export interface ClaimRecord {
  fingerprint: string;
  peerNodeId: string;
  claimedAt: number;
}

export class ClaimLog {
  private basePath: string;
  private filePath: string;
  private encryptionKey: Buffer | null;
  private index: Set<string>;
  /** Claims taken before a key existed, waiting for one so they can be written. */
  private pending: ClaimRecord[];
  /** Bytes of the log already folded into the index, for incremental reloads. */
  private consumedBytes: number;
  /**
   * Independent witness for consumedBytes: advanced only by verified record
   * lengths, never read from the filesystem.
   */
  private bytesAccountedFor: number;
  private lockTimeoutMs: number;
  private sawCorruption: boolean;
  /** Records folded in so far, duplicates included — the redundancy signal. */
  private recordsSeen: number;
  /** Records already represented by the checkpoint, so the tail can be sized. */
  private checkpointedRecords: number;
  private checkpointPath: string;
  private checkpointTimer: NodeJS.Timeout | null;
  private readonly strictState: boolean;

  constructor({ filePath, encryptionKey = null, lockTimeoutMs = 5000, strictState }: {
    filePath: string;
    encryptionKey?: Buffer | null;
    lockTimeoutMs?: number;
    /** Refuse a log that fails authentication instead of quarantining it (GMP_STRICT_STATE). */
    strictState?: boolean;
  }) {
    this.strictState = strictState ?? DEFAULTS.GMP_STRICT_STATE;
    this.basePath = filePath;
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.index = new Set();
    this.pending = [];
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.lockTimeoutMs = lockTimeoutMs;
    this.sawCorruption = false;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.checkpointTimer = null;
    this._scopePathToKey();
    cleanStaleTempFiles(this.filePath);
    cleanStaleTempFiles(this.checkpointPath);
  }

  /** How many distinct fingerprints are claimed. */
  get size(): number {
    return this.index.size;
  }

  get path(): string {
    return this.filePath;
  }

  /** True once a record has failed authentication; the tail after it is untrusted. */
  get corrupt(): boolean {
    return this.sawCorruption;
  }

  has(fingerprint: string): boolean {
    return this.index.has(fingerprint);
  }

  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    // A new key means a different file entirely; anything already consumed was
    // read under different terms.
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.sawCorruption = false;
    this._scopePathToKey();
  }

  /**
   * The log file for `encryptionKey`: one log per identity, suffixed with a
   * domain-separated key digest, so identities sharing a directory never share
   * a claim log.
   */
  static scopedPath(basePath: string, encryptionKey: Buffer | null): string {
    if (!encryptionKey) return basePath;
    const id = crypto.createHash('sha256')
      .update('gmp-claim-log-id')
      .update(encryptionKey)
      .digest('hex')
      .slice(0, 16);
    const suffix = basePath.endsWith('.log') ? basePath.slice(0, -4) : basePath;
    return `${suffix}.${id}.log`;
  }

  private _scopePathToKey(): void {
    this.filePath = ClaimLog.scopedPath(this.basePath, this.encryptionKey);
    this.checkpointPath = `${this.filePath}.ckpt`;
    cleanStaleTempFiles(this.filePath);
    cleanStaleTempFiles(this.checkpointPath);
  }

  private _seal(record: ClaimRecord): Buffer {
    const payload: ClaimPayload = { f: record.fingerprint, p: record.peerNodeId, t: record.claimedAt };
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
    cipher.setAAD(RECORD_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const body = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

    const framed = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
    framed.writeUInt32BE(body.length, 0);
    body.copy(framed, LENGTH_PREFIX_BYTES);
    return framed;
  }

  private _open(body: Buffer): ClaimRecord | null {
    const iv = body.subarray(0, IV_BYTES);
    const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
      decipher.setAAD(RECORD_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plaintext) as ClaimPayload;
      if (!parsed || typeof parsed.f !== 'string' || !parsed.f) return null;
      return { fingerprint: parsed.f, peerNodeId: String(parsed.p ?? ''), claimedAt: Number(parsed.t) || 0 };
    } catch {
      return null;
    }
  }

  /**
   * A record that will not authenticate. Earlier records stay indexed; reading
   * stops here because later framing cannot be trusted.
   */
  private _onCorruptRecord(offset: number): void {
    this.sawCorruption = true;
    logger.error(
      'nonce-store',
      'state-claim-log-corrupt',
      `Session key claim log ${this.filePath} fails authentication at byte ${offset}; ` +
      `${this.index.size} claims before that point are intact, everything after is being ignored. ` +
      `Session keys recorded in the ignored tail would be accepted again.`,
      { claimsFile: this.filePath, offset, recovered: this.index.size, strict: this.strictState }
    );
    if (this.strictState) {
      throw refuse({
        what: `the session-key claim log fails authentication from byte ${offset}; the ${this.index.size} claims before it are intact.`,
        file: this.filePath,
        action: 'move-aside',
        cause: 'the file was damaged (an interrupted write, a disk error) or edited. Not a seed change: each seed has its own claim log file.',
        loses: 'EVERY session-key claim in the log, the intact ones included: a session key this node already used would be accepted again (replay protection across restarts, invariant I1).',
        alternative: `start ONCE with GMP_STRICT_STATE=false (then remove it again). The node moves the damaged log aside itself (renamed, not deleted) and carries the ${this.index.size} intact claims into a fresh log; only claims after byte ${offset} are lost.`,
      });
    }
  }

  /**
   * Fold the log into the in-memory index. Incremental; a file that shrank was
   * replaced and is re-read from the start.
   */
  load(): void {
    if (!this.encryptionKey) return;

    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // no log yet
    }

    if (size < this.consumedBytes) {
      // The file shrank, so it is not the one this index was built from —
      // compaction, or an operator. Start over.
      this._reset();
    }

    // A cold start begins from the checkpoint when there is a usable one, so
    // only the records appended since it have to be decrypted individually.
    if (this.consumedBytes === 0 && this.index.size === 0) {
      this._applyCheckpoint(size);
    }

    const state = this._consumeTail(size);

    if (state === 'unreadable') {
      // Nothing was read, so nothing may be rebuilt from what is in memory.
      this._onUnreadableLog();
      return;
    }

    if (state === 'corrupt') {
      // Under strict mode _onCorruptRecord has already thrown. Here the choice
      // is between a node that cannot complete a handshake and one that keeps
      // the claims it could read; the damaged file is preserved either way.
      this._quarantineCorruptLog();
    }

    if (this.recordsSeen - this.checkpointedRecords >= CHECKPOINT_EVERY_RECORDS) {
      this._writeCheckpoint();
    }
  }

  private _reset(): void {
    this.index.clear();
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.sawCorruption = false;
    this._assertConsumedBoundary('reset');
  }

  /**
   * Check that `consumedBytes` still names the end of a record:
   *   1. it matches the bytesAccountedFor witness (O(1));
   *   2. it lies within the file and a plausible length header starts there;
   *   3. on small logs, the framing walk from zero lands exactly on it.
   * Throws under test; logs CRITICAL in production.
   */
  private _assertConsumedBoundary(context: string): void {
    if (!ASSERT_BOUNDARIES) return;

    const problems: string[] = [];

    if (this.consumedBytes !== this.bytesAccountedFor) {
      problems.push(
        `offset is ${this.consumedBytes} but only ${this.bytesAccountedFor} bytes have been accounted ` +
        `for as verified records`,
      );
    }

    let size: number | null = null;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      size = null; // no log yet, or unreadable; the checks below need one
    }

    if (size !== null) {
      if (this.consumedBytes > size) {
        problems.push(`offset ${this.consumedBytes} is past the end of a ${size} byte file`);
      } else if (this.consumedBytes < size && !this.sawCorruption) {
        // Skipped once corruption has been seen: the offset is then the last
        // good boundary by construction, and the bytes after it are the damage
        // itself. Demanding a record header there would flag the handled case.
        const header = this._readAt(this.consumedBytes, Math.min(LENGTH_PREFIX_BYTES, size - this.consumedBytes));
        if (!header || header.length < LENGTH_PREFIX_BYTES) {
          problems.push(`could not read a length header at offset ${this.consumedBytes}`);
        } else {
          const bodyLength = header.readUInt32BE(0);
          if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) {
            problems.push(
              `offset ${this.consumedBytes} is not the start of a record: the length there is ${bodyLength}`,
            );
          }
        }
      }

      if (size <= DEEP_ASSERT_MAX_BYTES && problems.length === 0) {
        const walked = this._walkFramingTo(this.consumedBytes, size);
        if (walked !== this.consumedBytes) {
          problems.push(
            `walking the framing from zero lands on ${walked}, not ${this.consumedBytes}`,
          );
        }
      }
    }

    if (problems.length === 0) return;

    const message =
      `Claim log offset invariant violated after ${context}: ${problems.join('; ')}. ` +
      `Claims recorded past this point would be silently lost.`;

    if (DEBUG_ASSERTS) {
      throw new Error(message);
    }
    logger.critical('nonce-store', 'claim-log-offset-invariant', message, {
      claimsFile: this.filePath,
      context,
      consumedBytes: this.consumedBytes,
      bytesAccountedFor: this.bytesAccountedFor,
    });
  }

  /** A short read from the log, or null if it could not be satisfied in full. */
  private _readAt(offset: number, length: number): Buffer | null {
    if (length <= 0) return null;
    try {
      const buffer = Buffer.allocUnsafe(length);
      const fd = fs.openSync(this.filePath, 'r');
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      return read < length ? null : buffer;
    } catch {
      return null;
    }
  }

  /**
   * Follow the record framing from the start of the file and report the last
   * boundary at or before `limit`. Reads length prefixes only.
   */
  private _walkFramingTo(limit: number, size: number): number {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.filePath);
    } catch {
      return limit; // cannot read it; the other checks stand on their own
    }
    if (buffer.length !== size) return limit;

    let offset = 0;
    while (offset < limit && offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);
      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) break;
      const next = offset + LENGTH_PREFIX_BYTES + bodyLength;
      if (next > buffer.length) break;
      offset = next;
    }
    return offset;
  }

  /**
   * Fold records between `consumedBytes` and `size` into the index. append()
   * uses it to catch up on other processes' writes first.
   */
  private _consumeTail(size: number): TailState {
    if (size <= this.consumedBytes) return 'clean';

    let buffer: Buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = size - this.consumedBytes;
        buffer = Buffer.allocUnsafe(length);
        // readSync may return fewer bytes than asked for without throwing. The
        // buffer is uninitialized memory, so parsing past what was actually
        // read would interpret whatever happened to be on the heap as records.
        const read = fs.readSync(fd, buffer, 0, length, this.consumedBytes);
        if (read < length) buffer = buffer.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-log-read-failed',
        `Could not read the claim log: ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return 'unreadable';
    }

    let state: TailState = 'clean';
    let offset = 0;
    while (offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);

      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) {
        // Not a plausible record header. A short tail is ordinary; a nonsense
        // length is the framing having come apart.
        state = 'corrupt';
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }
      if (offset + LENGTH_PREFIX_BYTES + bodyLength > buffer.length) {
        // The tail is a record that was still being written when the process
        // stopped. Normal, and silent: it was never a completed claim.
        state = 'partial';
        break;
      }

      const body = buffer.subarray(offset + LENGTH_PREFIX_BYTES, offset + LENGTH_PREFIX_BYTES + bodyLength);
      const record = this._open(body);
      if (!record) {
        state = 'corrupt';
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }

      this.index.add(record.fingerprint);
      this.recordsSeen++;
      offset += LENGTH_PREFIX_BYTES + bodyLength;
    }

    // Advance to the end of the last authenticated record, never to the file
    // length: the file may end in a partial record.
    this.consumedBytes += offset;
    this.bytesAccountedFor += offset;
    this._assertConsumedBoundary('consumeTail');
    return state;
  }

  /**
   * The claim log exists but cannot be read. Nothing is rebuilt or renamed, but
   * it is an ERROR and fatal under strict mode.
   */
  private _onUnreadableLog(): void {
    logger.error(
      'nonce-store',
      'state-log-unreadable',
      `Session key claim log ${this.filePath} exists but could not be read; this node has no record of ` +
      `which session keys have already been used, and would accept every one of them again. The file ` +
      `has not been modified.`,
      { claimsFile: this.filePath, strict: this.strictState },
    );
    if (this.strictState) {
      throw refuse({
        what: 'the session-key claim log exists but could not be read; without it this node would accept session keys it has already used.',
        file: this.filePath,
        action: 'fix-access',
      });
    }
  }

  /**
   * Rename a log that will not authenticate (e.g. after a seed rotation) and
   * start a fresh one with the fingerprints that could still be read. Without
   * this a corrupt log blocks every handshake.
   */
  private _quarantineCorruptLog(): boolean {
    if (!this.encryptionKey) return false;

    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
    const recovered = [...this.index];

    let rebuiltSize = 0;
    try {
      withFileLock(this.filePath, () => {
        fs.renameSync(this.filePath, quarantinePath);
        const rebuilt = Buffer.concat(
          recovered.map(fingerprint => this._seal({ fingerprint, peerNodeId: '', claimedAt: Date.now() })),
        );
        if (rebuilt.length > 0) writeFileAtomicSync(this.filePath, rebuilt);
        // Measured under the lock, so no record appended in between is skipped.
        rebuiltSize = rebuilt.length;
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.error(
        'nonce-store',
        'claim-log-quarantine-failed',
        `Could not set aside the corrupt claim log: ${(err as Error).message}. Claims cannot be ` +
        `recorded until ${this.filePath} is moved away by hand.`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return false;
    }

    logger.error(
      'nonce-store',
      'claim-log-quarantined',
      `Moved the unreadable claim log to ${quarantinePath} and rebuilt it from the ${recovered.length} ` +
      `claim(s) that could still be authenticated. Any claim recorded past the damage is gone, and the ` +
      `session keys it held would now be accepted again. If the seed phrase was not changed, treat this ` +
      `as tampering and inspect the quarantined file.`,
      { claimsFile: this.filePath, quarantinePath, recovered: recovered.length },
    );

    this.sawCorruption = false;
    this.recordsSeen = recovered.length;
    this.checkpointedRecords = 0;
    this.consumedBytes = rebuiltSize;
    this.bytesAccountedFor = rebuiltSize;
    this._assertConsumedBoundary('quarantine');
    this._writeCheckpoint();
    return true;
  }

  /**
   * Append claims under the lock, fsync, then index them. Without a key the
   * records are indexed and queued in memory until flushPending().
   */
  append(records: ClaimRecord[]): AppendOutcome {
    if (records.length === 0) return { ok: true, conflicts: [] };

    if (!this.encryptionKey) {
      // Nothing is persisted yet, so this process's own index is the whole
      // truth and no other writer can be racing it.
      const conflicts = records.filter(r => this.index.has(r.fingerprint)).map(r => r.fingerprint);
      for (const record of records) {
        if (this.index.has(record.fingerprint)) continue;
        this.pending.push(record);
        this.index.add(record.fingerprint);
      }
      return { ok: true, conflicts };
    }

    let outcome: AppendOutcome = { ok: true, conflicts: [] };

    try {
      withFileLock(this.filePath, () => {
        // Catch up on other processes' appends before advancing consumedBytes.
        let state: TailState = 'clean';
        try {
          state = this._consumeTail(fs.statSync(this.filePath).size);
        } catch {
          /* no log yet; nothing to catch up on */
        }

        if (state === 'unreadable') {
          // The log may be perfectly intact; this process just could not read
          // it. Reported as a write failure so the caller refuses the claim and
          // the next attempt tries again, rather than as damage.
          logger.error(
            'nonce-store',
            'claim-log-append-blocked',
            `Refusing to append ${records.length} session key claim(s): the claim log could not be read, ` +
            `so a new record cannot be placed safely. The file is untouched.`,
            { claimsFile: this.filePath, count: records.length },
          );
          outcome = { ok: false, conflicts: [], reason: 'failed' };
          return;
        }

        if (state === 'corrupt') {
          // Never append behind an unauthenticated record.
          logger.error(
            'nonce-store',
            'claim-log-append-blocked',
            `Refusing to append ${records.length} session key claim(s): the claim log is corrupt, so a ` +
            `new record could not be read back. The damaged file is left untouched for inspection; move ` +
            `${this.filePath} aside to start a fresh log, accepting that the session keys it recorded ` +
            `would then be accepted again.`,
            { claimsFile: this.filePath, count: records.length },
          );
          outcome = { ok: false, conflicts: [], reason: 'corrupt' };
          return;
        }

        // The authoritative at-most-once check, under the lock.
        const conflicts: string[] = [];
        const fresh: ClaimRecord[] = [];
        for (const record of records) {
          if (this.index.has(record.fingerprint)) conflicts.push(record.fingerprint);
          else fresh.push(record);
        }

        if (fresh.length === 0) {
          outcome = { ok: true, conflicts };
          return;
        }

        if (state === 'partial') {
          // A partial record from an interrupted write was never acknowledged;
          // drop it so new records are not appended past it.
          fs.truncateSync(this.filePath, this.consumedBytes);
          logger.debug(
            'nonce-store',
            'claim-log-partial-discarded',
            `Discarded an incomplete trailing record before appending.`,
            { claimsFile: this.filePath, truncatedTo: this.consumedBytes },
          );
        }

        const framed = Buffer.concat(fresh.map(r => this._seal(r)));
        const fd = fs.openSync(this.filePath, 'a', 0o600);
        try {
          fs.writeSync(fd, framed);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }

        // Verify the offset lands on the new record boundary.
        const expected = this.consumedBytes + framed.length;
        const actual = fs.statSync(this.filePath).size;
        if (actual !== expected) {
          logger.error(
            'nonce-store',
            'claim-log-offset-mismatch',
            `Claim log is ${actual} bytes after appending but ${expected} was expected; ` +
            `re-reading it from the start rather than trusting the offset.`,
            { claimsFile: this.filePath, expected, actual },
          );
          // Re-read from the start, but keep the index: these fingerprints were
          // acknowledged to callers and must stay unusable. Over-claiming is
          // the safe direction; forgetting a claim is not.
          this.consumedBytes = 0;
          this.bytesAccountedFor = 0;
          this.recordsSeen = 0;
          this.checkpointedRecords = 0;
          for (const record of fresh) this.index.add(record.fingerprint);
          this._assertConsumedBoundary('append-offset-mismatch');
        } else {
          this.consumedBytes = expected;
          this.bytesAccountedFor += framed.length;
          for (const record of fresh) this.index.add(record.fingerprint);
          this.recordsSeen += fresh.length;
          this._assertConsumedBoundary('append');
        }

        outcome = { ok: true, conflicts };
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.error(
        'nonce-store',
        'claim-log-append-failed',
        `Could not append ${records.length} session key claim(s): ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return { ok: false, conflicts: [], reason: 'failed' };
    }

    if (outcome.ok) this._maybeScheduleCheckpoint();
    return outcome;
  }

  /**
   * Schedule a checkpoint once enough claims have accumulated. Deferred off the
   * handshake path on an unref'd timer.
   */
  private _maybeScheduleCheckpoint(): void {
    const tail = this.recordsSeen - this.checkpointedRecords;
    if (tail < CHECKPOINT_EVERY_RECORDS) return;

    if (tail >= CHECKPOINT_CEILING_RECORDS) {
      // The deferred write has not had a turn — a synchronous burst, or a
      // process too busy to reach the timer. Pay for it here rather than let
      // the replay bound quietly stop being true.
      if (this.checkpointTimer) {
        clearTimeout(this.checkpointTimer);
        this.checkpointTimer = null;
      }
      this._writeCheckpoint();
      return;
    }

    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      this._writeCheckpoint();
    }, 0);
    this.checkpointTimer.unref?.();
  }

  /** Write a checkpoint on shutdown, so a clean stop never needs a replay. */
  close(): void {
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this._writeCheckpoint();
  }

  /**
   * Write anything claimed before a key existed. A conflict counts as recorded;
   * only a write failure requeues.
   */
  flushPending(): boolean {
    if (this.pending.length === 0 || !this.encryptionKey) return true;
    const queued = this.pending;
    this.pending = [];

    // Unindex our own queued records so append() does not mistake them for
    // another writer's claims.
    for (const record of queued) this.index.delete(record.fingerprint);

    const outcome = this.append(queued);
    if (outcome.ok) {
      // A conflict here means another process claimed it first. The fingerprint
      // is claimed either way, which is all this caller needs; re-index any
      // that append() skipped so nothing is forgotten.
      for (const fingerprint of outcome.conflicts) this.index.add(fingerprint);
      return true;
    }

    // The write failed, so these go back exactly as they were: callers were
    // already told the claims succeeded, and the keys must stay unusable.
    for (const record of queued) this.index.add(record.fingerprint);
    this.pending = queued;
    return false;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Digest of the bytes ending at `coveredBytes`, so a checkpoint is only
   * trusted against the exact log it summarises.
   */
  private _anchorDigest(upTo: number): { length: number; digest: string } | null {
    if (upTo <= 0) return null;
    const length = Math.min(CHECKPOINT_ANCHOR_BYTES, upTo);
    try {
      const window = Buffer.allocUnsafe(length);
      const fd = fs.openSync(this.filePath, 'r');
      let read: number;
      try {
        read = fs.readSync(fd, window, 0, length, upTo - length);
      } finally {
        fs.closeSync(fd);
      }
      // A short read leaves uninitialized memory in the tail of the window,
      // which would digest to something different every time — a checkpoint
      // whose anchor never matches, forcing the full replay it exists to avoid.
      if (read < length) return null;
      return { length, digest: crypto.createHash('sha256').update(window).digest('hex') };
    } catch {
      return null;
    }
  }

  private _writeCheckpoint(): boolean {
    if (!this.encryptionKey || this.sawCorruption) return false;
    // Claims taken before a key existed are in the index but not yet in the
    // log. Snapshotting now would produce a checkpoint asserting claims that
    // the byte range it names does not contain.
    if (this.pending.length > 0) return false;

    try {
      const parts: Buffer[] = [];
      for (const fingerprint of this.index) {
        const bytes = Buffer.from(fingerprint, 'utf8');
        if (bytes.length === 0 || bytes.length > 255) {
          // Not representable in this format. Skipping it would produce a
          // checkpoint that silently under-reports the index, so abandon the
          // whole thing and let the log stay authoritative.
          return false;
        }
        const framed = Buffer.allocUnsafe(1 + bytes.length);
        framed.writeUInt8(bytes.length, 0);
        bytes.copy(framed, 1);
        parts.push(framed);
      }

      const anchor = this._anchorDigest(this.consumedBytes);
      if (!anchor) return false;   // nothing consumed yet; nothing worth pinning

      const header = Buffer.from(JSON.stringify({
        version: CHECKPOINT_VERSION,
        coveredBytes: this.consumedBytes,
        recordCount: this.recordsSeen,
        fingerprintCount: this.index.size,
        anchor,
        createdAt: Date.now(),
      }), 'utf8');

      const headerLength = Buffer.allocUnsafe(4);
      headerLength.writeUInt32BE(header.length, 0);
      const plaintext = Buffer.concat([headerLength, header, ...parts]);

      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      cipher.setAAD(CHECKPOINT_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      writeFileAtomicSync(this.checkpointPath, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-write-failed',
        `Could not write the claim checkpoint: ${(err as Error).message}`,
        { checkpointFile: this.checkpointPath, err: (err as Error).message },
      );
      return false;
    }

    this.checkpointedRecords = this.recordsSeen;
    logger.debug(
      'nonce-store',
      'claim-checkpoint-written',
      `Checkpointed ${this.index.size} session key claims at byte ${this.consumedBytes}.`,
      { checkpointFile: this.checkpointPath, claims: this.index.size, coveredBytes: this.consumedBytes },
    );
    return true;
  }

  /**
   * Seed the index from a trustworthy checkpoint. Falls back to a full replay
   * when the checkpoint fails to authenticate, has an unknown version, or covers
   * more bytes than the log (logged at ERROR: claims were removed).
   */
  private _applyCheckpoint(logSize: number): void {
    if (!this.encryptionKey) return;

    let sealed: Buffer;
    try {
      sealed = fs.readFileSync(this.checkpointPath);
    } catch {
      return; // no checkpoint; ordinary for a young log
    }

    let plaintext: Buffer;
    try {
      const iv = sealed.subarray(0, IV_BYTES);
      const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAAD(CHECKPOINT_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-unusable',
        `The claim checkpoint will not authenticate; replaying the full log instead.`,
        { checkpointFile: this.checkpointPath },
      );
      return;
    }

    try {
      const headerLength = plaintext.readUInt32BE(0);
      const header = JSON.parse(plaintext.subarray(4, 4 + headerLength).toString('utf8')) as {
        version: number; coveredBytes: number; recordCount: number; fingerprintCount: number;
        anchor?: { length: number; digest: string };
      };

      if (header.version !== CHECKPOINT_VERSION) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `Claim checkpoint is version ${header.version}, which this build does not read; replaying the full log.`,
          { checkpointFile: this.checkpointPath, version: header.version },
        );
        return;
      }

      if (header.coveredBytes > logSize) {
        logger.error(
          'nonce-store',
          'claim-log-shorter-than-checkpoint',
          `The claim log is ${logSize} bytes but the checkpoint covers ${header.coveredBytes}; ` +
          `the log has been shortened since it was written, and any claims in the missing ` +
          `${header.coveredBytes - logSize} bytes are no longer enforced. Replaying what remains.`,
          { claimsFile: this.filePath, checkpointFile: this.checkpointPath, logSize, coveredBytes: header.coveredBytes },
        );
        return;
      }

      // Does this checkpoint describe the log that is actually on disk?
      const anchor = this._anchorDigest(header.coveredBytes);
      if (!header.anchor || !anchor || anchor.digest !== header.anchor.digest) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `The claim checkpoint does not match the log it points into — the log has been replaced ` +
          `since it was written. Replaying the full log instead.`,
          { checkpointFile: this.checkpointPath, claimsFile: this.filePath, coveredBytes: header.coveredBytes },
        );
        return;
      }

      const restored = new Set<string>();
      let offset = 4 + headerLength;
      while (offset < plaintext.length) {
        const length = plaintext.readUInt8(offset);
        offset += 1;
        if (length === 0 || offset + length > plaintext.length) break;
        restored.add(plaintext.subarray(offset, offset + length).toString('utf8'));
        offset += length;
      }

      if (restored.size !== header.fingerprintCount) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `Claim checkpoint holds ${restored.size} fingerprints but declares ${header.fingerprintCount}; ` +
          `replaying the full log instead.`,
          { checkpointFile: this.checkpointPath },
        );
        return;
      }

      this.index = restored;
      this.consumedBytes = header.coveredBytes;
      this.bytesAccountedFor = header.coveredBytes;
      this.recordsSeen = header.recordCount;
      this.checkpointedRecords = header.recordCount;
      this._assertConsumedBoundary('applyCheckpoint');
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-unusable',
        `Claim checkpoint is malformed (${(err as Error).message}); replaying the full log instead.`,
        { checkpointFile: this.checkpointPath, err: (err as Error).message },
      );
      this._reset();
    }
  }

  /**
   * Rewrite the log with one record per fingerprint. Runs only at startup and
   * only when the log is large and redundant enough.
   */
  compactIfNeeded(): boolean {
    if (!this.encryptionKey || this.sawCorruption) return false;

    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return false;
    }
    if (size < COMPACT_MIN_BYTES) return false;

    // Redundancy is known from load(); no second read of the log.
    const redundancy = this.recordsSeen ? (this.recordsSeen - this.index.size) / this.recordsSeen : 0;
    if (redundancy < COMPACT_MIN_REDUNDANCY) return false;

    let compactedSize = 0;

    const records = this._readAll();
    if (!records) return false;

    const unique = new Map<string, ClaimRecord>();
    for (const record of records) {
      const seen = unique.get(record.fingerprint);
      // Keep the earliest sighting: it is when the key was actually burnt.
      if (!seen || record.claimedAt < seen.claimedAt) unique.set(record.fingerprint, record);
    }

    try {
      withFileLock(this.filePath, () => {
        // Re-read under the lock: another process may have appended between the
        // scan above and here, and those records must not be dropped.
        const current = this._readAll();
        if (current) {
          for (const record of current) {
            const seen = unique.get(record.fingerprint);
            if (!seen || record.claimedAt < seen.claimedAt) unique.set(record.fingerprint, record);
          }
        }
        const rebuilt = Buffer.concat([...unique.values()].map(r => this._seal(r)));
        writeFileAtomicSync(this.filePath, rebuilt);
        compactedSize = rebuilt.length;
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-log-compact-failed',
        `Could not compact the claim log: ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return false;
    }

    logger.info(
      'nonce-store',
      'claim-log-compacted',
      `Compacted the session key claim log: ${records.length} records reduced to ${unique.size} unique claims.`,
      { claimsFile: this.filePath, before: records.length, after: unique.size },
    );

    // The file was replaced, and now holds exactly the unique set. Every byte
    // offset the old checkpoint recorded refers to the log that no longer
    // exists, so it is replaced rather than left to be distrusted later.
    this.index = new Set(unique.keys());
    this.recordsSeen = unique.size;
    this.checkpointedRecords = 0;
    // As in the quarantine path: sized under the lock, never restatted after.
    this.consumedBytes = compactedSize;
    this.bytesAccountedFor = compactedSize;
    this._assertConsumedBoundary('compact');
    this._writeCheckpoint();
    return true;
  }

  /** Every record in the log, or null if it cannot be read in full. */
  private _readAll(): ClaimRecord[] | null {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.filePath);
    } catch {
      return null;
    }

    const records: ClaimRecord[] = [];
    let offset = 0;
    while (offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);
      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) break;
      if (offset + LENGTH_PREFIX_BYTES + bodyLength > buffer.length) break;
      const record = this._open(
        buffer.subarray(offset + LENGTH_PREFIX_BYTES, offset + LENGTH_PREFIX_BYTES + bodyLength),
      );
      if (!record) break;
      records.push(record);
      offset += LENGTH_PREFIX_BYTES + bodyLength;
    }
    return records;
  }
}
