/**
 * What each production entry point passes to GMPNodeManager. Shared with
 * production-construction-test so tests build the shipped configuration.
 * Imports nothing else from gmp-core: GMP_DATA_DIR must be settled before
 * paths.ts is evaluated.
 */

import path from 'path';

type Env = Record<string, string | undefined>;

export type EntryPoint = 'cli' | 'public-peer' | 'storage-peer' | 'electron';

/** `gmp` (node) and `gmp public-peer`. Port: PORT (public peer only) > GMP_PORT > 49500. */
export function cliManagerOptions({ seedPhrase, isPublic, env, configuredPort }: {
  seedPhrase: string;
  isPublic: boolean;
  env: Env;
  configuredPort: number | undefined;
}): Record<string, unknown> {
  const options: Record<string, unknown> = { seedPhrase };
  if (isPublic) options.isPublicPeer = true;
  // The public peer measures itself: its host has no shell, and
  // these samples refine the global connection cap. An operator's own
  // GMP_RESOURCE_LOG_INTERVAL_MS (0 to silence it) wins.
  if (isPublic && env.GMP_RESOURCE_LOG_INTERVAL_MS === undefined) options.GMP_RESOURCE_LOG_INTERVAL_MS = 60_000;
  const fromEnv = isPublic && env.PORT ? parseInt(env.PORT, 10) : NaN;
  options.GMP_PORT = Number.isFinite(fromEnv) ? fromEnv : (configuredPort || 49500);
  return options;
}

/** `gmp storage-peer`: blobs only, no bootstrap, no LAN beacons, no mailbox. */
export function storagePeerManagerOptions({ seedPhrase }: { seedPhrase: string }): Record<string, unknown> {
  return {
    seedPhrase,
    GMP_STORAGE_ENABLED: true,
    GMP_LAN_DISCOVERY: false,
    disableBootstrap: true,
    storeForward: false,
  };
}

/** Electron main process. */
export function electronManagerOptions({ seedPhrase }: { seedPhrase: string }): Record<string, unknown> {
  return { seedPhrase };
}

/**
 * GMP_DATA_DIR for a packaged Electron app (gmp-core's own data dir is
 * read-only there), or null to leave the environment alone. Apply before
 * importing other gmp-core modules.
 */
export function electronDataDir({ isPackaged, userDataPath, env }: {
  isPackaged: boolean;
  userDataPath: string;
  env: Env;
}): string | null {
  if (!isPackaged || env.GMP_DATA_DIR) return null;
  return path.join(userDataPath, 'gmp-data');
}
