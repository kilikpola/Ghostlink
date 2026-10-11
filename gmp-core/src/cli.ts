#!/usr/bin/env node

import http from 'http';
import readline from 'readline';
import { Writable } from 'stream';
import config from './config.js';
import type { GMPNodeManagerOptions } from './types.js';
import { generateSeedPhrase } from './seed-phrase.js';

function getMetricsPort(): number {
  return config.GMP_METRICS_PORT || 9090;
}

/** stdout wrapper that can blank out what it echoes, for password entry. */
interface MutableStdout extends Writable {
  muted: boolean;
}

function askQuestion(query: string, silent: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    const mutableStdout = new Writable({
      // `this` inside a Writable's write() is the stream itself, which the
      // built-in type says is a plain Writable. The muted flag is ours, added
      // just below, so the callback has to be told what `this` really is.
      write: function(this: MutableStdout, chunk: Buffer | string, encoding: BufferEncoding, callback: () => void): void {
        const str = chunk.toString();
        if (this.muted || (!this.muted && str.includes(query))) {
          process.stdout.write(chunk, encoding);
        } else if (str === '\n' || str === '\r\n') {
          process.stdout.write(chunk, encoding);
        } else {
          process.stdout.write('*');
        }
        callback();
      }
    }) as MutableStdout;
    mutableStdout.muted = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });

    rl.question(query, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });

    if (silent) {
      mutableStdout.muted = true;
    }
  });
}

interface JsonResponse {
  [key: string]: unknown;
}

/** GET JSON, asserting the caller's expected shape once at the parse boundary. */
function getJson<T = JsonResponse>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res: http.IncomingMessage) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status Code: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJson<T = JsonResponse>(url: string, data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr)
      }
    };

    const req = http.request(options, (res: http.IncomingMessage) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as T & JsonResponse;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error((parsed.error as string) || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(dataStr);
    req.end();
  });
}

function formatUptime(uptimeSeconds: number): string {
  if (uptimeSeconds < 60) return `${uptimeSeconds}s`;
  const minutes = Math.floor(uptimeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${uptimeSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}


const generateCryptoSeedPhrase = generateSeedPhrase;

/**
 * Unattended hosts check their claim log read-only at startup and log the
 * verdict. Runs before the node starts, since loading may compact the log.
 */
async function startupDiagnostics(seedPhrase: string): Promise<void> {
  const { logStartupClaimLogCheck } = await import('./claim-log-diagnostic.js');
  await logStartupClaimLogCheck('cli', seedPhrase);
}

async function startNode(isPublic: boolean = false): Promise<void> {
  let seedPhrase: string | undefined = process.env.GMP_SEED_PHRASE;

  if (seedPhrase) {
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    logger.info('cli', 'env-seed-phrase', 'Using seed phrase from GMP_SEED_PHRASE environment variable');
  } else {
    seedPhrase = config.GMP_SEED_PHRASE;
    if (!seedPhrase) {
      console.log('No seed phrase configured.');
      seedPhrase = await askQuestion('Enter 12-word seed phrase: ', true);
    }
    if (!seedPhrase || seedPhrase.split(/\s+/).length !== 12) {
      console.error('Invalid seed phrase. Must be exactly 12 words.');
      process.exit(1);
    }
  }

  const { GMPNodeManager } = await import('./gmp-node-manager.js');
  const { startBridge } = await import('./gmp-bridge.js');

  // The options come from entry-points.ts, which production-construction-test
  // calls too: the test builds this node from this code.
  const { cliManagerOptions } = await import('./entry-points.js');
  const options = cliManagerOptions({ seedPhrase: seedPhrase!, isPublic, env: process.env, configuredPort: config.GMP_PORT });
  {
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    const source = isPublic && process.env.PORT ? ' from PORT environment variable' : '';
    logger.info('cli', 'port-select', `Using port ${options.GMP_PORT}${source} for GMP ${isPublic ? 'public-peer' : 'node'}`);
  }

  console.log(`Starting Ghost Link Node (isPublicPeer=${isPublic || false})...`);
  if (isPublic) await startupDiagnostics(seedPhrase!);
  const manager = new GMPNodeManager(options as GMPNodeManagerOptions);

  try {
    const status = await manager.start();
    console.log(`GMP Node successfully started. NodeID: ${status.nodeId}`);

    startBridge(manager, config.GMP_BRIDGE_PORT, config.GMP_BRIDGE_HOST);

    const shutdown = async (): Promise<void> => {
      console.log('\nShutting down GMP node gracefully...');
      await manager.stop();
      console.log('GMP node stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    const err = e as Error;
    console.error('Failed to start GMP Node:', err.message);
    process.exit(1);
  }
}

/**
 * `gmp storage-peer` — run a sealed store-and-forward mailbox, e.g. on a home
 * server.
 *
 *   GMP_SEED_PHRASE="<12 words>" GMP_PORT=49600 gmp storage-peer
 *
 * Stores blobs only: no client bridge, bootstrap dialling or LAN beacons. Point
 * your app at it with GMP_SF_STORAGE_PEER=<host>:<port>#<NodeID> (printed
 * below). See docs/store-and-forward.md.
 */
async function startStoragePeer(): Promise<void> {
  const seedPhrase = process.env.GMP_SEED_PHRASE || config.GMP_SEED_PHRASE || await askQuestion('Enter 12-word seed phrase for the storage peer: ', true);
  if (!seedPhrase || seedPhrase.trim().split(/\s+/).length !== 12) {
    console.error('Invalid seed phrase. Must be exactly 12 words (gmp generate-seed makes one).');
    process.exit(1);
  }
  const { GMPNodeManager } = await import('./gmp-node-manager.js');
  const { storagePeerManagerOptions } = await import('./entry-points.js');
  await startupDiagnostics(seedPhrase);
  const manager = new GMPNodeManager(storagePeerManagerOptions({ seedPhrase }) as GMPNodeManagerOptions);
  try {
    const status = await manager.start();
    const node = manager.node!;
    console.log(`GMP storage peer listening on port ${status.port}`);
    console.log(`NodeID ${status.nodeId}`);
    const { DATA_DIR } = await import('./paths.js');
    const { RELEASE_BUCKET_COUNT } = await import('./storage/sf-crypto.js');
    console.log(`bucketCount ${RELEASE_BUCKET_COUNT} (release-pinned), TTL ${Math.round(node.config.GMP_SF_TTL_MS / 3600000)} h, data ${node.dataDir || DATA_DIR}/storage`);
    console.log(`Clients: GMP_SF_STORAGE_PEER=<this host>:${status.port}#${status.nodeId}`);
    const shutdown = async (): Promise<void> => {
      await manager.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    console.error('Failed to start storage peer:', (e as Error).message);
    process.exit(1);
  }
}

interface MetricsData {
  node: { nodeId: string; uptimeSeconds: number };
  peers: { current: number };
  routing: { tableSize: number; messagesForwarded: number };
  bootstrap: { status: string };
}

interface PeersData {
  nodeId: string;
  address: string;
  port: number;
  type: string;
  isVirtual: boolean;
}

interface RotateResponse {
  newNodeId: string;
}

interface PingResponse {
  rtt: number;
  hops: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const metricsUrl = `http://127.0.0.1:${getMetricsPort()}`;

  switch (command) {
    case 'generate-seed': {
      const seed = generateCryptoSeedPhrase();
      console.log(seed);
      break;
    }
    case 'start': {
      await startNode(false);
      break;
    }
    case 'public-peer': {
      await startNode(true);
      break;
    }
    case 'storage-peer': {
      await startStoragePeer();
      break;
    }
    case 'status': {
      try {
        const data = await getJson<MetricsData>(`${metricsUrl}/metrics`);
        const uptimeStr = formatUptime(data.node.uptimeSeconds);
        const peersCount = `${data.peers.current} connected`;
        const routesCount = `${data.routing.tableSize} known`;
        const forwardedStr = `${formatNumber(data.routing.messagesForwarded)} messages`;
        const statusStr = data.bootstrap.status.charAt(0).toUpperCase() + data.bootstrap.status.slice(1);

        console.log('┌─────────────────────────────┐');
        console.log('│ GhostLink Node Status       │');
        console.log('├─────────────────────────────┤');
        console.log(`│ NodeID:    ${data.node.nodeId.slice(0, 12)}...     │`);
        console.log(`│ Uptime:    ${uptimeStr.padEnd(17)} │`);
        console.log(`│ Peers:     ${peersCount.padEnd(17)} │`);
        console.log(`│ Routes:    ${routesCount.padEnd(17)} │`);
        console.log(`│ Forwarded: ${forwardedStr.padEnd(17)} │`);
        console.log(`│ Status:    ${statusStr.padEnd(17)} │`);
        console.log('└─────────────────────────────┘');
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'peers': {
      try {
        const peers = await getJson<PeersData[]>(`${metricsUrl}/peers`);
        if (peers.length === 0) {
          console.log('No active peer connections.');
          return;
        }
        console.log(`Connected Peers (${peers.length}):`);
        console.log('─'.repeat(70));
        for (const p of peers) {
          const nodeIdTrunc = p.nodeId.slice(0, 16) + '...';
          const typeStr = p.type.toUpperCase();
          const virtualStr = p.isVirtual ? ' (VIRTUAL)' : '';

          let addrStr = p.address;
          if (addrStr && addrStr.includes('.')) {
            const parts = addrStr.split('.');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join('.') + '.x';
          } else if (addrStr && addrStr.includes(':')) {
            const parts = addrStr.split(':');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join(':') + ':x';
          }

          const fullAddr = p.isVirtual ? 'virtual' : `${addrStr}:${p.port}`;
          console.log(`NodeID: ${nodeIdTrunc.padEnd(20)} | Address: ${fullAddr.padEnd(24)} | Type: ${typeStr}${virtualStr}`);
        }
        console.log('─'.repeat(70));
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'rotate-key': {
      try {
        await getJson(`${metricsUrl}/health`);
      } catch (e) {
        console.error('No GMP node running. Start the node before rotating keys.');
        return;
      }

      console.log('=== GhostLink Key Rotation ===');
      console.log('Generating new 12-word seed phrase...');
      const newSeed = generateSeedPhrase();
      console.log('\n----------------------------------------');
      console.log('Your new seed phrase is:');
      console.log(newSeed);
      console.log('----------------------------------------');
      console.log('\nIMPORTANT: Write down this new seed phrase. It will replace your current static key.');

      const written = await askQuestion('\nHave you written this phrase down securely? (y/n): ');
      if (written.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      const confirm = await askQuestion('Are you sure you want to rotate your identity keys now? (y/n): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      try {
        console.log('Initiating rotation flood across the mesh...');
        const res = await postJson<RotateResponse>(`${metricsUrl}/rotate-key`, { newSeedPhrase: newSeed });
        console.log(`\nSuccess! Node identity successfully rotated.`);
        console.log(`New NodeID: ${res.newNodeId}`);
        console.log('The rotation certificate has been flooded. Your configuration files have been updated.');
      } catch (e) {
        const err = e as Error;
        console.error('Rotation failed:', err.message);
      }
      break;
    }
    case 'ping': {
      const target = args[1];
      if (!target) {
        console.error('Usage: gmp ping <nodeId>');
        return;
      }
      try {
        console.log(`Sending virtual ping to ${target.slice(0, 16)}...`);
        const res = await postJson<PingResponse>(`${metricsUrl}/ping`, { targetNodeId: target });
        console.log(`Ping success! RTT = ${res.rtt}ms, Hops = ${res.hops}`);
      } catch (e) {
        const err = e as Error;
        console.error(`Ping failed: ${err.message}`);
      }
      break;
    }
    case 'probe': {
      process.exit(await probeCommand(args.slice(1)));
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      break;
    }
  }
}

/**
 * `gmp probe <host> <port> [--expect <nodeId>] [--timeout <ms>] [--tls]`
 * The deploy verification step (docs/TASKS.md). Exit codes, for scripts:
 *   0 handshake completed (and the NodeID matched --expect, if given)
 *   1 usage error   2 TCP connect failed   3 handshake failed   4 NodeID mismatch
 */
async function probeCommand(argv: string[]): Promise<number> {
  const usage = 'Usage: gmp probe <host> <port> [--expect <nodeId>] [--timeout <ms>] [--tls]';
  const positional: string[] = [];
  let expect: string | null = null;
  let timeoutMs = 10_000;
  let tls = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expect') expect = (argv[++i] || '').toLowerCase();
    else if (a === '--timeout') timeoutMs = Number(argv[++i]);
    else if (a === '--tls') tls = true;
    else if (a.startsWith('--')) { console.error(`Unknown option ${a}\n${usage}`); return 1; }
    else positional.push(a);
  }
  const [host, portArg] = positional;
  const port = Number(portArg);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || positional.length !== 2 || !(timeoutMs > 0)) {
    console.error(usage);
    return 1;
  }
  if (expect !== null && !/^[0-9a-f]{128}$/.test(expect)) {
    console.error(`--expect needs a full 128-hex NodeID (got ${expect.length} characters)\n${usage}`);
    return 1;
  }

  const { probe } = await import('./probe.js');
  console.log(`probe ${host}:${port} (fresh throwaway identity, temporary data dir)`);
  const r = await probe(host, port, { timeoutMs, tls });
  console.log(`  TCP connect    ${r.connectMs === null ? 'FAILED' : `${r.connectMs} ms`}${r.remoteAddress ? ` (${r.remoteAddress})` : ''}`);
  console.log(`  handshake      ${r.ok ? `completed in ${r.handshakeMs} ms` : r.stage === 'connect' ? 'not attempted' : 'FAILED'}`);
  console.log(`  bytes          sent ${r.txBytes}, received ${r.rxBytes}`);
  console.log(`  peer NodeID    ${r.nodeId ?? '-'}`);
  console.log(`  Ghost Address  ${r.ghostAddress ?? '-'}`);
  console.log(`  throwaway      ${r.throwawayFiles.length} state file(s) written to its temporary dir, now removed`);
  if (!r.ok) {
    console.log(`RESULT ${r.stage === 'connect' ? 'CONNECT FAILED' : 'HANDSHAKE FAILED'}: ${r.error}`);
    return r.stage === 'connect' ? 2 : 3;
  }
  if (expect !== null && r.nodeId !== expect) {
    console.log('');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('  !!  NODEID MISMATCH: the host answering is NOT the expected node  !!');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log(`  expected  ${expect}`);
    console.log(`  answered  ${r.nodeId}`);
    console.log('RESULT NODEID MISMATCH');
    return 4;
  }
  console.log(`RESULT OK${expect !== null ? ' (NodeID matches --expect)' : ''}`);
  return 0;
}

function printHelp(): void {
  console.log('GhostMesh Protocol (GMP) Operator CLI');
  console.log('\nUsage:');
  console.log('  gmp start           Starts the GMP node and client bridge');
  console.log('  gmp public-peer     Starts the node as a Public Peer');
  console.log('  gmp storage-peer    Starts a self-hosted store-and-forward mailbox');
  console.log('  gmp status          Queries local node metrics and prints status box');
  console.log('  gmp peers           Lists currently connected peers');
  console.log('  gmp rotate-key      Walks through seed generation and rotating identity keys');
  console.log('  gmp ping <nodeId>   Pings a NodeID through the multi-hop mesh');
  console.log('  gmp generate-seed   Generates a cryptographically random 12-word seed phrase');
  console.log('  gmp probe <host> <port> [--expect <nodeId>] [--timeout <ms>] [--tls]');
  console.log('                      Real GMP handshake from a throwaway identity (temp dir, removed;');
  console.log('                      never touches this node\'s data). Prints connect time, bytes,');
  console.log('                      NodeID and Ghost Address. Exit 0 ok, 2 connect failed,');
  console.log('                      3 handshake failed, 4 NodeID differs from --expect.');
  console.log('                      Deploy check: gmp probe <public peer> <port> --expect <its NodeID>');
}

main().catch((err: unknown) => {
  const error = err as Error;
  console.error('Fatal CLI Error:', error);
  process.exit(1);
});