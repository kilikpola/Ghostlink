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
import {
  openRatchetStore, memoryOnlyRatchetStore, ratchetSealKey, RatchetStoreRequiredError,
  type AnchorProvider, type RatchetStore, type RatchetStoreOptions,
} from './ratchet/ratchet-store.js';

/**
 * How a node keeps ratchet sessions (R5). There is no default: a sealed store
 * needs a directory and the entry point's secure-storage anchor; the only
 * alternative is an explicit memory-only mode with its reason (browser build,
 * Q8). Anything else refuses with RatchetStoreRequiredError.
 */
export type RatchetSpec =
  | { dir: string; anchor: AnchorProvider; on?: RatchetStoreOptions['on'] }
  | { memoryOnly: string; on?: RatchetStoreOptions['on'] };

/** node.ratchets: open() builds the store once the identity (and so #34) is loaded. */
export interface NodeRatchets { readonly kind: 'sealed' | 'memory-only'; open(): RatchetStore }

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

function validateRatchetSpec(spec: unknown): RatchetSpec {
  const s = spec as Record<string, unknown> | null;
  const memory = !!s && typeof s.memoryOnly === 'string' && s.memoryOnly.trim() !== '' && s.dir === undefined;
  const sealed = !!s && typeof s.dir === 'string' && s.dir !== '' && s.memoryOnly === undefined && !!s.anchor &&
    typeof (s.anchor as AnchorProvider).load === 'function' && typeof (s.anchor as AnchorProvider).save === 'function';
  if (!memory && !sealed) {
    throw new RatchetStoreRequiredError(
      'createGMPNode: `ratchets` must be { dir, anchor } (a sealed store with an OS secure-storage anchor) ' +
      'or { memoryOnly: "<reason>" }; there is no default');
  }
  return spec as RatchetSpec;
}

/**
 * node.ratchets. Without a spec, any use refuses: a node never falls back to
 * unsealed or unanchored ratchets on its own.
 */
function attachRatchets(node: GMPNode, spec: RatchetSpec | null): void {
  let store: RatchetStore | null = null;
  const handle: NodeRatchets | null = spec && {
    kind: 'memoryOnly' in spec ? 'memory-only' : 'sealed',
    open(): RatchetStore {
      if (store) return store;
      if ('memoryOnly' in spec) return (store = memoryOnlyRatchetStore(spec.memoryOnly, spec.on));
      const seed = (node as unknown as { identity?: { seed?: Uint8Array } | null }).identity?.seed;
      if (!(seed instanceof Uint8Array)) throw new RatchetStoreRequiredError('node.ratchets.open(): load the identity first (the seal key derives from it)');
      return (store = openRatchetStore({ dir: spec.dir, anchor: spec.anchor, on: spec.on, sealKey: ratchetSealKey(seed) }));
    },
  };
  Object.defineProperty(node, 'ratchets', {
    enumerable: false,
    configurable: false,
    get(): NodeRatchets {
      if (!handle) throw new RatchetStoreRequiredError('this node was built without a ratchet store or an explicit memory-only mode (createGMPNode `ratchets`)');
      return handle;
    },
  });
}

/** Construct a node and report the configuration it was built with. */
export function createGMPNodeDetailed(options: CreateNodeOptions = {}): CreatedNode {
  const { config: explicitConfig, derivedSeed, ratchets, ...rest } = options;
  const ratchetSpec = 'ratchets' in options ? validateRatchetSpec(ratchets) : null;
  const validatedSeed = derivedSeed == null
    ? null
    : validateDerivedSeed(derivedSeed, rest.seedPhrase ?? (explicitConfig as Partial<GMPConfig> | undefined)?.GMP_SEED_PHRASE);
  const resolved = loadConfigDetailed({ ...(explicitConfig || {}), ...rest });
  const node = new GMPNode({
    ...rest,
    ...(validatedSeed ? { derivedSeed: validatedSeed } : {}),
    config: resolved.config,
  });
  attachRatchets(node, ratchetSpec);
  return { node, config: resolved.config, issues: resolved.issues };
}

/** Construct a node. See the module comment: this is the only construction path. */
export function createGMPNode(options: CreateNodeOptions = {}): GMPNode {
  return createGMPNodeDetailed(options).node;
}
