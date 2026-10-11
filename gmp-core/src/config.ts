/**
 * Configuration loading — application layer only.
 *
 * Precedence, highest first: explicit option > environment variable >
 * config file (config.json) > built-in default (config-defaults.ts).
 *
 * resolveConfig() is the pure core; loadConfig() feeds it process.env and the
 * config file. Node-level modules must not import this file.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_FILE } from './paths.js';
import { DEFAULTS } from './config-defaults.js';
import type { GMPConfig, LogLevel } from './types.js';

export { DEFAULTS };

type DefaultKey = keyof typeof DEFAULTS;

/**
 * Keys with no built-in default: absent means "not configured", which the
 * consumer interprets (LAN discovery: on unless set to false).
 */
const OPTIONAL_KEYS = {
  GMP_LAN_DISCOVERY: 'boolean',
  GMP_LAN_DISCOVERY_PORT: 'number',
  GMP_LAN_DISCOVERY_GROUP: 'string',
} as const;
type OptionalKey = keyof typeof OPTIONAL_KEYS;

/** Keys that no longer exist, and why. Setting one yields a config issue. */
const RETIRED_KEYS: Record<string, string> = {
  GMP_RATE_LIMIT_MAX_PER_IP:
    'there is no per-IP connection count (GM-M4-2\'): behind CGNAT hundreds of subscribers share one address. ' +
    'Per-address admission is a token bucket: GMP_INBOUND_RATE_PER_MINUTE / GMP_INBOUND_BURST',
};
export type ConfigKey = DefaultKey | OptionalKey;

export type ConfigSource = 'default' | 'file' | 'env' | 'explicit';

export interface ConfigIssue {
  key: string;
  source: 'file' | 'env';
  value: unknown;
  reason: string;
}

export interface ResolvedConfig {
  config: GMPConfig;
  /** Where each key's value came from. Optional keys appear only when set. */
  sources: Partial<Record<ConfigKey, ConfigSource>>;
  /** Values that were present but unusable, and so did not take effect. */
  issues: ConfigIssue[];
  /** The config file that was read, if any. */
  filePath: string | null;
}

const LOG_LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

function isDefaultKey(key: string): key is DefaultKey {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

function isOptionalKey(key: string): key is OptionalKey {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_KEYS, key);
}

function isConfigKey(key: string): key is ConfigKey {
  return isDefaultKey(key) || isOptionalKey(key);
}

function kindOf(key: ConfigKey): 'number' | 'boolean' | 'string' | 'loglevel' {
  if (key === 'GMP_LOG_LEVEL') return 'loglevel';
  if (isOptionalKey(key)) return OPTIONAL_KEYS[key];
  const kind = typeof DEFAULTS[key];
  return kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : 'string';
}

/** ok: value holds the parsed value; otherwise reason says why it was refused. */
interface Parsed { ok: boolean; value?: unknown; reason?: string }

/**
 * Parse a raw env string or JSON value into the key's type. Booleans accept
 * 'true'/'1'; log levels are case-insensitive.
 */
function parseValue(key: ConfigKey, raw: unknown, source: 'file' | 'env'): Parsed {
  switch (kindOf(key)) {
    case 'number': {
      if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) {
        const n = Number(raw);
        if (!isNaN(n)) return { ok: true, value: n };
      }
      return { ok: false, reason: 'not a number' };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        if (source === 'env') return { ok: true, value: raw === 'true' || raw === '1' };
        if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      }
      return { ok: false, reason: 'not a boolean' };
    }
    case 'loglevel': {
      if (typeof raw === 'string') {
        const upper = raw.toUpperCase();
        const level = LOG_LEVELS.find((l) => l === upper);
        if (level) return { ok: true, value: level };
      }
      return { ok: false, reason: `not one of ${LOG_LEVELS.join(', ')}` };
    }
    case 'string':
      return typeof raw === 'string' ? { ok: true, value: raw } : { ok: false, reason: 'not a string' };
  }
}

/** Typed write for a runtime-narrowed ConfigKey (GMPConfig has no index signature). */
function setValue(target: GMPConfig, key: ConfigKey, value: unknown): void {
  (target as unknown as Record<ConfigKey, unknown>)[key] = value;
}

const OPTION_ALIASES: Record<string, ConfigKey> = {
  port: 'GMP_PORT',
  bridgePort: 'GMP_BRIDGE_PORT',
  bridgeHost: 'GMP_BRIDGE_HOST',
  minPeers: 'GMP_MIN_PEERS',
  maxPeers: 'GMP_MAX_PEERS',
  maxConnections: 'GMP_MAX_CONNECTIONS',
  helloTimeoutMs: 'GMP_HELLO_TIMEOUT_MS',
  handshakeTimeoutMs: 'GMP_HANDSHAKE_TIMEOUT_MS',
  pingIntervalMs: 'GMP_PING_INTERVAL_MS',
  pongTimeoutMs: 'GMP_PING_TIMEOUT_MS',
  timestampWindowMs: 'GMP_TIMESTAMP_WINDOW_MS',
  stage1TimeoutMs: 'GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS',
  stage2TimeoutMs: 'GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS',
  bootstrapLanTimeoutMs: 'GMP_BOOTSTRAP_LAN_TIMEOUT_MS',
  bootstrapPxTimeoutMs: 'GMP_BOOTSTRAP_PX_TIMEOUT_MS',
  bootstrapDialTimeoutMs: 'GMP_BOOTSTRAP_DIAL_TIMEOUT_MS',
  bootstrapDialStaggerMs: 'GMP_BOOTSTRAP_DIAL_STAGGER_MS',
  lanBootstrapAny: 'GMP_LAN_BOOTSTRAP_ANY',
  rebootstrapBackoffInitialMs: 'GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS',
  rateLimitWindowMs: 'GMP_RATE_LIMIT_WINDOW_MS',
  rateLimitMaxGlobal: 'GMP_RATE_LIMIT_MAX_GLOBAL',
  inboundRatePerMinute: 'GMP_INBOUND_RATE_PER_MINUTE',
  inboundBurst: 'GMP_INBOUND_BURST',
  forwardRateLimitPerSource: 'GMP_FORWARD_RATE_LIMIT_PER_SOURCE',
  peerRequestRateLimitIntervalMs: 'GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS',
  sessionKeyLruSize: 'GMP_SESSION_KEY_LRU_SIZE',
  sequenceNumLruSize: 'GMP_SEQUENCE_NUM_LRU_SIZE',
  noncePruneAgeMs: 'GMP_NONCE_PRUNE_AGE_MS',
  routeExpiryMs: 'GMP_ROUTE_EXPIRY_MS',
  topologyTtl: 'GMP_TOPOLOGY_TTL',
  messageHopLimit: 'GMP_MESSAGE_HOP_LIMIT',
  reannounceIntervalMs: 'GMP_REANNOUNCE_INTERVAL_MS',
  peerCacheMaxSize: 'GMP_PEER_CACHE_MAX_SIZE',
  peerCachePruneFailureThreshold: 'GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD',
  peerCachePruneAgeDays: 'GMP_PEER_CACHE_PRUNE_AGE_DAYS',
  metricsPort: 'GMP_METRICS_PORT',
  logLevel: 'GMP_LOG_LEVEL',
  logToFile: 'GMP_LOG_TO_FILE',
  logToConsole: 'GMP_LOG_TO_CONSOLE',
  strictState: 'GMP_STRICT_STATE',
  banDurationMs: 'GMP_BAN_DURATION_MS',
  recoveryIntervalMs: 'GMP_REPUTATION_RECOVERY_INTERVAL_MS',
  relayEnabled: 'GMP_RELAY_ENABLED',
  relayReservationTtlMs: 'GMP_RELAY_RESERVATION_TTL_MS',
  relayMaxReservations: 'GMP_RELAY_MAX_RESERVATIONS',
  relayMaxReservationsPerSubnet: 'GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET',
  relayReservationRatePerMinute: 'GMP_RELAY_RESERVATION_RATE_PER_MINUTE',
  relayReservationBurst: 'GMP_RELAY_RESERVATION_BURST',
  relayMaxCircuitsPerReservation: 'GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION',
  relayMaxCircuitBytes: 'GMP_RELAY_MAX_CIRCUIT_BYTES',
  relayMaxCircuitDurationMs: 'GMP_RELAY_MAX_CIRCUIT_DURATION_MS',
  relayRoleObservationMs: 'GMP_RELAY_ROLE_OBSERVATION_MS',
  storageEnabled: 'GMP_STORAGE_ENABLED',
  sfTtlMs: 'GMP_SF_TTL_MS',
  sfBucketMaxBlobs: 'GMP_SF_BUCKET_MAX_BLOBS',
  sfBucketMaxBytes: 'GMP_SF_BUCKET_MAX_BYTES',
  sfFetchBuckets: 'GMP_SF_FETCH_BUCKETS',
  sfFetchMaxBlobs: 'GMP_SF_FETCH_MAX_BLOBS',
  sfDepositRatePerMinute: 'GMP_SF_DEPOSIT_RATE_PER_MINUTE',
  sfDepositBurst: 'GMP_SF_DEPOSIT_BURST',
  sfPollIntervalMs: 'GMP_SF_POLL_INTERVAL_MS',
  sfStoragePeer: 'GMP_SF_STORAGE_PEER',
  sfDecoyChannels: 'GMP_SF_DECOY_CHANNELS',
  sfCursorQuantumMs: 'GMP_SF_CURSOR_QUANTUM_MS',
  lanDiscovery: 'GMP_LAN_DISCOVERY',
  lanDiscoveryPort: 'GMP_LAN_DISCOVERY_PORT',
  lanDiscoveryGroup: 'GMP_LAN_DISCOVERY_GROUP',
};

/**
 * Pick configuration from explicit options (GMP_* or camelCase). Other keys
 * are ignored; GMP_* wins when both are given.
 */
export function normalizeOverrides(options: Record<string, unknown>): Partial<Record<ConfigKey, unknown>> {
  const out: Partial<Record<ConfigKey, unknown>> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const alias = OPTION_ALIASES[key];
    if (alias && out[alias] === undefined) out[alias] = value;
  }
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && isConfigKey(key)) out[key] = value;
  }
  return out;
}

export interface ResolveInput {
  env?: Record<string, string | undefined>;
  file?: Record<string, unknown>;
  filePath?: string | null;
  overrides?: Record<string, unknown>;
}

/** Pure: resolve every key by precedence. No environment or file access. */
export function resolveConfig({ env = {}, file = {}, filePath = null, overrides = {} }: ResolveInput = {}): ResolvedConfig {
  const config: GMPConfig = { ...DEFAULTS };
  const sources: Partial<Record<ConfigKey, ConfigSource>> = {};
  const issues: ConfigIssue[] = [];
  const explicit = normalizeOverrides(overrides);

  const keys: ConfigKey[] = [
    ...(Object.keys(DEFAULTS) as DefaultKey[]),
    ...(Object.keys(OPTIONAL_KEYS) as OptionalKey[]),
  ];
  for (const key of keys) {
    if (isDefaultKey(key)) sources[key] = 'default';

    if (Object.prototype.hasOwnProperty.call(file, key) && file[key] !== undefined) {
      const parsed = parseValue(key, file[key], 'file');
      if (parsed.ok) {
        setValue(config, key, parsed.value);
        sources[key] = 'file';
      } else {
        issues.push({ key, source: 'file', value: file[key], reason: parsed.reason });
      }
    }

    const envRaw = env[key];
    if (envRaw !== undefined) {
      const parsed = parseValue(key, envRaw, 'env');
      if (parsed.ok) {
        setValue(config, key, parsed.value);
        sources[key] = 'env';
      } else {
        issues.push({ key, source: 'env', value: envRaw, reason: parsed.reason });
      }
    }

    if (explicit[key] !== undefined) {
      setValue(config, key, explicit[key]);
      sources[key] = 'explicit';
    }
  }

  // A retired key is reported, not silently ignored: an operator who set it
  // expects it to do something.
  for (const [key, reason] of Object.entries(RETIRED_KEYS)) {
    if (file[key] !== undefined) issues.push({ key, source: 'file', value: file[key], reason: `retired: ${reason}` });
    if (env[key] !== undefined) issues.push({ key, source: 'env', value: env[key], reason: `retired: ${reason}` });
  }

  return { config, sources, issues, filePath };
}

/** Candidate config files, first existing one wins (historical order). */
export function configFileCandidates(): string[] {
  return [
    path.join(process.cwd(), 'gmp-core', 'data', 'config.json'),
    path.join(process.cwd(), 'data', 'config.json'),
    CONFIG_FILE,
  ];
}

export function readConfigFile(candidates: string[] = configFileCandidates()): {
  filePath: string | null;
  values: Record<string, unknown>;
  error: string | null;
} {
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { filePath: p, values: parsed as Record<string, unknown>, error: null };
      }
      return { filePath: p, values: {}, error: 'config file is not a JSON object' };
    } catch (e) {
      return { filePath: p, values: {}, error: (e as Error).message };
    }
  }
  return { filePath: null, values: {}, error: null };
}

/** Load from process.env and the config file, with explicit overrides on top. */
export function loadConfigDetailed(customOptions: Record<string, unknown> = {}): ResolvedConfig {
  const file = readConfigFile();
  const resolved = resolveConfig({
    env: process.env,
    file: file.values,
    filePath: file.filePath,
    overrides: customOptions,
  });
  if (file.error) {
    resolved.issues.unshift({ key: '*', source: 'file', value: file.filePath, reason: `unreadable: ${file.error}` });
  }
  return resolved;
}

export function loadConfig(customOptions: Record<string, unknown> = {}): GMPConfig {
  return loadConfigDetailed(customOptions).config;
}

const config = loadConfig();
export default config;
