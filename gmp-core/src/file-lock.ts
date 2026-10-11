import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from './logger.js';

/** How long to keep trying before giving up and letting the caller fail closed. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Age after which a lock with a dead owner is treated as debris. */
const DEFAULT_STALE_MS = 30_000;

/** Gap between acquisition attempts. */
const RETRY_INTERVAL_MS = 25;

/** Age after which a `.break` lock is debris (its holder died mid-break). */
const BREAK_STALE_MS = 10_000;

interface LockRecord {
  pid: number;
  hostname: string;
  acquiredAt: number;
  /** Random per acquisition: release removes the lock only while it is still ours. */
  token?: string;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number, holder: LockRecord | null) {
    const held = holder
      ? ` It is held by pid ${holder.pid} on ${holder.hostname}, acquired ${new Date(holder.acquiredAt).toISOString()}.`
      : '';
    super(`Could not acquire ${lockPath} within ${timeoutMs}ms.${held}`);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Synchronous sleep via Atomics.wait. The lock is taken from synchronous
 * handshake code, so the retry loop cannot yield to the event loop.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
    if (typeof parsed?.pid === 'number' && typeof parsed?.acquiredAt === 'number') return parsed;
    return null;
  } catch {
    // Absent, unreadable, or half-written.
    return null;
  }
}

/** Milliseconds since the lock file was last written, or null if it is gone. */
function fileAgeMs(p: string): number | null {
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Is this lock debris? Requires age and a dead owner; a lock from another host
 * is broken on age alone. An unreadable (just-created) lock is stale only once
 * its mtime is older than `staleMs`.
 */
function isStale(lockPath: string, record: LockRecord | null, staleMs: number): boolean {
  if (!record) {
    const age = fileAgeMs(lockPath);
    return age !== null && age > staleMs;
  }

  const age = Date.now() - record.acquiredAt;
  // A future-stamped lock (clock step) is only eligible; on this host the owner
  // must still be dead.
  if (Math.abs(age) <= staleMs) return false;

  if (record.hostname !== os.hostname()) return true;

  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. It throws ESRCH when no such process exists.
    process.kill(record.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function sameRecord(a: LockRecord | null, b: LockRecord | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.hostname === b.hostname && a.acquiredAt === b.acquiredAt && a.token === b.token;
}

/**
 * Remove a stale lock if it is still the same one. Breakers serialise through
 * `<lock>.break` (O_EXCL) so one breaker never deletes another's fresh lock.
 * Returns true when a lock was removed.
 */
function breakStaleLock(lockPath: string, observed: LockRecord | null, staleMs: number): boolean {
  const breakPath = `${lockPath}.break`;
  try {
    fs.closeSync(fs.openSync(breakPath, 'wx'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const age = fileAgeMs(breakPath);
    if (age !== null && age > BREAK_STALE_MS) {
      try { fs.unlinkSync(breakPath); } catch { /* someone else cleared it */ }
    }
    return false; // another waiter is breaking it; retry the lock
  }
  try {
    const current = readLock(lockPath);
    if (!sameRecord(current, observed) || !isStale(lockPath, current, staleMs)) return false;
    logger.warn(
      'file-lock',
      'stale-lock-broken',
      `Removing a stale lock at ${lockPath}` +
      (current ? ` left by pid ${current.pid} on ${current.hostname}` : ' with no readable owner'),
      { lockPath, ...(current ? { pid: current.pid, hostname: current.hostname } : {}) },
    );
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    return true;
  } finally {
    try { fs.unlinkSync(breakPath); } catch { /* already gone */ }
  }
}

/**
 * Run `fn` holding an exclusive lock on `targetPath` (open O_CREAT|O_EXCL).
 * Throws LockTimeoutError if the lock is still held at the timeout, so callers
 * can fail closed.
 *
 * Residual: a lock held from another host is broken on age alone.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS }: {
    timeoutMs?: number;
    staleMs?: number;
  } = {},
): T {
  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomBytes(12).toString('hex');
  let acquired = false;
  let lastSeen: LockRecord | null = null;

  while (!acquired) {
    try {
      const record: LockRecord = { pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now(), token };
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY: it fails if anything is already there.
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      lastSeen = readLock(lockPath);
      if (isStale(lockPath, lastSeen, staleMs) && breakStaleLock(lockPath, lastSeen, staleMs)) continue;

      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs, lastSeen);
      sleepSync(RETRY_INTERVAL_MS);
    }
  }

  try {
    return fn();
  } finally {
    // Remove the lock only while it is still ours: deleting by path alone let
    // a holder whose lock had been taken over delete the new holder's lock,
    // and the overlap cascaded.
    const current = readLock(lockPath);
    if (current && current.token === token) {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    } else {
      logger.error('file-lock', 'lock-lost',
        `Lock at ${lockPath} was no longer ours at release; another process may have run concurrently`,
        { lockPath });
    }
  }
}
