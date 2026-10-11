/**
 * Descriptor count and limits (Linux /proc; null elsewhere). Shared by the
 * resource log and the connection-cap clamp.
 */
import fs from 'fs';

/** Open file descriptors of this process, or null where /proc is not readable. */
export function countOpenFds(): number | null {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

/** Soft and hard RLIMIT_NOFILE from /proc/self/limits; nulls where unreadable or "unlimited". */
export function readFdLimits(): { soft: number | null; hard: number | null } {
  try {
    const line = fs.readFileSync('/proc/self/limits', 'utf8').split('\n').find((l) => l.startsWith('Max open files'));
    const [, soft, hard] = line ? line.split(/\s{2,}/) : [];
    const num = (v: string | undefined): number | null => {
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return { soft: num(soft), hard: num(hard) };
  } catch {
    return { soft: null, hard: null };
  }
}
