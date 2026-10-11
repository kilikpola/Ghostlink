/**
 * One node of one build, for test/interop-old-new.mjs, in its own process.
 *
 *   node interop-runner.mjs <gmp-core dir> listen [plain|public|relay]
 *       prints "PORT n" (and "STRICT x MINPEERS y" for public), then
 *       "SEEN <nodeId>" for every connection and "LINKED <nodeId>" for every
 *       link's remote identity, relay hop sessions included; echoes each message as
 *       "pong:<first 16 chars>:<length>" and greets with "hello-from-listener".
 *       Stops on SIGTERM.
 *   node interop-runner.mjs <gmp-core dir> dial <port>
 *       prints "RESULT {...}": handshake, greeting, three echoed messages.
 *   node interop-runner.mjs <gmp-core dir> reserve <port>
 *       reserves a relay hop on that port; prints "RESULT {...}" with this
 *       node's real NodeID, which the relay must never see.
 *
 * Works with builds with and without node-factory.js.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

const [core, mode, arg] = process.argv.slice(2);
const dist = (f) => import(pathToFileURL(path.join(core, 'dist', f)).href);
// A fresh identity per run, built from word indices (no phrase in the source).
const { BIP39_WORDS } = await dist('bip39-english.js');
const seed = Array.from({ length: 12 }, () => BIP39_WORDS[crypto.randomInt(BIP39_WORDS.length)]).join(' ');
const hasFactory = fs.existsSync(path.join(core, 'dist', 'node-factory.js'));

async function plainNode() {
  const opts = { port: 0, disableBootstrap: true, lanDiscovery: false };
  let node;
  if (hasFactory) node = (await dist('node-factory.js')).createGMPNode(opts);
  else node = new (await dist('link.js')).GMPNode(opts);
  node.on('error', () => {});
  await node.loadIdentity(seed);
  return node;
}

if (mode === 'listen') {
  let node, manager = null;
  if (arg === 'public') {
    // The shipped public-peer construction path.
    const ep = await dist('entry-points.js');
    const { GMPNodeManager } = await dist('gmp-node-manager.js');
    manager = new GMPNodeManager(ep.cliManagerOptions({ seedPhrase: seed, isPublic: true, env: { PORT: '0' }, configuredPort: undefined }));
    await manager.start();
    node = manager.node;
    process.stdout.write(`STRICT ${manager.config.GMP_STRICT_STATE} MINPEERS ${manager.config.GMP_MIN_PEERS}\n`);
  } else {
    node = await plainNode();
    await node.listen();
  }
  node.on('connection', ({ link, peerNodeId }) => {
    process.stdout.write(`SEEN ${Buffer.from(peerNodeId).toString('hex')}\n`);
    link.on('message', (m) => { link.send(`pong:${m.slice(0, 16)}:${m.length}`).catch(() => {}); });
    link.send('hello-from-listener').catch(() => {});
  });
  // Every link's remote NodeID, hop sessions included (they emit no
  // 'connection'): what this host has seen, for the relay pairing.
  const linked = new Set();
  setInterval(() => {
    for (const l of node.links.values()) {
      const id = l.remoteNodeId ? Buffer.from(l.remoteNodeId).toString('hex') : null;
      if (id && !linked.has(id)) { linked.add(id); process.stdout.write(`LINKED ${id}\n`); }
    }
  }, 50).unref();
  process.stdout.write(`PORT ${node.port}\n`);
  process.on('SIGTERM', async () => { if (manager) await manager.stop(); else node.close(); process.exit(0); });
} else if (mode === 'dial') {
  const node = await plainNode();
  const t0 = Date.now();
  const got = [];
  let res;
  try {
    const { link, peerNodeId } = await node.dial('127.0.0.1', Number(arg));
    link.on('message', (m) => got.push(m));
    const sent = ['ping-1', 'ping-2-' + 'x'.repeat(3000), 'ping-3-ünïcødé'];
    for (const m of sent) await link.send(m);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && got.filter((g) => g.startsWith('pong:')).length < sent.length) await new Promise((r) => setTimeout(r, 50));
    const pongs = got.filter((g) => g.startsWith('pong:'));
    res = {
      handshake: true, ms: Date.now() - t0, peer: Buffer.from(peerNodeId).toString('hex').slice(0, 12),
      helloFromListener: got.includes('hello-from-listener'), pongs: pongs.length, sent: sent.length,
      lensOk: sent.every((m) => pongs.includes(`pong:${m.slice(0, 16)}:${m.length}`)),
    };
  } catch (e) {
    res = { handshake: false, error: e.message };
  }
  process.stdout.write(`RESULT ${JSON.stringify(res)}\n`);
  node.close();
  process.exit(0);
} else if (mode === 'reserve') {
  const node = await plainNode();
  let res;
  try {
    const r = await node.reserveRelay({ address: '127.0.0.1', port: Number(arg) }, { autoRenew: false });
    res = { reserved: !!(r && r.voucherId), me: node.identity.nodeIdHex };
  } catch (e) {
    res = { reserved: false, me: node.identity.nodeIdHex, error: e.message };
  }
  process.stdout.write(`RESULT ${JSON.stringify(res)}\n`);
  await new Promise((r) => setTimeout(r, 300)); // let the relay print what it saw
  node.close();
  process.exit(0);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
