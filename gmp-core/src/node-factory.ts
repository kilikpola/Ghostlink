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

/** Construct a node and report the configuration it was built with. */
export function createGMPNodeDetailed(options: CreateNodeOptions = {}): CreatedNode {
  const { config: explicitConfig, ...rest } = options;
  const resolved = loadConfigDetailed({ ...(explicitConfig || {}), ...rest });
  const node = new GMPNode({ ...rest, config: resolved.config });
  return { node, config: resolved.config, issues: resolved.issues };
}

/** Construct a node. See the module comment: this is the only construction path. */
export function createGMPNode(options: CreateNodeOptions = {}): GMPNode {
  return createGMPNodeDetailed(options).node;
}
