import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The gmp-core package root, found by walking up to package.json, so paths
 * resolve the same from dist/, src/ or node_modules regardless of cwd.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No package.json anywhere above us: dist/ and src/ are both one level down
  // from the root, so the parent is the best available guess.
  return path.resolve(start, '..');
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);

/** Where the node's mutable state lives; GMP_DATA_DIR moves it. */
export const DATA_DIR = process.env.GMP_DATA_DIR
  ? path.resolve(process.env.GMP_DATA_DIR)
  : path.join(PACKAGE_ROOT, 'data');

export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}

/**
 * The shipped public peer list, read from the package (not DATA_DIR).
 * GMP_PUBLIC_PEERS_PATH replaces it.
 */
export const PUBLIC_PEERS_FILE = process.env.GMP_PUBLIC_PEERS_PATH
  ? path.resolve(process.env.GMP_PUBLIC_PEERS_PATH)
  : path.join(PACKAGE_ROOT, 'data', 'public-peers.json');

/**
 * Overlays merged on top of the shipped list, lowest precedence first:
 * DATA_DIR/public-peers.json and DATA_DIR/public-peers.local.json (gitignored).
 */
export const PUBLIC_PEERS_OVERLAY_FILES: readonly string[] = [
  dataPath('public-peers.json'),
  dataPath('public-peers.local.json'),
].filter((f) => path.resolve(f) !== path.resolve(PUBLIC_PEERS_FILE));

export const PEER_CACHE_FILE = process.env.GMP_PEER_CACHE_PATH
  ? path.resolve(process.env.GMP_PEER_CACHE_PATH)
  : dataPath('peer-cache.json');

export const NONCE_STATE_FILE = process.env.GMP_NONCE_STATE_PATH
  ? path.resolve(process.env.GMP_NONCE_STATE_PATH)
  : dataPath('nonce-state.json');

/** The append-only session-key claim log (permanent, unlike pruned counters). */
export const NONCE_CLAIMS_FILE = process.env.GMP_NONCE_CLAIMS_PATH
  ? path.resolve(process.env.GMP_NONCE_CLAIMS_PATH)
  : dataPath('nonce-claims.log');

export const CONFIG_FILE = process.env.GMP_CONFIG_PATH
  ? path.resolve(process.env.GMP_CONFIG_PATH)
  : dataPath('config.json');
