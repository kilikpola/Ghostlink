/**
 * L1: mesh link setup through the live public peer, measured. N independent
 * trials (default 20), two fresh node processes each, both bootstrapping ONLY
 * via hayabusa.proxy.rlwy.net:58516 (LAN off). Per trial: bootstrap, route
 * query, every virtual-link handshake step on both sides (instrumented in the
 * child processes), key-confirm, ≤ 5 ratchet messages. Prints a per-stage
 * median / max table, failure classes and the bytes that crossed the Railway link.
 *
 *   node test/real-network-links.mjs [N] [--log out.json]     (needs network; not in run-all)
 *
 * Classes: (a) route query never answered, (b) route known but the handshake
 * never completed, (c) half-open: the initiator believes the link is up and the
 * responder does not, or a send reported as sent never arrives, (d) other.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2]) || 20;
const logOut = process.argv.includes('--log') ? process.argv[process.argv.indexOf('--log') + 1] : null;
const HOST = 'hayabusa.proxy.rlwy.net', PORT = 58516;
const pinned = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'public-peers.json'), 'utf8')).find((p) => p.address === HOST && p.port === PORT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-links-'));
const peersFile = path.join(tmp, 'public-peers.json');
fs.writeFileSync(peersFile, JSON.stringify([pinned]));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnNode(label) {
  const dir = path.join(tmp, `${label}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir);
  const child = fork(path.join(here, 'real-network-link-node.mjs'), [], {
    env: { ...process.env, RN_SEED: `l1 ${label} ${crypto.randomBytes(8).toString('hex')}`, RN_PEER: pinned.nodeId, GMP_DATA_DIR: dir,
      GMP_PUBLIC_PEERS_PATH: peersFile, GMP_LAN_DISCOVERY: 'false', GMP_PORT: '0', GMP_METRICS_PORT: '0', GMP_LOG_LEVEL: 'WARN' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const inbox = [];
  const waiters = [];
  child.on('message', (m) => { inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); inbox.splice(inbox.indexOf(m), 1); w.resolve(m); } });
  const next = (pred, ms = 30000) => new Promise((resolve) => {
    const i = inbox.findIndex(pred); if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
    const w = { pred, resolve }; waiters.push(w);
    setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, ms);
  });
  const ask = (cmd, pred, ms) => { child.send(cmd); return next(pred, ms); };
  return { label, child, ask, next, log: () => log };
}

async function trial(k) {
  const T = { k, t0: Date.now(), attempts: [], sends: [], cls: null, evidence: [] };
  const A = spawnNode('alice'), B = spawnNode('bob');
  try {
    await Promise.all([A.next((m) => m.ev === 'ready'), B.next((m) => m.ev === 'ready')]);
    const [sa, sb] = await Promise.all([A.ask({ op: 'start' }, (m) => m.ev === 'started' || m.ev === 'error', 60000), B.ask({ op: 'start' }, (m) => m.ev === 'started' || m.ev === 'error', 60000)]);
    if (sa?.ev !== 'started' || sb?.ev !== 'started') { T.cls = 'd'; T.evidence.push(`start failed: ${JSON.stringify(sa)} ${JSON.stringify(sb)}`); return T; }
    T.a = sa.nodeId; T.b = sb.nodeId;
    await Promise.all([A.ask({ op: 'target', nodeId: T.b }, (m) => m.ev === 'target-set'), B.ask({ op: 'target', nodeId: T.a }, (m) => m.ev === 'target-set')]);
    let booted = false;
    for (let i = 0; i < 40 && !booted; i++) {
      const [la, lb] = await Promise.all([A.ask({ op: 'links' }, (m) => m.ev === 'links'), B.ask({ op: 'links' }, (m) => m.ev === 'links')]);
      booted = la?.peerLink && lb?.peerLink;
      if (!booted) await delay(500);
    }
    T.tBoot = Date.now() - T.t0;
    if (!booted) { T.cls = 'd'; T.evidence.push('a node never reached the Railway peer'); return T; }
    const tConnect0 = Date.now();
    for (let i = 0; i < 6; i++) {
      const r = await B.ask({ op: 'connect', nodeId: T.a }, (m) => m.ev === 'connect-result' || m.ev === 'error', 30000);
      T.attempts.push({ at: Date.now() - tConnect0, routed: r?.routed, result: r?.result ?? r?.message, virt: r?.virt });
      if (r?.result === 'connected') break;
      await delay(2000);
    }
    const connected = T.attempts.some((x) => x.result === 'connected');
    T.tConnect = connected ? T.attempts.find((x) => x.result === 'connected').at : null;
    if (connected) {
      await delay(500);
      const plan = [[B, A, T.a, 'b'], [A, B, T.b, 'a'], [B, A, T.a, 'b'], [A, B, T.b, 'a'], [B, A, T.a, 'b']];
      for (let i = 0; i < plan.length; i++) {
        const [from, to, toId, who] = plan[i];
        const text = `${who}${i}-${crypto.randomBytes(3).toString('hex')}`;
        const s = await from.ask({ op: 'send', to: toId, text }, (m) => m.ev === 'sent' && m.text === text, 15000);
        const got = s?.ok ? await to.next((m) => m.ev === 'received' && m.text === text, 8000) : null;
        T.sends.push({ who, ok: !!s?.ok, error: s?.error ?? null, arrived: !!got, ms: got && s ? got.t - s.t : null });
      }
    }
    const [da, db] = await Promise.all([A.ask({ op: 'dump' }, (m) => m.ev === 'dump'), B.ask({ op: 'dump' }, (m) => m.ev === 'dump')]);
    T.eventsA = da?.events || []; T.eventsB = db?.events || [];
    T.bytes = (da?.bytes ? da.bytes.written + da.bytes.read : 0) + (db?.bytes ? db.bytes.written + db.bytes.read : 0);
    classify(T);
    return T;
  } catch (e) {
    T.cls = 'd'; T.evidence.push(`harness: ${e.message}`); return T;
  } finally {
    for (const n of [A, B]) { try { n.child.send({ op: 'stop' }); } catch {} }
    await delay(1000);
    for (const n of [A, B]) { try { n.child.kill('SIGKILL'); } catch {} }
  }
}

function classify(T) {
  const a = T.eventsA, b = T.eventsB;
  const t0 = T.t0;
  const rel = (e) => (e ? e.t - t0 : null);
  const routeEnds = b.filter((e) => e.type === 'route-query' && e.phase === 'end');
  T.tRoute = rel(routeEnds.find((e) => e.haveRoute));
  const bConn = b.find((e) => e.type === 'connected' && e.peer === T.a.slice(0, 8));
  const aConn = a.find((e) => e.type === 'connected' && e.peer === T.b.slice(0, 8));
  T.tInitConnected = rel(bConn); T.tRespConfirmed = rel(aConn);
  const helloSent = b.filter((e) => e.type === 'hello-sent');
  T.handshakes = helloSent.length;
  T.helloDropped = a.filter((e) => e.type === 'hello-dropped').length;
  T.staleAcksAtB = b.filter((e) => e.type === 'routed-in' && e.to === 'new').length;
  T.routeGoneAtB = b.filter((e) => e.type === 'route-change' && e.to === 'gone').length;
  T.noRouteAtB = b.filter((e) => e.type === 'no-route').length;
  // Half-open at the initiator: connected, then its key-confirm PING could not be routed.
  T.pingNoRoute = b.filter((e, i) => e.type === 'ping-sent' && b.slice(i + 1, i + 3).some((x) => x.type === 'no-route')).length;
  T.confirmTimeouts = a.filter((e) => e.type === 'destroy' && /confirmation timeout/.test(e.reason || '')).length;
  T.zombieInit = b.filter((e) => e.type === 'destroy' && e.state === 'connected' && /PONG timeout/.test(e.reason || '')).length;
  const sentOk = T.sends.filter((s) => s.ok), lost = sentOk.filter((s) => !s.arrived), refused = T.sends.filter((s) => !s.ok);
  if (!routeEnds.some((e) => e.haveRoute)) { T.cls = 'a'; T.evidence.push(`${routeEnds.length} route queries, none answered with a route`); }
  else if (!T.attempts.some((x) => x.result === 'connected')) {
    T.cls = 'b';
    T.evidence.push(`dial results: ${T.attempts.map((x) => x.result).join(' | ')}; ${T.helloDropped} HELLO dropped at alice by a link not in 'handshaking'`);
  } else if (!aConn || lost.length) {
    T.cls = 'c';
    T.evidence.push(`bob (initiator) connected at +${T.tInitConnected} ms; alice (responder) ${aConn ? `confirmed at +${T.tRespConfirmed} ms` : 'NEVER key-confirmed'}; ${lost.length} sent-but-lost, ${refused.length} refused (${refused.map((s) => s.error).join(',')})`);
  } else if (refused.length) { T.cls = 'd'; T.evidence.push(`sends refused: ${refused.map((s) => s.error).join(',')}`); }
  else T.cls = 'ok';
}

const results = [];
console.log(`L1: ${N} trials through ${HOST}:${PORT} (pinned NodeID ${pinned.nodeId.slice(0, 16)}…)`);
for (let k = 1; k <= N; k++) {
  const T = await trial(k);
  results.push(T);
  const arrived = T.sends.filter((s) => s.arrived).length;
  console.log(`  trial ${String(k).padStart(2)}: ${T.cls.padEnd(2)} boot ${T.tBoot ?? '-'} ms, route +${T.tRoute ?? '-'}, attempts ${T.attempts.map((x) => x.result === 'connected' ? 'OK' : x.result.replace('Virtual handshake ', 'hs-').replace('skipped (no route)', 'no-route')).join(',') || '-'}, ` +
    `hellos ${T.handshakes ?? '-'} (dropped at alice ${T.helloDropped ?? '-'}), route lost ${T.routeGoneAtB ?? '-'}×, no-route ${T.noRouteAtB ?? '-'}×, PING unroutable ${T.pingNoRoute ?? '-'}, zombie initiator ${T.zombieInit ?? '-'}, sent→arrived ${arrived}/${T.sends.length}, ${T.bytes ?? 0} B${T.evidence.length ? ` — ${T.evidence.join('; ')}` : ''}`);
}
const med = (xs) => { const v = xs.filter((x) => x != null).sort((p, q) => p - q); return v.length ? `${v[Math.floor(v.length / 2)]} / ${v[v.length - 1]}` : '- / -'; };
console.log('\nper stage (ms after the trial started, median / max over trials that reached it)');
console.log(`  bootstrap done (both on the Railway peer)   ${med(results.map((r) => r.tBoot))}`);
console.log(`  route known at bob                          ${med(results.map((r) => r.tRoute))}`);
console.log(`  bob: virtual link connected (initiator)     ${med(results.map((r) => r.tInitConnected))}`);
console.log(`  alice: key-confirm PING received            ${med(results.map((r) => r.tRespConfirmed))}`);
console.log(`  connect: first attempt → connected          ${med(results.map((r) => r.tConnect))}`);
console.log(`  message latency (send → receive)            ${med(results.flatMap((r) => r.sends.map((s) => s.ms)))}`);
const counts = results.reduce((o, r) => ({ ...o, [r.cls]: (o[r.cls] || 0) + 1 }), {});
console.log(`\nclasses: ${JSON.stringify(counts)}`);
const bytes = results.map((r) => r.bytes || 0);
console.log(`Railway link bytes: total ${bytes.reduce((p, q) => p + q, 0)} over ${N} trials (median ${med(bytes).split(' / ')[0]} per trial, both nodes, both directions)`);
if (logOut) fs.writeFileSync(logOut, JSON.stringify(results, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
