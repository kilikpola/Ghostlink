/**
 * Durable monotonic boot counter for EphemeralKeySource.
 *
 * Write-ahead: read N, durably persist N+1, return N+1. The first value is 1,
 * so 0 never names a boot. A crash after persisting skips a value but never
 * reuses one; a failed persist throws and the node refuses to handshake.
 *
 * Residual risk: restoring or deleting the file rolls the counter back and
 * re-issues used values until it climbs past them again.
 */

import fs from 'fs';
import { writeFileAtomicSync } from './atomic-file.js';
import { withFileLock } from './file-lock.js';
import logger from './logger.js';

export class BootCounterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BootCounterError';
  }
}

/**
 * Read the stored counter N (0 if no file), durably persist N+1 under a file
 * lock, and return N+1. Throws BootCounterError if the file is unreadable or
 * invalid (left untouched for inspection), the write fails, or the lock cannot
 * be taken.
 */
export function advanceBootCounter(file: string): bigint {
  try {
    return withFileLock(file, () => {
      let current = 0n;
      if (fs.existsSync(file)) {
        let raw: string;
        try {
          raw = fs.readFileSync(file, 'utf8').trim();
        } catch (e) {
          throw refuse(file, `could not be read (${(e as Error).message})`, e);
        }
        if (!/^\d+$/.test(raw)) throw refuse(file, 'does not hold a counter');
        current = BigInt(raw);
      }
      const next = current + 1n;
      try {
        writeFileAtomicSync(file, `${next}\n`);
      } catch (e) {
        throw new BootCounterError(`could not persist the boot counter to ${file}; refusing to derive ephemeral keys under an uncommitted counter`, e);
      }
      return next;
    });
  } catch (e) {
    if (e instanceof BootCounterError) throw e;
    throw new BootCounterError(`could not lock the boot counter at ${file}; refusing to derive ephemeral keys under an unserialised counter`, e);
  }
}

function refuse(file: string, why: string, cause?: unknown): BootCounterError {
  const message =
    `Boot counter at ${file} ${why}. Restarting it at 0 would re-issue counters already used ` +
    `(a silent rollback), so this node refuses to derive ephemeral keys. The file has not been ` +
    `modified; move it aside to start the counter over deliberately.`;
  logger.error('boot-counter', 'boot-counter-unusable', message, { file });
  return new BootCounterError(message, cause);
}
