/**
 * One host, one role: bootstrap / relay / storage.
 *
 * A host that saw this node's real identity and also relays or stores for it
 * could link the two by address. Hard rules:
 *
 *   1  never reserve on a host that has seen the real identity
 *      -> RESERVE_ON_BOOTSTRAP_HOST
 *   2  never connect with the real identity to a host holding our reservation
 *      -> BOOTSTRAP_VIA_RELAY_HOST
 *   3  never use as storage a host that has seen the real identity
 *      -> STORAGE_ON_BOOTSTRAP_HOST, or holds a reservation
 *      -> STORAGE_ON_RELAY_HOST
 *   4  never reserve on a storage host in use -> RESERVE_ON_STORAGE_HOST;
 *      never connect with the real identity to one -> BOOTSTRAP_VIA_STORAGE_HOST
 *
 * Hosts are matched by dial address and NodeID; where public-peers.json names
 * operators, the rules apply per operator too. A role is "separated" only when
 * its operator is known and differs from every operator that has seen the real
 * identity; otherwise it is surfaced as RELAYED_UNSEPARATED.
 */

import type { PublicPeerEntry } from '../types.js';

export type Separation = 'separated' | 'unseparated';

export type RoleSeparationCode =
  | 'RESERVE_ON_BOOTSTRAP_HOST'
  | 'BOOTSTRAP_VIA_RELAY_HOST'
  | 'STORAGE_ON_BOOTSTRAP_HOST'
  | 'STORAGE_ON_RELAY_HOST'
  | 'RESERVE_ON_STORAGE_HOST'
  | 'BOOTSTRAP_VIA_STORAGE_HOST';

/** The operator a self-hosted storage peer is recorded under. Always separated: the user runs it. */
export const SELF_OPERATOR = 'self';

export class RoleSeparationError extends Error {
  readonly code: RoleSeparationCode;

  constructor(code: RoleSeparationCode, message: string) {
    super(message);
    this.name = 'RoleSeparationError';
    this.code = code;
  }
}

export function hostKey(address: string, port: number): string {
  return `${String(address).toLowerCase()}:${port}`;
}

/** What has seen this node's real identity this session. */
export interface Exposure {
  /** hostKey()s and hex NodeIDs. */
  hosts: Set<string>;
  /** Operators of public-peer infrastructure used with the real identity. */
  operators: Set<string>;
  /** Some such infrastructure had no operator recorded. */
  unknownOperatorUsed: boolean;
}

export class SessionExposure implements Exposure {
  readonly hosts = new Set<string>();
  readonly operators = new Set<string>();
  unknownOperatorUsed = false;

  noteHost(key: string | null, nodeIdHex: string | null): void {
    if (key) this.hosts.add(key);
    if (nodeIdHex) this.hosts.add(nodeIdHex.toLowerCase());
  }

  /** Public-peer infrastructure (from public-peers.json) used with the real identity. */
  noteInfrastructure(operator: string | null | undefined): void {
    if (operator) this.operators.add(operator);
    else this.unknownOperatorUsed = true;
  }

  hasSeen(key: string | null, nodeIdHex?: string | null): boolean {
    return (!!key && this.hosts.has(key)) || (!!nodeIdHex && this.hosts.has(nodeIdHex.toLowerCase()));
  }

  separationFor(relayOperator: string | null | undefined): Separation {
    return separationFor(relayOperator, this);
  }
}

export function separationFor(relayOperator: string | null | undefined, exposure: Exposure): Separation {
  if (relayOperator === SELF_OPERATOR) return 'separated';
  if (!relayOperator) return 'unseparated';
  if (exposure.unknownOperatorUsed || exposure.operators.has(relayOperator)) return 'unseparated';
  return 'separated';
}

/**
 * Pick a relay from public-peer entries: never a host that has seen the real
 * identity; a separated one if any; otherwise a same- or unknown-operator one,
 * marked unseparated so the caller surfaces it. Null when none qualifies.
 */
export function selectRelay(
  peers: Array<Pick<PublicPeerEntry, 'address' | 'port' | 'nodeId' | 'roles' | 'operator'>>,
  exposure: Exposure,
): { entry: (typeof peers)[number]; separation: Separation } | null {
  const eligible = peers.filter((p) => p.roles.includes('relay')
    && !exposure.hosts.has(hostKey(p.address, p.port))
    && !(p.nodeId && exposure.hosts.has(p.nodeId.toLowerCase()))
    && !(p.operator && exposure.operators.has(p.operator)));
  const separated = eligible.find((p) => separationFor(p.operator, exposure) === 'separated');
  if (separated) return { entry: separated, separation: 'separated' };
  return eligible.length > 0 ? { entry: eligible[0], separation: 'unseparated' } : null;
}
