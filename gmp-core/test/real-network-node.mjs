/**
 * One node for real-network-ratchet.mjs (R7): a ratchet-capable GMPNodeManager
 * that bootstraps ONLY through the public peer list it is given. Driven over
 * IPC by the parent; reports every received ratchet message with its arrival time.
 */
import crypto from 'crypto';

const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const seed = process.env.RN_SEED;
const m = new GMPNodeManager({ seedPhrase: seed, ratchetCapable: true, ratchets: { memoryOnly: 'real-network test: memory-only' }, storeForward: false });
const send = (o) => process.send(o);
m.on('ratchet-message', ({ fromNodeId, payload, messageId }) => send({ ev: 'received', from: fromNodeId, text: payload.toString('utf8'), messageId, t: Date.now() }));
m.on('ratchet-session-replaced', (i) => send({ ev: 'session-replaced', reason: i.reason }));
const linkInfo = () => [...m.node.connections.values()].filter((l) => l.state === 'connected' && l.remoteNodeId).map((l) => ({
  nodeId: Buffer.from(l.remoteNodeId).toString('hex'), address: l.socket ? l.socket.remoteAddress : null, port: l.socket ? l.socket.remotePort : null,
  path: l.isVirtual ? 'mesh-routed (virtual)' : l.socket && l.socket.isRelayed ? 'relayed' : 'direct',
}));
process.on('message', async (cmd) => {
  try {
    if (cmd.op === 'start') { const r = await m.start(); send({ ev: 'started', nodeId: r.nodeId, port: r.port }); }
    else if (cmd.op === 'links') send({ ev: 'links', links: linkInfo() });
    else if (cmd.op === 'debug') {
      const d = (l, where) => ({ where, state: l.state, isVirtual: !!l.isVirtual, remoteNodeIdBytes: l.remoteNodeId ? l.remoteNodeId.length : null,
        remoteHead: l.remoteNodeId ? Buffer.from(l.remoteNodeId).toString('hex').slice(0, 16) : null, hasStatic: !!l.remoteStaticPubkey });
      send({ ev: 'debug', conns: [...m.node.connections.values()].map((l) => d(l, 'connections')), virt: [...m.node.virtualConnections.entries()].map(([k, l]) => ({ key: k.slice(0, 16), keyLen: k.length, ...d(l, 'virtual') })) });
    }
    else if (cmd.op === 'connect') {
      // As the app's Ghost Address lookup does: ask the mesh for a route first.
      let routed = null;
      try { routed = await m.node.topologyManager.queryRoute(cmd.nodeId); } catch (e) { routed = `threw: ${e.message}`; }
      let r = await m.connectByNodeId(cmd.nodeId);
      let why = routed === true ? null : `route query: ${routed}`;
      if (!r.connected) { try { await m.node.dialVirtual(Buffer.from(cmd.nodeId, 'hex')); r = { connected: true, transport: 'virtual' }; } catch (e) { why = `${why ? why + '; ' : ''}dial: ${e.message}`; } }
      send({ ev: 'connected', ...r, why, links: linkInfo() });
    }
    else if (cmd.op === 'send') {
      const v = m.node.virtualConnections.get(cmd.to.slice(0, 64));
      const link = m.node.getLinkByNodeId(cmd.to) || (v && v.state === 'connected' ? v : null);
      const via = link && link.isVirtual ? [...m.node.connections.values()].find((l) => l.state === 'connected' && !l.isVirtual) : null;
      const pathNow = !link ? 'none' : link.isVirtual ? `mesh-routed via ${via ? Buffer.from(via.remoteNodeId).toString('hex').slice(0, 8) : '?'}` : link.socket && link.socket.isRelayed ? 'relayed' : 'direct';
      const t = Date.now();
      const r = await m.ratchetSend(cmd.to, Buffer.from(cmd.text));
      send({ ev: 'sent', text: cmd.text, t, messageId: r.messageId, kind: r.kind, path: pathNow });
    } else if (cmd.op === 'stop') { await m.stop(); send({ ev: 'stopped' }); process.exit(0); }
  } catch (e) { send({ ev: 'error', op: cmd.op, name: e.name, message: e.message }); }
});
send({ ev: 'ready', pid: process.pid, id: crypto.randomBytes(2).toString('hex') });
