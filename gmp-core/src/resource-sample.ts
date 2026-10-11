/**
 * Process resource self-measurement, logged by GMPNodeManager every
 * GMP_RESOURCE_LOG_INTERVAL_MS. Per-connection figures are deltas against the
 * startup baseline: (rss - baseline.rss) / links.
 */
import { admissionKey } from './rate-limiter.js';
import { countOpenFds, readFdLimits } from './fd-limits.js';

export interface ResourceSample {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  /** Open file descriptors (Linux /proc/self/fd); null where not readable. */
  openFds: number | null;
  /** Soft RLIMIT_NOFILE (Linux /proc/self/limits); null where not readable. */
  fdLimit: number | null;
  /** Hard RLIMIT_NOFILE; null where not readable or "unlimited". */
  fdHardLimit: number | null;
  /** Every link the node holds (pending, handshaking, connected). */
  links: number;
  connected: number;
  /**
   * Distinct admission keys among links and the most links behind one key.
   * Counts only; no address is logged.
   */
  distinctAddresses: number;
  maxLinksPerAddress: number;
}

export interface ResourceReport extends ResourceSample {
  /** (rss - baseline rss) / links; null with no links. */
  rssPerLinkBytes: number | null;
  /** (fds - baseline fds) / links; null with no links or no fd count. */
  fdsPerLink: number | null;
}

interface LinkHolder {
  links: Map<string, { state?: string; socket?: { remoteAddress?: string } | null }>;
}

/**
 * Open fds as a fraction of the soft limit, or null when unknown. libuv sheds
 * connections silently at the limit.
 */
export function fdPressure(s: Pick<ResourceSample, 'openFds' | 'fdLimit'>): number | null {
  return s.openFds !== null && s.fdLimit ? s.openFds / s.fdLimit : null;
}

export function sampleResources(node: LinkHolder): ResourceSample {
  const mem = process.memoryUsage();
  const limits = readFdLimits();
  let connected = 0;
  const perKey = new Map<string, number>();
  for (const link of node.links.values()) {
    if (link.state === 'connected') connected++;
    const key = admissionKey(link.socket?.remoteAddress);
    perKey.set(key, (perKey.get(key) || 0) + 1);
  }
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
    openFds: countOpenFds(),
    fdLimit: limits.soft,
    fdHardLimit: limits.hard,
    links: node.links.size,
    connected,
    distinctAddresses: perKey.size,
    maxLinksPerAddress: perKey.size ? Math.max(...perKey.values()) : 0,
  };
}

export function reportAgainst(baseline: ResourceSample, now: ResourceSample): ResourceReport {
  const per = (a: number | null, b: number | null): number | null =>
    now.links > 0 && a !== null && b !== null ? Math.round(((a - b) / now.links) * 100) / 100 : null;
  return {
    ...now,
    rssPerLinkBytes: per(now.rssBytes, baseline.rssBytes),
    fdsPerLink: per(now.openFds, baseline.openFds),
  };
}
