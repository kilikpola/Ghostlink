import fs from 'fs';
import type {
  PeerRole,
  PublicPeerEntry,
  BindingResponse,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';
import logger from './logger.js';
import { PUBLIC_PEERS_FILE, PUBLIC_PEERS_OVERLAY_FILES } from './paths.js';

/** NodeIDs that never load from any list: their keys are compromised. */
export const REVOKED_NODE_IDS: ReadonlySet<string> = new Set([
  // Railway public peer until 2026-10-10: its seed was disclosed.
  '52ab56117354cf7d7f12b8f2de7a428f50462f2146a9cf6c246b21b8c67f7ff357192573bd7944236472b49617edb4e4bff5e7aa8e8eeec1938235caf66afe59',
]);

const VALID_ROLES: ReadonlySet<PeerRole> = new Set(['bootstrap', 'relay', 'storage']);

/**
 * Normalise an entry's roles: absent means ["bootstrap"]; unknown values are
 * dropped, and an entry with no valid role is dropped.
 */
function withRoles(raw: unknown): PublicPeerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Omit<PublicPeerEntry, 'roles'> & { roles?: unknown; operator?: unknown };
  let roles: PeerRole[];
  if (entry.roles === undefined) {
    roles = ['bootstrap'];
  } else if (Array.isArray(entry.roles)) {
    roles = [...new Set(entry.roles.filter((r): r is PeerRole => typeof r === 'string' && VALID_ROLES.has(r as PeerRole)))];
  } else {
    roles = [];
  }
  if (roles.length === 0) {
    logger.warn('public-peer-list', 'entry-no-valid-role', `Ignoring public peer ${entry.address}:${entry.port}: no valid role`, { address: entry.address });
    return null;
  }
  const operator = typeof entry.operator === 'string' && entry.operator ? entry.operator : undefined;
  return { ...entry, roles, ...(operator ? { operator } : {}) } as PublicPeerEntry;
}

function readList(filePath: string): PublicPeerEntry[] {
  try {
    if (fs.existsSync(filePath)) {
      const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(data) ? data.map(withRoles).filter((p): p is PublicPeerEntry => p !== null) : [];
    }
  } catch (e: unknown) {
    const err = e as Error;
    logger.error('public-peer-list', 'load-failed', `Failed to load public peers from ${filePath}: ${err.message}`, { err: err.message, file: filePath });
  }
  return [];
}

/**
 * The public peer list. With a path: that file alone. Otherwise the shipped
 * list with overlays merged on top; a file listing a NodeID replaces every
 * entry for it from lower files. Within one file only exact repeats collapse.
 * Revoked NodeIDs are dropped.
 */
export function loadPublicPeers(filePath?: string): PublicPeerEntry[] {
  const files = filePath ? [filePath] : [PUBLIC_PEERS_FILE, ...PUBLIC_PEERS_OVERLAY_FILES];
  const byId = new Map<string, PublicPeerEntry[]>();
  for (const f of files) {
    const fromThisFile = new Map<string, PublicPeerEntry[]>();
    for (const e of readList(f)) {
      const id = typeof e.nodeId === 'string' && e.nodeId ? e.nodeId.toLowerCase() : `${e.address}:${e.port}`;
      if (REVOKED_NODE_IDS.has(id)) {
        logger.warn('public-peer-list', 'revoked-entry', `Ignoring public peer ${e.address}:${e.port}: its NodeID is revoked`, { file: f });
        continue;
      }
      const list = fromThisFile.get(id) ?? [];
      if (!list.some((x) => x.address === e.address && x.port === e.port)) list.push(e);
      fromThisFile.set(id, list);
    }
    for (const [id, list] of fromThisFile) byId.set(id, list);
  }
  for (const [id, list] of byId) {
    const roles = new Set(list.flatMap((e) => e.roles));
    if (roles.size > 1 && !warnedMultiRole.has(id)) {
      // One host, one role (PROTOCOL_SPEC §15.8): never a valid production
      // list. Kept, not dropped — hiding a name from the separation rules is
      // the dangerous direction; they refuse the second use.
      warnedMultiRole.add(id);
      logger.warn('public-peer-list', 'one-host-several-roles',
        `Public peer ${id.slice(0, 16)}… is listed with roles ${[...roles].join(' and ')} (${list.map((e) => `${e.address}:${e.port}`).join(', ')}): one host may serve one role; only the first use this session will be allowed`,
        { nodeId: id, roles: [...roles] });
    }
  }
  return [...byId.values()].flat();
}

const warnedMultiRole = new Set<string>();

/**
 * Every NodeID any list file gives for this address (lowercase hex), unmerged.
 * For role separation only; pinning uses loadPublicPeers.
 */
export function listedNodeIdsForAddress(address: string, port: number, filePath?: string): string[] {
  const files = filePath ? [filePath] : [PUBLIC_PEERS_FILE, ...PUBLIC_PEERS_OVERLAY_FILES];
  const want = `${String(address).toLowerCase()}:${port}`;
  const ids = new Set<string>();
  for (const f of files) {
    for (const e of readList(f)) {
      if (typeof e.nodeId !== 'string' || !e.nodeId) continue;
      const id = e.nodeId.toLowerCase();
      if (!REVOKED_NODE_IDS.has(id) && `${String(e.address).toLowerCase()}:${e.port}` === want) ids.add(id);
    }
  }
  return [...ids];
}

/** Validate a peer-chosen BINDING_RESPONSE: an address string and a TCP port. */
export function isBindingResponse(info: unknown): info is BindingResponse {
  if (!info || typeof info !== 'object') return false;
  const { address, port } = info as { address?: unknown; port?: unknown };
  return typeof address === 'string' && address.length > 0 && address.length <= 255
    && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export async function querySinglePeer(
  node: GMPNodeLike,
  peer: PublicPeerEntry,
  timeoutMs: number = 5000
): Promise<BindingResponse> {
  return new Promise((resolve, reject) => {
    let link: GMPLinkLike | null = null;
    let finished = false;

    const timeoutTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (link) {
        link.destroy(new Error('Query timeout'));
      }
      reject(new Error(`Timeout querying peer ${peer.address}:${peer.port}`));
    }, timeoutMs);

    node.dial(peer.address, peer.port, { tls: peer.tls === true || peer.port === 443, nodeId: peer.nodeId, infrastructure: { operator: peer.operator ?? null } })
      .then(({ link: activeLink }) => {
        if (finished) {
          activeLink.destroy();
          return;
        }
        link = activeLink;

        activeLink.once('binding-response', (info: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          if (isBindingResponse(info)) {
            resolve(info);
          } else {
            reject(new Error('Malformed BINDING_RESPONSE'));
          }
        });

        activeLink.once('error', (err: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          reject(err as Error);
        });

        activeLink.once('close', () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          reject(new Error('Connection closed before binding response'));
        });

        try {
          activeLink.sendBindingRequest();
        } catch (e: unknown) {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          reject(e as Error);
        }
      })
      .catch((err: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        reject(err as Error);
      });
  });
}

interface QueryResult {
  success: boolean;
  res?: BindingResponse;
  err?: Error;
}

export async function queryPublicAddress(
  node: GMPNodeLike,
  peers: PublicPeerEntry[],
  timeoutMs: number = 5000
): Promise<{ address: string; port: number }> {
  if (!peers || peers.length === 0) {
    throw new Error('No public peers specified for query');
  }

  const promises: Promise<QueryResult>[] = peers.map(peer =>
    querySinglePeer(node, peer, timeoutMs)
      .then(res => ({ success: true, res }))
      .catch(err => ({ success: false, err }))
  );

  const results = await Promise.all(promises);
  const successful: BindingResponse[] = results
    .filter((r): r is { success: true; res: BindingResponse } => r.success && r.res !== undefined)
    .map(r => r.res);

  if (successful.length === 0) {
    throw new Error('All public peer queries failed');
  }

  const agreementCounts: Record<string, number> = {};
  for (const res of successful) {
    const key = `${res.address}:${res.port}`;
    agreementCounts[key] = (agreementCounts[key] || 0) + 1;
  }

  let bestKey: string | null = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(agreementCounts)) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }

  if (maxCount >= Math.min(successful.length, 2) && bestKey !== null) {
    const lastColonIndex = bestKey.lastIndexOf(':');
    const parsedAddress = bestKey.slice(0, lastColonIndex);
    const parsedPort = parseInt(bestKey.slice(lastColonIndex + 1), 10);
    return { address: parsedAddress, port: parsedPort };
  }

  throw new Error('Public peers disagreed on public address');
}