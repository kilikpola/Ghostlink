/**
 * Ratchet store in the REAL app (R7), on a private D-Bus with a throwaway
 * gnome-keyring — never the user's keyring.
 *
 *   UNLOCKED first run: the chat node starts with a SEALED ratchet store
 *     anchored in safeStorage: <userData>/ratchets/store.id and the sealed
 *     anchor (gl_ratchet_anchor_enc) appear.
 *   LOCKED first run (collection locked before launch): the node still starts
 *     session-only (R1c) and its ratchets are MEMORY-ONLY: bridge ratchet-status
 *     says so with the neutral reason, the store logged ratchet-memory-only, and
 *     nothing ratchet-related is written (no directory, no anchor).
 *
 * Prints no phrase. Run: node test/electron-ratchet-store.test.mjs [--packaged]
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { repo, electronBinary, portsBusy, shortTmp, privateBus, launchApp, firstRun, waitFor, sleep } from './helpers/electron-app.mjs';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);
const packaged = process.argv.includes('--packaged');

const missing = ['dbus-daemon', 'dbus-send', 'gnome-keyring-daemon'].filter((t) => spawnSync('which', [t]).status !== 0);
if (!electronBinary({ packaged }) || missing.length) {
  console.log(`  ~ skipped (${!electronBinary({ packaged }) ? 'Electron build not found' : 'missing ' + missing.join(', ')})`);
  process.exit(0);
}
if ((await portsBusy()).length) { console.error('  ✗ ports 3002/49500/49600 in use — close GhostLink first'); process.exit(1); }

const { default: Conf } = await import(path.join(repo, 'node_modules', 'conf', 'dist', 'source', 'index.js'));
const stored = (configHome) => new Conf({ cwd: path.join(configHome, 'ghostlink-desktop'), configName: 'ghostlink-config', encryptionKey: 'gl-desktop-cfg-v1', projectName: 'x' });
const secretCall = (env, ...args) => spawnSync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.secrets', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

/** From the page: ask the host node's bridge how ratchet sessions are kept. */
const RATCHET_STATUS = `window.ghostlink.bridgeToken().then((t) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:3002', [t]);
  const timer = setTimeout(() => resolve({ error: 'timeout' }), 8000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'ratchet-status', requestId: 'r7' }));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'ratchet-status' || (m.type === 'error' && m.requestId === 'r7')) { clearTimeout(timer); ws.close(); resolve(m); } };
  ws.onerror = () => { clearTimeout(timer); resolve({ error: 'socket' }); };
}))`;

async function run(label, { lockFirst }) {
  const tmp = shortTmp(`gl-r7-${label}-`);
  const peersFile = path.join(tmp, 'public-peers.json'); fs.writeFileSync(peersFile, '[]');
  const configHome = path.join(tmp, 'config');
  const bus = privateBus(tmp, { secretService: true });
  try {
    ok(bus.ownsSecrets(), `${label}: throwaway gnome-keyring owns org.freedesktop.secrets on the private bus`);
    if (lockFirst) {
      secretCall(bus.env, '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.Lock', 'array:objpath:/org/freedesktop/secrets/collection/login');
      const prop = secretCall(bus.env, '/org/freedesktop/secrets/collection/login', 'org.freedesktop.DBus.Properties.Get', 'string:org.freedesktop.Secret.Collection', 'string:Locked').stdout;
      ok(/boolean true/.test(prop || ''), `${label}: the collection reports Locked=true before the first run`);
    }
    const app = launchApp({ packaged, env: { ...bus.env, XDG_CURRENT_DESKTOP: 'Hyprland' }, configHome, dataDir: path.join(tmp, 'gmp-data'), peersFile });
    const cdp = await app.attach();
    const fr = cdp ? await firstRun(cdp) : {};
    const status = cdp && await waitFor(() => cdp.evaluate(RATCHET_STATUS).then((s) => (s && s.mode ? s : null)), 20000);
    cdp && cdp.close();
    await sleep(500);
    const log = app.log();
    await app.stop();
    const userData = path.join(configHome, 'ghostlink-desktop');
    const ratchetDir = path.join(userData, 'ratchets');
    const anchor = stored(configHome).get('gl_ratchet_anchor_enc');
    return { fr, status, log, ratchetDir, anchor, storeId: fs.existsSync(path.join(ratchetDir, 'store.id')), dirExists: fs.existsSync(ratchetDir), nodeStarted: /Node Manager started on port \d+/.test(log) };
  } finally {
    try { bus.stop(); } catch {}
    setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 0);
  }
}

let U = null, L = null;
try {
  console.log('\n=== UNLOCKED first run: sealed ratchet store ===');
  U = await run('unlocked', { lockFirst: false });
  ok(U.fr.reachedMain && U.nodeStarted, 'the node started');
  ok(U.status && U.status.mode === 'sealed', `bridge ratchet-status: ${JSON.stringify(U.status && U.status.mode)}`);
  ok(/secure sessions: sealed store \(keyring ok\)/.test(U.log), 'main.js chose the sealed store (keyring ok)');
  ok(U.storeId && typeof U.anchor === 'string' && U.anchor.length > 20,
    `<userData>/ratchets/store.id and the sealed anchor (gl_ratchet_anchor_enc, ${U.anchor ? U.anchor.length : 0} chars) appear`);

  console.log('\n=== LOCKED first run: memory-only ratchets, nothing written ===');
  L = await run('locked', { lockFirst: true });
  ok(L.fr.reachedMain && L.nodeStarted, 'the node still starts session-only (R1c), from the phrase in memory');
  ok(L.status && L.status.mode === 'memory-only' && /keyring is locked/.test(L.status.memoryOnlyReason || '') && !/secure|protect|safe/i.test((L.status.memoryOnlyReason || '').replace('secure-session', '')),
    `bridge ratchet-status: memory-only, neutral reason (${JSON.stringify(L.status && L.status.memoryOnlyReason)})`);
  ok(/secure sessions: memory-only \(keyring locked\)/.test(L.log) && /"event":"ratchet-memory-only"/.test(L.log), 'main.js chose memory-only; the store logged ratchet-memory-only (the event the renderer can show)');
  assertAbsent({
    channel: 'ratchet state written with a locked keyring (store directory or sealed anchor)',
    controlMessage: 'the unlocked run wrote both',
    control: () => U.storeId && !!U.anchor,
    absent: () => !L.dirExists && L.anchor === undefined,
    message: 'LOCKED: no ratchets directory and no anchor',
  });
} catch (e) {
  failed++; console.error('  ✗ harness error:', (e && e.stack) || e);
}
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
