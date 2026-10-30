/**
 * R7 over the REAL network: two node processes on this machine, each
 * bootstrapping only through hayabusa.proxy.rlwy.net:58516 (LAN discovery off),
 * reach each other by NodeID and exchange 10 ratchet messages each way.
 * Prints per-message latency (send → receive, same clock) and the path each
 * took; checks the Railway peer's NodeID against the pinned one. Never fakes a
 * result: an unreachable peer is reported as such and the run fails.
 *
 *   node test/real-network-ratchet.mjs      (needs network; not part of run-all)
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'hayabusa.proxy.rlwy.net', PORT = 58516;
const pinned = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'public-peers.json'), 'utf8')).find((p) => p.address === HOST && p.port === PORT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-real-'));
const peersFile = path.join(tmp, 'public-peers.json');
fs.writeFileSync(peersFile, JSON.stringify([pinned]));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const line = (s) => console.log(s);
const fail = (s) => { failures++; console.error(`  ✗ ${s}`); };

function spawnNode(label) {
  const dir = path.join(tmp, label);
  fs.mkdirSync(dir);
  const child = fork(path.join(here, 'real-network-node.mjs'), [], {
    env: { ...process.env, RN_SEED: `r7 real network ${label} ${crypto.randomBytes(8).toString('hex')}`, GMP_DATA_DIR: dir, GMP_PUBLIC_PEERS_PATH: peersFile,
      GMP_LAN_DISCOVERY: 'false', GMP_PORT: '0', GMP_METRICS_PORT: '0', GMP_LOG_LEVEL: 'WARN' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const events = [];
  const waiters = [];
  child.on('message', (m) => { events.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred, ms = 30000) => new Promise((resolve) => {
    const found = events.find(pred); if (found) { events.splice(events.indexOf(found), 1); return resolve(found); }
    const w = { pred: (m) => { if (pred(m)) { events.splice(events.indexOf(m), 1); return true; } return false; }, resolve };
    waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
  });
  const ask = (cmd, pred, ms) => { child.send(cmd); return next(pred, ms); };
  return { label, child, ask, next, log: () => log };
}

const A = spawnNode('alice'), B = spawnNode('bob');
try {
  await Promise.all([A.next((m) => m.ev === 'ready'), B.next((m) => m.ev === 'ready')]);
  const [sa, sb] = await Promise.all([A.ask({ op: 'start' }, (m) => m.ev === 'started' || m.ev === 'error', 60000), B.ask({ op: 'start' }, (m) => m.ev === 'started' || m.ev === 'error', 60000)]);
  if (!sa || sa.ev !== 'started' || !sb || sb.ev !== 'started') throw new Error(`a node did not start: ${JSON.stringify(sa)} ${JSON.stringify(sb)}`);
  line(`alice ${sa.nodeId.slice(0, 16)}…  bob ${sb.nodeId.slice(0, 16)}…`);
  let la = null, lb = null;
  for (let i = 0; i < 40; i++) {
    la = (await A.ask({ op: 'links' }, (m) => m.ev === 'links')).links;
    lb = (await B.ask({ op: 'links' }, (m) => m.ev === 'links')).links;
    if (la.some((l) => l.nodeId === pinned.nodeId) && lb.some((l) => l.nodeId === pinned.nodeId)) break;
    await delay(500);
  }
  const ra = la.find((l) => l.nodeId === pinned.nodeId), rb = lb.find((l) => l.nodeId === pinned.nodeId);
  if (!ra || !rb) {
    fail(`the Railway peer ${HOST}:${PORT} was NOT reached (alice links ${JSON.stringify(la)}, bob links ${JSON.stringify(lb)})`);
    throw new Error('peer unreachable');
  }
  line(`Railway peer: both nodes hold a handshaken link to ${HOST}:${PORT}; its proven NodeID ${ra.nodeId.slice(0, 16)}…${ra.nodeId.slice(-4)} equals the pinned ${pinned.nodeId.slice(0, 16)}…${pinned.nodeId.slice(-4)}: ${ra.nodeId === pinned.nodeId && rb.nodeId === pinned.nodeId}`);
  const others = (links) => links.filter((l) => l.nodeId !== pinned.nodeId).map((l) => l.nodeId.slice(0, 8));
  line(`other links before connecting: alice ${JSON.stringify(others(la))}, bob ${JSON.stringify(others(lb))}`);
  // Route and virtual handshake through the public peer take a while and often time out: try for ~2.5 min, and show every attempt.
  let conn = null;
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 20; attempt++) {
    conn = await B.ask({ op: 'connect', nodeId: sa.nodeId }, (m) => m.ev === 'connected' || m.ev === 'error', 60000);
    line(`  connect attempt ${attempt} at +${((Date.now() - t0) / 1000).toFixed(1)} s: ${conn && conn.connected ? `connected (${conn.transport})` : `failed (${conn && (conn.why || conn.message || conn.transport)})`}`);
    if (conn && conn.connected) break;
    await delay(3000);
  }
  if (!conn || conn.ev !== 'connected' || !conn.connected) { fail(`bob could not reach alice by NodeID: ${JSON.stringify(conn)}`); throw new Error('no path'); }
  const ab = conn.links.find((l) => l.nodeId === sa.nodeId);
  line(`bob → alice by NodeID: connected via ${conn.transport} (${ab ? `${ab.path}, ${ab.address}:${ab.port}` : 'link not listed'})`);
  await delay(1000);
  for (const [n, who] of [['alice', A], ['bob', B]]) { const dbg = await who.ask({ op: 'debug' }, (m) => m.ev === 'debug'); line(`  debug ${n}: ${JSON.stringify(dbg)}`); }
  const rows = [];
  for (let i = 0; i < 10; i++) {
    for (const [from, to, toId, name] of [[A, B, sb.nodeId, 'alice→bob'], [B, A, sa.nodeId, 'bob→alice']]) {
      const text = `${name} #${i} ${crypto.randomBytes(4).toString('hex')}`;
      const sent = await from.ask({ op: 'send', to: toId, text }, (m) => (m.ev === 'sent' && m.text === text) || (m.ev === 'error' && m.op === 'send'), 30000);
      if (!sent || sent.ev !== 'sent') { fail(`${name} #${i}: send failed ${JSON.stringify(sent)}`); continue; }
      const got = await to.next((m) => m.ev === 'received' && m.text === text, 30000);
      if (!got) { fail(`${name} #${i}: never arrived`); continue; }
      rows.push({ name, i, ms: got.t - sent.t, path: sent.path, kind: sent.kind, id: sent.messageId.slice(0, 8), idOk: got.messageId === sent.messageId });
    }
  }
  line('\n  message          kind     path                     latency');
  for (const r of rows) line(`  ${r.name} #${String(r.i).padEnd(2)}  ${r.kind.padEnd(8)} ${r.path.padEnd(24)} ${String(r.ms).padStart(5)} ms   id ${r.id}${r.idOk ? '' : ' (messageId MISMATCH)'}`);
  const lat = rows.map((r) => r.ms).sort((x, y) => x - y);
  if (rows.length) line(`\n  ${rows.length}/20 delivered; latency min ${lat[0]} / median ${lat[Math.floor(lat.length / 2)]} / max ${lat[lat.length - 1]} ms; paths: ${[...new Set(rows.map((r) => r.path))].join(', ')}`);
  if (rows.length !== 20 || rows.some((r) => !r.idOk)) fail(`only ${rows.length}/20 delivered intact`);
} catch (e) {
  if (!failures) fail(`harness: ${e.message}`);
  console.error(`  alice log tail:\n${A.log().split('\n').slice(-8).join('\n')}\n  bob log tail:\n${B.log().split('\n').slice(-8).join('\n')}`);
} finally {
  for (const n of [A, B]) { try { n.child.send({ op: 'stop' }); } catch {} }
  await delay(1500);
  for (const n of [A, B]) { try { n.child.kill('SIGKILL'); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
