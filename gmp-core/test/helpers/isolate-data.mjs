/**
 * Point this test process's node state at a throwaway directory. Import FIRST,
 * so GMP_DATA_DIR is set before paths.ts reads it. An explicit GMP_DATA_DIR is
 * left alone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

if (!process.env.GMP_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-test-data-'));
  process.env.GMP_DATA_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

// Network isolation through the environment: no LAN beacons and an empty
// public peer list, unless a suite sets them explicitly.
if (process.env.GMP_LAN_DISCOVERY === undefined) process.env.GMP_LAN_DISCOVERY = 'false';
if (!process.env.GMP_PUBLIC_PEERS_PATH) {
  const peersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-test-peers-'));
  const peersFile = path.join(peersDir, 'public-peers.json');
  fs.writeFileSync(peersFile, '[]\n');
  process.env.GMP_PUBLIC_PEERS_PATH = peersFile;
  process.on('exit', () => {
    try { fs.rmSync(peersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

// Claim-log invariant assertions (throw on a violated record boundary). The
// code no longer switches them on from NODE_ENV; tests ask.
if (process.env.GMP_DEBUG_ASSERTS === undefined) process.env.GMP_DEBUG_ASSERTS = '1';
