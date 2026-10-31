/**
 * One instrumented node for real-network-links.mjs (task L1). Investigation
 * only: it wraps GMPLink / node methods IN THIS PROCESS to timestamp every
 * handshake step; no product code changes. Driven over IPC by the parent.
 *
 * Events (t = Date.now()):
 *   hello-sent / hello-recv / ack-sent / ack-recv / ping-sent / ping-recv / pong-sent / pong-recv
 *   hello-dropped        a HELLO reached a link that was not 'handshaking' (link.ts:488 returns silently)
 *   state                every link state change
 *   destroy              with the reason
 *   routed-in            a routed payload for a virtual link: to an existing link (its tag/state) or a new one
 *   no-route             VirtualSocket could not route a write
 *   route-query          start/end/result
 *   dial                 dialVirtual start/end/result
 *   data-sent / data-recv  DATA frames on virtual links
 */
import crypto from 'crypto';

const { GMPNodeManager } = await import('../dist/gmp-node-manager.js');
const { GMPLink } = await import('../dist/link/link.js');
const seed = process.env.RN_SEED;
const events = [];
const ev = (type, o = {}) => events.push({ t: Date.now(), type, ...o });
const tags = new WeakMap();
let nTag = 0;
const tag = (l) => { if (!tags.has(l)) tags.set(l, `${l.isVirtual ? 'V' : 'T'}${l.isInitiator ? 'i' : 'r'}${++nTag}`); return tags.get(l); };
const peer = (l) => (l.remoteNodeId ? Buffer.from(l.remoteNodeId).toString('hex').slice(0, 8) : null);
const P = GMPLink.prototype;
const wrap = (name, before, after) => {
  const orig = P[name];
  if (typeof orig !== 'function') return;
  P[name] = function (...args) {
    const s0 = this.state;
    if (before) before.call(this, s0, args);
    const r = orig.apply(this, args);
    if (after) after.call(this, s0, args);
    return r;
  };
};
const onlyVirtual = (fn) => function (...a) { if (this.isVirtual) fn.apply(this, a); };
wrap('_sendHELLO', onlyVirtual(function (s0) { ev('hello-sent', { link: tag(this), state: s0 }); }));
wrap('_handleHELLO', onlyVirtual(function (s0) { ev(s0 === 'handshaking' ? 'hello-recv' : 'hello-dropped', { link: tag(this), state: s0 }); }));
wrap('_sendHELLO_ACK', onlyVirtual(function (s0) { ev('ack-sent', { link: tag(this), state: s0 }); }));
wrap('_handleHELLO_ACK', onlyVirtual(function (s0) { ev('ack-recv', { link: tag(this), state: s0 }); }));
wrap('_sendPING', onlyVirtual(function (s0) { ev('ping-sent', { link: tag(this), state: s0 }); }));
wrap('_handlePING', onlyVirtual(function (s0) { ev('ping-recv', { link: tag(this), state: s0 }); }), onlyVirtual(function (s0) { if (s0 !== this.state) ev('state', { link: tag(this), from: s0, to: this.state, why: 'key-confirm PING' }); }));
wrap('_sendPONG', onlyVirtual(function (s0) { ev('pong-sent', { link: tag(this), state: s0 }); }));
wrap('_handlePONG', onlyVirtual(function (s0) { ev('pong-recv', { link: tag(this), state: s0 }); }));
wrap('_handleDATA', onlyVirtual(function (s0) { ev('data-recv', { link: tag(this), state: s0 }); }));
wrap('send', onlyVirtual(function (s0) { ev('data-sent', { link: tag(this), state: s0 }); }));
wrap('destroy', onlyVirtual(function (s0, [err]) { ev('destroy', { link: tag(this), state: s0, peer: peer(this), reason: err ? err.message : null }); }));
// Non-virtual links too: every close, with its reason, and every new connection (duplicate links to the same peer show here).
wrap('destroy', function (s0, [err]) { if (!this.isVirtual) ev('tlink-destroy', { link: tag(this), state: s0, peer: peer(this), reason: err ? err.message : null }); });
wrap('_handleClose', function (s0) { if (!this.isVirtual) ev('tlink-close', { link: tag(this), state: s0, peer: peer(this) }); });

const m = new GMPNodeManager({ seedPhrase: seed, ratchetCapable: true, ratchets: { memoryOnly: 'L1 investigation: memory-only' }, storeForward: false });
const send = (o) => process.send(o);
m.on('ratchet-message', ({ payload, messageId }) => { ev('ratchet-recv', { text: payload.toString('utf8'), messageId }); send({ ev: 'received', text: payload.toString('utf8'), messageId, t: Date.now() }); });
m.on('bootstrap-complete', ({ peersConnected }) => ev('bootstrap-complete', { peersConnected }));

function instrumentNode(node) {
  const origRouted = node.handleIncomingRoutedPayload.bind(node);
  node.handleIncomingRoutedPayload = (source, payload) => {
    const existing = node.virtualConnections.get(Buffer.from(source).toString('hex').slice(0, 64));
    ev('routed-in', { from: Buffer.from(source).toString('hex').slice(0, 8), to: existing ? tag(existing) : 'new', state: existing ? existing.state : null, bytes: payload.length });
    return origRouted(source, payload);
  };
  node.on('no-route', ({ finalDestinationNodeId }) => ev('no-route', { to: finalDestinationNodeId.slice(0, 8) }));
  // Every routed packet that reaches this node, before anything can drop it.
  const fwd = node.forwarder;
  const origProc = fwd.processIncoming.bind(fwd);
  fwd.processIncoming = (plaintext, link) => {
    const routed = plaintext && plaintext.length >= 66 && plaintext[0] === 0x01;
    const r = origProc(plaintext, link);
    if (routed) {
      const src = Buffer.from(plaintext.slice(1, 33)).toString('hex');
      ev('fwd-in', { from: src.slice(0, 8), local: !!(r && r.local), result: r ? (r.local ? 'local' : (r.error || 'forwarded/consumed')) : 'false', banned: !!(node.reputation && node.reputation.isBanned(src)), bytes: plaintext.length - 66 });
    }
    return r;
  };
  node.on('connection', ({ link, type }) => { if (link.isVirtual) ev('connected', { link: tag(link), dir: type, peer: peer(link) }); else ev('tlink-open', { link: tag(link), dir: type, peer: peer(link), relayed: !!(link.socket && link.socket.isRelayed), linksToSamePeer: [...node.connections.values()].filter((l) => !l.isVirtual && l.remoteNodeId && peer(l) === peer(link)).length }); });
  // Route to the other trial node: every rebuild that adds or removes it, and who called the rebuild.
  const tm = node.topologyManager;
  const origRebuild = tm.rebuildRoutingTable.bind(tm);
  tm.rebuildRoutingTable = () => {
    const target = process.env.RN_TARGET;
    const before = target ? !!node.routingTable.getBestRoute(target) : null;
    const r = origRebuild();
    const after = target ? !!node.routingTable.getBestRoute(target) : null;
    if (target && before !== after) {
      const caller = (new Error().stack || '').split('\n').slice(2, 5).map((x) => x.trim().replace(/^at /, '').replace(/\(.*\/dist\//, '(')).join(' < ');
      const edges = tm.lsdb.get(target);
      ev('route-change', { to: after ? 'present' : 'gone', caller, edgesOfTarget: edges ? [...edges.entries()].map(([k, e]) => ({ to: k.slice(0, 8), ageMs: Date.now() - e.timestamp, withdrawn: !!e.withdrawn })) : null });
    }
    return r;
  };
  const rt = node.routingTable;
  for (const name of ['removeRoute', 'removeRoutesVia', 'pruneExpired']) {
    const o = rt[name].bind(rt);
    rt[name] = (...args) => { const t = process.env.RN_TARGET; const b = t ? !!rt.getBestRoute(t) : null; const r = o(...args); const a = t ? !!rt.getBestRoute(t) : null; if (t && b && !a) ev('route-change', { to: 'gone', caller: `routingTable.${name}` }); return r; };
  }
}
const hayabusaBytes = () => {
  for (const l of node().connections.values()) {
    if (!l.isVirtual && l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === process.env.RN_PEER) {
      const s = l.socket && (l.socket.socket || l.socket);
      return { written: s?.bytesWritten ?? null, read: s?.bytesRead ?? null };
    }
  }
  return null;
};
const node = () => m.node;
const virt = (id) => { const v = node().virtualConnections.get(id.slice(0, 64)); return v ? { tag: tag(v), state: v.state, isInitiator: v.isInitiator } : null; };

process.on('message', async (cmd) => {
  try {
    if (cmd.op === 'start') {
      const r = await m.start(); instrumentNode(node()); ev('started');
      send({ ev: 'started', nodeId: r.nodeId });
    } else if (cmd.op === 'links') {
      send({ ev: 'links', peerLink: [...node().connections.values()].some((l) => l.state === 'connected' && l.remoteNodeId && Buffer.from(l.remoteNodeId).toString('hex') === process.env.RN_PEER) });
    } else if (cmd.op === 'target') { process.env.RN_TARGET = cmd.nodeId; send({ ev: 'target-set' });
    } else if (cmd.op === 'connect') {
      // One attempt = what the app's lookup path does: a route query, then one virtual dial.
      ev('route-query', { phase: 'start' });
      let routed;
      try { routed = await node().topologyManager.queryRoute(cmd.nodeId); } catch (e) { routed = `threw: ${e.message}`; }
      ev('route-query', { phase: 'end', result: routed, haveRoute: !!node().routingTable.getBestRoute(cmd.nodeId) });
      let result = 'skipped (no route)';
      if (node().routingTable.getBestRoute(cmd.nodeId)) {
        ev('dial', { phase: 'start' });
        try { await node().dialVirtual(Buffer.from(cmd.nodeId, 'hex')); result = 'connected'; } catch (e) { result = e.message; }
        ev('dial', { phase: 'end', result });
      }
      send({ ev: 'connect-result', routed, result, virt: virt(cmd.nodeId) });
    } else if (cmd.op === 'state') {
      send({ ev: 'state', virt: virt(cmd.nodeId) });
    } else if (cmd.op === 'send') {
      let r;
      try { const x = await m.ratchetSend(cmd.to, Buffer.from(cmd.text)); r = { ok: true, messageId: x.messageId }; } catch (e) { r = { ok: false, error: e.name }; }
      ev('ratchet-send', { text: cmd.text, ...r, virt: virt(cmd.to) });
      send({ ev: 'sent', text: cmd.text, t: Date.now(), ...r });
    } else if (cmd.op === 'dump') {
      send({ ev: 'dump', events, bytes: hayabusaBytes() });
    } else if (cmd.op === 'stop') { await m.stop(); process.exit(0); }
  } catch (e) { send({ ev: 'error', op: cmd.op, name: e.name, message: e.message }); }
});
send({ ev: 'ready', pid: process.pid, id: crypto.randomBytes(2).toString('hex') });
