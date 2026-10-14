/**
 * The one way a GMPNode is constructed, used by GMPNodeManager and by every
 * test (run-all.mjs refuses `new GMPNode(` anywhere else), so tests exercise
 * the node that ships.
 *
 * - Configuration uses the manager's resolver: explicit option > environment >
 *   config file > default. A passed `config` is layered as explicit values.
 * - No `dataDir` means the process-wide layout (GMP_DATA_DIR / paths.ts),
 *   which scopes the claim log per identity; it is not normalised to an
 *   explicit directory.
 */

import { GMPNode } from './link.js';
import { loadConfigDetailed, type ConfigIssue } from './config.js';
import type { GMPConfig, GMPNodeConstructorOptions } from './types.js';

/** GMPNode's constructor options, plus explicit GMP_* config values. */
export type CreateNodeOptions = Omit<GMPNodeConstructorOptions, 'config'> & Partial<GMPConfig> & {
  /** Explicit config values (highest precedence), layered over env / file / defaults. */
  config?: Partial<GMPConfig>;
  /** Anything else GMPNode reads (injected limiters, stores; tests only). */
  [option: string]: unknown;
};

export interface CreatedNode {
  node: GMPNode;
  config: GMPConfig;
  issues: ConfigIssue[];
}

/**
 * Validate the `derivedSeed` option: a supported way to build a node from an
 * already-KDF'd 32-byte seed (mobile will derive it with native PBKDF2 and pass
 * it in; tests use it for deterministic identities). Raw bytes ONLY — never an
 * identity object, so the node still derives every key and the NodeID itself.
 * It is destructured out before config resolution, so it can only ever come
 * from the option object, never from the environment or a config file.
 */
function validateDerivedSeed(value: unknown, explicitSeedPhrase: unknown): Uint8Array {
  if (explicitSeedPhrase != null && explicitSeedPhrase !== '') {
    throw new Error('createGMPNode: pass seedPhrase or derivedSeed, not both');
  }
  if (!(value instanceof Uint8Array)) {
    throw new Error('createGMPNode: derivedSeed must be a Uint8Array of raw bytes, not an identity object');
  }
  if (value.length !== 32) {
    throw new Error(`createGMPNode: derivedSeed must be exactly 32 bytes, got ${value.length}`);
  }
  if (value.every((b) => b === 0)) {
    throw new Error('createGMPNode: derivedSeed must not be all-zero');
  }
  return value;
}

/** Construct a node and report the configuration it was built with. */
export function createGMPNodeDetailed(options: CreateNodeOptions = {}): CreatedNode {
  const { config: explicitConfig, derivedSeed, ...rest } = options;
  const validatedSeed = derivedSeed == null
    ? null
    : validateDerivedSeed(derivedSeed, rest.seedPhrase ?? (explicitConfig as Partial<GMPConfig> | undefined)?.GMP_SEED_PHRASE);
  const resolved = loadConfigDetailed({ ...(explicitConfig || {}), ...rest });
  const node = new GMPNode({
    ...rest,
    ...(validatedSeed ? { derivedSeed: validatedSeed } : {}),
    config: resolved.config,
  });
  return { node, config: resolved.config, issues: resolved.issues };
}

/** Construct a node. See the module comment: this is the only construction path. */
export function createGMPNode(options: CreateNodeOptions = {}): GMPNode {
  return createGMPNodeDetailed(options).node;
}
