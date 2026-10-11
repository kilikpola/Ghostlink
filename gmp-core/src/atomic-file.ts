import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Temp files older than this are assumed to be debris from a killed process. */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Replace a file's contents durably, or leave the previous contents untouched:
 * write a uniquely named temp file, fsync it, rename it over `filePath`, then
 * fsync the directory. On failure the temp file is removed and the error
 * rethrown with the original intact.
 *
 * This makes a single write atomic, not a read-modify-write; use withFileLock
 * (./file-lock.js) for that.
 */
export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  try {
    // 0600: these files hold replay state and peer history for this identity.
    // Readable-by-others is never needed, and the default (0666 & umask) made
    // them world-readable on a typical 022 umask. The mode survives the rename.
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Leave nothing half-written behind for the next start to trip over. If the
    // temp file is not there, or is a directory the caller planted, there is
    // nothing to clean up and the original error is the one worth reporting.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* nothing to remove */
    }
    throw err;
  }

  fsyncDirBestEffort(dir);
}

// Some platforms (Windows) cannot fsync a directory; never fail a completed write over it.
function fsyncDirBestEffort(dir: string): void {
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* directory fsync unsupported on this platform */
  }
}

/**
 * Delete a file durably: unlink, then fsync the directory. A missing file is
 * not an error.
 */
export function removeFileDurableSync(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  fsyncDirBestEffort(path.dirname(filePath));
}

/**
 * Best-effort removal of temp files for `filePath` left by dead writers. Only
 * files older than an hour are touched, so live writers are never disturbed.
 */
export function cleanStaleTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).mtimeMs < cutoff) fs.unlinkSync(candidate);
      } catch {
        /* vanished underneath us, or not ours to remove */
      }
    }
  } catch {
    /* directory unreadable or absent; nothing to sweep */
  }
}
