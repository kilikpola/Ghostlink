/**
 * A throwaway node for one short task (`gmp probe`, the interop runner):
 * a fresh CSPRNG seed held only in memory, its own temporary dataDir (never
 * the process-wide data dir), and no bootstrap or LAN beacons.
 *
 * close() closes the node, removes the directory, and reports how many files
 * the node wrote there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGMPNode } from './node-factory.js';
import { generateSeedPhrase } from './seed-phrase.js';
import type { GMPTransport } from './transport/transport.js';

export interface ThrowawayNode {
  /** The GMPNode (link.js). */
  node: ReturnType<typeof createGMPNode>;
  /** Its temporary data directory; gone after close(). */
  dataDir: string;
  /** Close the node, remove its directory; returns the files it had written there. */
  close(): { filesWritten: string[] };
}

export async function createThrowawayNode(opts: { transport?: GMPTransport; prefix?: string } = {}): Promise<ThrowawayNode> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.prefix || 'gmp-throwaway'}-`));
  const node = createGMPNode({
    port: 0,
    dataDir,
    disableBootstrap: true,
    lanDiscovery: false,
    ...(opts.transport ? { transport: opts.transport } : {}),
  } as never);
  node.on('error', () => {});
  try {
    await node.loadIdentity(generateSeedPhrase());
  } catch (e) {
    try { node.close(); } catch { /* closing */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }
  let closed = false;
  return {
    node,
    dataDir,
    close() {
      let filesWritten: string[] = [];
      if (closed) return { filesWritten };
      closed = true;
      try { node.close(); } catch { /* closing */ }
      try { filesWritten = fs.readdirSync(dataDir); } catch { /* already gone */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
      return { filesWritten };
    },
  };
}
