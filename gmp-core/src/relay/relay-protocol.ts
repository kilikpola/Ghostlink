/**
 * Relay tier wire protocol, modelled on libp2p Circuit Relay v2. Frames
 * 0x0C-0x10 on an ordinary encrypted GMP link:
 *
 *   RELAY_RESERVE      client -> relay   JSON { renew?: voucherId }
 *   RELAY_RESERVATION  relay -> client   JSON { voucher }
 *   RELAY_CONNECT      client -> relay   JSON { voucherId, requestId }
 *                      relay -> client   JSON { circuitId, requestId? }  (circuit open;
 *                                        no requestId = an incoming circuit)
 *   RELAY_DATA         both directions   [circuitId u32 BE][opaque bytes]
 *   RELAY_STOP         both directions   JSON { reason, circuitId?, requestId?, op? }
 *
 * The relay reads only the circuit ID of RELAY_DATA. See docs/relay-metadata.md.
 */

import { signMessage, verifySignature } from '../identity.js';

export const RELAY_STOP_REASONS = [
  'relay-disabled',       // this node does not run a relay
  'reservation-limit',    // relay holds its maximum number of reservations
  'subnet-limit',         // too many concurrent reservations from this /24 (IPv6: /48)
  'subnet-rate-limit',    // reservations arriving from this /24 faster than its token bucket refills
  'no-reservation',       // unknown voucher
  'reservation-expired',  // voucher past its expiry
  'circuit-limit',        // reservation already carries its maximum circuits
  'bytes-exceeded',       // circuit hit its byte quota
  'duration-exceeded',    // circuit hit its time quota
  'peer-gone',            // the other end's link to the relay closed
  'closed',               // an end closed the circuit
  'malformed',            // unparseable relay message
] as const;
export type RelayStopReason = typeof RELAY_STOP_REASONS[number];

/** STOP reasons that are the relay enforcing policy, counted per reason. */
export const RELAY_REJECTION_REASONS: readonly RelayStopReason[] = [
  'relay-disabled', 'reservation-limit', 'subnet-limit', 'subnet-rate-limit', 'no-reservation',
  'reservation-expired', 'circuit-limit', 'bytes-exceeded', 'duration-exceeded', 'malformed',
];

export interface Voucher {
  v: 1;
  /** Hex NodeID of the relay that issued it. */
  relayNodeId: string;
  /** 16 random bytes, hex. The only thing a dialer presents. */
  voucherId: string;
  /** Hex NodeID of the reserving hop — a throwaway identity, not the user's. */
  reserver: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Ed25519 over voucherSigningBytes(), hex. */
  signature: string;
}

function voucherSigningBytes(v: Omit<Voucher, 'signature'>): Uint8Array {
  return new TextEncoder().encode(
    `gmp-relay-voucher-v${v.v}|${v.relayNodeId}|${v.voucherId}|${v.reserver}|${v.expiresAt}`,
  );
}

export function signVoucher(fields: Omit<Voucher, 'signature'>, signingPrivKey: Uint8Array): Voucher {
  const signature = Buffer.from(signMessage(signingPrivKey, voucherSigningBytes(fields))).toString('hex');
  return { ...fields, signature };
}

/** True only for a well-formed voucher signed by `signingPubKey`. */
export function verifyVoucher(voucher: unknown, signingPubKey: Uint8Array): boolean {
  if (!voucher || typeof voucher !== 'object') return false;
  const v = voucher as Partial<Voucher>;
  if (v.v !== 1 || typeof v.relayNodeId !== 'string' || typeof v.voucherId !== 'string'
    || typeof v.reserver !== 'string' || typeof v.expiresAt !== 'number' || typeof v.signature !== 'string'
    || !/^[0-9a-f]{128}$/.test(v.signature)) {
    return false;
  }
  try {
    const { signature, ...fields } = v as Voucher;
    return verifySignature(signingPubKey, voucherSigningBytes(fields), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

export function encodeRelayData(circuitId: number, data: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + data.length);
  out.writeUInt32BE(circuitId >>> 0, 0);
  out.set(data, 4);
  return out;
}

export function decodeRelayData(payload: Buffer): { circuitId: number; data: Buffer } | null {
  if (payload.length < 4) return null;
  return { circuitId: payload.readUInt32BE(0), data: payload.subarray(4) };
}

export function encodeControl(obj: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

/** Parse a control message; null for anything that is not a JSON object. */
export function decodeControl(payload: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(payload.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Anti-Sybil bucket: IPv4 /24 (IPv4-mapped included), IPv6 /48; anything else
 * by its whole string.
 */
export function subnetKey(address: string | null | undefined): string {
  if (!address) return 'unknown';
  const v4 = address.replace(/^::ffff:/i, '');
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`;
  if (address.includes(':')) {
    const bare = address.replace(/%.*$/, '').toLowerCase();
    const [head, tail] = bare.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const hextets = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${hextets.slice(0, 3).map((h) => h || '0').join(':')}::/48`;
  }
  return address;
}

export class RelayError extends Error {
  readonly reason: RelayStopReason | 'timeout' | 'bad-voucher' | 'wrong-relay' | 'wrong-peer' | 'real-identity' | 'no-ephemeral-source';

  constructor(reason: RelayError['reason'], message?: string) {
    super(message ?? `Relay refused: ${reason}`);
    this.name = 'RelayError';
    this.reason = reason;
  }
}
