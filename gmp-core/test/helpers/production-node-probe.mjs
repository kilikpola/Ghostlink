/**
 * Start one node exactly as a production entry point does (entry-points.js +
 * GMPNodeManager, nothing injected), probe its security controls, print one
 * `PROBE {json}` line, stop. Only the environment is controlled.
 *
 *   node production-node-probe.mjs <cli|public-peer|storage-peer|electron>
 *
 * No isolate-data import: the parent sets the environment, and for Electron
 * GMP_DATA_DIR must come from electronDataDir before other modules load.
 */
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const core = (name) => import(pathToFileURL(path.join(dist, name)).href);

const entry = process.argv[2];
const seedPhrase = process.env.PROBE_SEED;

const ep = await core('entry-points.js');
let options;
if (entry === 'electron') {
  // main.js: decide GMP_DATA_DIR first (packaged app), then load the rest.
  const dir = ep.electronDataDir({ isPackaged: true, userDataPath: process.env.PROBE_ELECTRON_USERDATA, env: process.env });
  if (dir) process.env.GMP_DATA_DIR = dir;
  options = ep.electronManagerOptions({ seedPhrase });
} else if (entry === 'cli' || entry === 'public-peer') {
  const { default: config } = await core('config.js'); // cli.ts: `import config from './config.js'`
  options = ep.cliManagerOptions({ seedPhrase, isPublic: entry === 'public-peer', env: process.env, configuredPort: config.GMP_PORT });
} else if (entry === 'storage-peer') {
  options = ep.storagePeerManagerOptions({ seedPhrase });
} else {
  console.error(`unknown entry point ${entry}`);
  process.exit(2);
}

const { GMPNodeManager } = await core('gmp-node-manager.js');
const { DATA_DIR } = await core('paths.js');
const manager = new GMPNodeManager(options);
const out = { entry, options: Object.keys(options).filter((k) => k !== 'seedPhrase'), dataDirEnv: DATA_DIR };
// The manager's resolved config (private in TS): strictState after the role default.
out.strict = manager.config.GMP_STRICT_STATE;
try {
  await manager.start();
  const node = manager.node;
  out.nodeDataDir = node.dataDir;

  // Boot counter: the value this run's ephemerals are bound to.
  out.boot = node.ephemeralSource ? String(node.ephemeralSource.boot) : null;

  // Nonce store: claim a fixed session-key fingerprint. First run: accepted.
  // Every later run: refused — the claim reached disk and survived the restart.
  out.nonceStore = !!node.nonceStore;
  if (node.nonceStore) {
    const peer = new Uint8Array(32).fill(0x42);
    const fp = crypto.createHash('sha256').update(`m4-1 probe ${entry}`).digest('hex');
    out.claimFirst = node.nonceStore.claimSessionKey(peer, fp).valid;
    out.claimAgain = node.nonceStore.claimSessionKey(peer, fp).valid;
    // Counters for that session, as DATA frames would record them: makes
    // nonce-state.json exist after a clean stop, as it does on a real host.
    node.nonceStore.updateCounters(peer, fp, 3, 3);
  }

  // Store-and-forward state: every authenticated handshake on a real host
  // calls learnContact, which writes store-forward.state sealed under the
  // seed. Without this the probe never had that file, and strict-role-test
  // missed that a seed change made it fail with no refusal.
  out.storeForward = !!manager.storeForward;
  if (manager.storeForward) manager.storeForward.learnContact('42'.repeat(64), new Uint8Array(32).fill(0x42));

  // Session-key set: a second insert of one key is reported as a repeat.
  out.sessionKeySet = !!node.sessionKeyLRUSet;
  if (node.sessionKeyLRUSet) {
    const k = crypto.randomBytes(16).toString('hex');
    out.setFirst = node.sessionKeyLRUSet.add(k);
    out.setAgain = node.sessionKeyLRUSet.add(k);
  }

  // Rate limiter: present, and a socket that never sends HELLO is closed.
  out.rateLimiter = !!node.rateLimiter;
  const timeoutMs = Number(process.env.GMP_HELLO_TIMEOUT_MS);
  out.silentClosedMs = await new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(node.port, '127.0.0.1');
    s.on('error', () => {});
    const give = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs * 4);
    s.on('close', () => { clearTimeout(give); resolve(Date.now() - t0); });
  });
} catch (e) {
  out.error = e && e.message;
} finally {
  try { await manager.stop(); } catch { /* stopping */ }
}
console.log(`PROBE ${JSON.stringify(out)}`);
process.exit(0);
