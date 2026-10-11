/**
 * Runs under the Electron binary (ELECTRON_RUN_AS_NODE=1): loads dist/link.js,
 * the lazy TCP transport and LAN discovery, and runs a real TCP handshake.
 * One JSON line per step.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
const out = (step, ok, detail = '') => console.log(JSON.stringify({ step, ok, detail }));
out('runtime', true, JSON.stringify({ electron: process.versions.electron || null, node: process.versions.node }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-electron-'));
try {
  const { createGMPNode } = await import('../../dist/node-factory.js');
  const { DEFAULTS } = await import('../../dist/config.js');
  out('load', true, 'dist/link.js loaded');
  const mk = async (name, lan) => {
    const n = createGMPNode({ config: { ...DEFAULTS, GMP_LAN_DISCOVERY: lan }, dataDir: path.join(tmp, name), port: 0, disableBootstrap: true });
    n.on('error', () => {});
    await n.loadIdentity(`electron runtime probe ${name}`);
    await n.listen();
    return n;
  };
  const a = await mk('a', true);
  const b = await mk('b', false);
  out('default-transport', a.transport.constructor.name === 'TcpTransport', a.transport.constructor.name);
  out('lan-discovery-loaded', !!a.lanDiscovery && a.lanDiscovery.constructor.name === 'LanDiscovery', a.lanDiscovery ? a.lanDiscovery.constructor.name : 'not created');
  const { link } = await a.dial('127.0.0.1', b.port);
  out('tcp-handshake', link.state === 'connected', `connected to ${Buffer.from(link.remoteNodeId).toString('hex').slice(0, 12)}…`);
  a.close(); b.close();
} catch (e) {
  out('error', false, (e && e.stack) || String(e));
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
