/**
 * The real app has no Ghost Mesh TCP listener on 49600 (G0), and cannot be
 * made to open one: the test first tries what the removed toggle did
 * (window.ghostlink.ghostMesh.startServer) if any such API is still exposed.
 *
 * Positive control on the same probes: the GMP node's port 49500 accepts a
 * TCP connect and shows up in `ss -ltnp` for the app's process.
 *
 * Private D-Bus + throwaway gnome-keyring (never the user's keyring).
 * Run: node test/electron-no-ghostmesh.test.mjs [--packaged]
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawnSync } from 'child_process';
import { electronBinary, portsBusy, shortTmp, privateBus, launchApp, firstRun, waitFor } from './helpers/electron-app.mjs';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const packaged = process.argv.includes('--packaged');

const missing = ['dbus-daemon', 'dbus-send', 'gnome-keyring-daemon', 'ss'].filter((t) => spawnSync('which', [t]).status !== 0);
if (!electronBinary({ packaged }) || missing.length) {
  console.log(`  ~ skipped (${!electronBinary({ packaged }) ? 'Electron build not found' : 'missing ' + missing.join(', ')})`);
  process.exit(0);
}
if ((await portsBusy([3002, 49500, 49600])).length) { console.error('  ✗ ports 3002/49500/49600 in use — close GhostLink first'); process.exit(1); }

/** 'accepted' | 'refused' | other error code, for a TCP connect. */
const connect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('accepted'); });
  s.on('error', (e) => { clearTimeout(t); resolve(e.code === 'ECONNREFUSED' ? 'refused' : e.code); });
});
/** Listening sockets of one process, from ss -ltnp. */
const listeners = (pid) => spawnSync('ss', ['-ltnpH'], { encoding: 'utf8' }).stdout.split('\n')
  .filter((l) => l.includes(`pid=${pid},`)).map((l) => l.replace(/\s+/g, ' ').trim());

const tmp = shortTmp('gl-nm-');
const peersFile = path.join(tmp, 'public-peers.json'); fs.writeFileSync(peersFile, '[]');
const bus = privateBus(tmp, { secretService: true });
try {
  const app = launchApp({ packaged, env: { ...bus.env, XDG_CURRENT_DESKTOP: 'Hyprland' }, configHome: path.join(tmp, 'c'), dataDir: path.join(tmp, 'd'), peersFile });
  console.log(`\n=== ${app.describe} ===`);
  const cdp = await app.attach();
  const fr = cdp ? await firstRun(cdp) : {};
  ok(!!fr.reachedMain, 'first run completed (identity created, GMP node started)');
  ok(!!await waitFor(() => /Node Manager started on port 49500/.test(app.log()), 15000), 'main logged the GMP node on port 49500');

  // What the removed toggle did. If any API for it is still exposed, use it.
  const api = cdp && await cdp.evaluate(`(async () => {
    const g = window.ghostlink && window.ghostlink.ghostMesh;
    if (!g || typeof g.startServer !== 'function') return { exposed: false };
    try { return { exposed: true, result: await g.startServer('') }; } catch (e) { return { exposed: true, error: e.message }; }
  })()`);
  console.log(`    ghostMesh API: ${JSON.stringify(api)}`);
  ok(api && api.exposed === false, 'the renderer has no ghostMesh API to start a server with');
  const generic = cdp && await cdp.evaluate(`typeof (window.ghostlink && window.ghostlink.invoke)`);
  ok(generic === 'undefined', `no generic IPC invoke is exposed that could reach a removed channel (typeof invoke: ${generic})`);

  const pid = app.child.pid;
  const ls = listeners(pid);
  console.log(`    ss -ltnp (pid ${pid}):\n      ${ls.join('\n      ')}`);
  const c49500 = await connect('127.0.0.1', 49500);
  const v6 = await connect('::1', 49600);
  const v4 = await connect('127.0.0.1', 49600);
  assertAbsent({
    channel: 'TCP listener on 49600',
    controlMessage: `the same connect probe is accepted by the GMP port 49500 (${c49500})`,
    control: () => (c49500 === 'accepted' ? 1 : 0),
    absent: () => v6 === 'refused' && v4 === 'refused',
    message: `connect to 49600 is refused ([::1]: ${v6}, 127.0.0.1: ${v4})`,
  });
  assertAbsent({
    channel: 'ss -ltnp entry for :49600',
    controlMessage: 'the same ss listing shows the app listening on :49500',
    control: () => ls.filter((l) => /:49500\b/.test(l)).length,
    absent: () => !ls.some((l) => /:49600\b/.test(l)),
    message: 'the app has no listening socket on :49600',
  });
  ok(!/\[GhostMesh\]/.test(app.log()), 'main logged nothing from a GhostMesh server');
  cdp && cdp.close();
  await app.stop();
} catch (e) {
  failed++; console.error('  ✗ harness error:', (e && e.stack) || e);
} finally {
  bus.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
