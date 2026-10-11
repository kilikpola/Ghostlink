/**
 * NullTransport proof body. Runs in a process where importing net / tls / dgram
 * throws (test/helpers/block-net.mjs). Prints one JSON line per step.
 */
import './isolate-data.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
const { createGMPNode } = await import('../../dist/node-factory.js');
const { DEFAULTS } = await import('../../dist/config.js');
const { NullNetwork, NullTransport } = await import('../../dist/transport/null-transport.js');
const { StoreForward } = await import('../../dist/storage/store-forward.js');
const { holePunchConnect } = await import('../../dist/hole-punch.js');

const out = (step, ok, detail = '') => console.log(JSON.stringify({ step, ok, detail }));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-null-'));
const net = new NullNetwork();
const nodes = [];
let n = 0;
async function mk(seed, cfg = {}) {
  const node = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: false, GMP_SF_DEPOSIT_BURST: 1e6, ...cfg }, dataDir: path.join(tmp, `n${n++}`), port: 0, transport: new NullTransport(net) });
  node.on('error', () => {});
  nodes.push(node);
  await node.loadIdentity(seed);
  await node.listen();
  return node;
}

try {
  const A = await mk('null proof alice');
  const B = await mk('null proof bob');
  out('transport', A.transport.constructor.name === 'NullTransport' && B.transport.constructor.name === 'NullTransport', A.transport.constructor.name);

  // 1. handshake + DATA both ways
  const got = { a: [], b: [] };
  B.on('message', ({ msg }) => got.b.push(msg));
  A.on('message', ({ msg }) => got.a.push(msg));
  const { link } = await A.dial('null', B.port);
  out('handshake', link.state === 'connected' && Buffer.from(link.remoteNodeId).toString('hex') === B.identity.nodeIdHex, `A authenticated B ${B.identity.nodeIdHex.slice(0, 12)}…`);
  await link.send('hello over NullTransport');
  await delay(50);
  const back = B.getLinkByNodeId(A.identity.nodeId);
  await back.send('and back');
  await delay(50);
  out('data', got.b[0] === 'hello over NullTransport' && got.a[0] === 'and back', JSON.stringify(got));

  // 2. relay circuit through R
  const R = await mk('null proof relay', { GMP_RELAY_ENABLED: true });
  const C = await mk('null proof carol');
  const res = await C.reserveRelay({ address: 'null', port: R.port });
  const D = await mk('null proof dave');
  const relayed = [];
  C.on('message', ({ msg }) => relayed.push(msg));
  const out1 = await D.dialRelayed({ address: 'null', port: R.port }, res.voucherId, C.identity.staticPubKey);
  await out1.link.send('through the relay');
  await delay(100);
  out('relay-circuit', relayed[0] === 'through the relay' && out1.link.socket.isRelayed === true, `circuit ${out1.link.socket.isRelayed ? 'relayed' : 'direct'}, relay held ${R.relayServer.getStats().reservationsActive} reservation(s)`);

  // 3. store-and-forward round trip with the receipt blob
  const S = await mk('null proof storage', { GMP_STORAGE_ENABLED: true });
  const mailbox = { address: 'null', port: S.port };
  const E = await mk('null proof erin');
  const F = await mk('null proof frank');
  const sfE = new StoreForward({ host: E, fetchBuckets: 4, ownMailbox: () => mailbox });
  const sfF = new StoreForward({ host: F, fetchBuckets: 4, ownMailbox: () => mailbox });
  sfE.learnContact(F.identity.nodeIdHex, F.identity.staticPubKey);
  sfF.learnContact(E.identity.nodeIdHex, E.identity.staticPubKey);
  const states = [];
  sfE.on('stored', (e) => states.push(`stored:${e.localId}`));
  sfE.on('delivered', (e) => states.push(`delivered:${e.localId}`));
  const inbox = [];
  sfF.on('message', (m) => inbox.push(m.payload));
  await sfE.send(F.identity.nodeIdHex, 'offline message over NullTransport', 'n1');
  await sfF.poll('foreground');   // reads it, queues the receipt
  await sfF.poll('interval');     // deposits the receipt
  await sfE.poll('interval');     // finds the receipt
  out('store-and-forward', inbox[0] === 'offline message over NullTransport' && states.join() === 'stored:n1,delivered:n1',
    `${states.join(' ')}; host holds ${S.storageServer.getStats().blobs} blobs (message + receipt, no delete)`);

  // 4. hole punching goes through the transport too
  const G = await mk('null proof gina');
  const H = await mk('null proof hank');
  const hp = await holePunchConnect({ node: G, peerNodeId: H.identity.nodeIdHex, peerObservedAddress: { address: 'null', port: H.port }, attemptTimestamp: Date.now(), timeoutMs: 2000 });
  out('hole-punch', hp.link.state === 'connected', 'simultaneous-open path over NullTransport');

  // 5. nothing loaded Node's socket modules (the hook would have thrown)
  out('no-socket-modules', true, 'net, tls and dgram were blocked for the whole run');
} catch (e) {
  out('error', false, e.stack || e.message);
}
for (const node of nodes) { try { node.close(); } catch { /* closed */ } }
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
