/**
 * Launch the desktop app the way `cd electron && npm start` does (or the
 * packaged linux-unpacked binary) and drive it over the DevTools protocol.
 *
 * Isolation is environment-only — argv stays `electron .` plus a DevTools port
 * (and --ozone-platform=headless when there is no display):
 *   XDG_CONFIG_HOME        Electron userData (config + sealed seed)
 *   GMP_DATA_DIR           node state (dev would otherwise use gmp-core/data)
 *   GMP_PUBLIC_PEERS_PATH  an empty list: no Railway contact
 *   DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR  a private session bus with no
 *     activatable services, optionally running an isolated gnome-keyring, so
 *     no test ever touches the user's real keyring.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.join(here, '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const WebSocket = require('ws');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const unpackedDir = path.join(repo, 'electron', 'dist', 'linux-unpacked');
export function electronBinary({ packaged = false } = {}) {
  if (packaged) {
    const bin = path.join(unpackedDir, 'ghostlink-desktop');
    return fs.existsSync(bin) ? bin : null;
  }
  try {
    const bin = createRequire(path.join(repo, 'electron', 'package.json'))('electron');
    return fs.existsSync(bin) ? bin : null;
  } catch { return null; }
}

export async function portsBusy(ports = [3002, 49500, 49600]) {
  const busy = [];
  for (const port of ports) {
    const open = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (open) busy.push(port);
  }
  return busy;
}

/** A short temp dir (unix socket paths are limited to ~108 bytes). */
export function shortTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const killTree = (pid) => { try { process.kill(pid, 'SIGTERM'); } catch {} };

/**
 * A private D-Bus session bus with NO service directories (nothing is
 * activatable), optionally with an unlocked gnome-keyring Secret Service whose
 * keyring lives under `dir`. Returns the env to pass and stop().
 */
export function privateBus(dir, { secretService = false } = {}) {
  const run = path.join(dir, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const conf = path.join(dir, 'bus.conf');
  fs.writeFileSync(conf, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${run}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`);
  const r = spawnSync('dbus-daemon', [`--config-file=${conf}`, '--print-address=1', '--print-pid=1', '--fork'], { encoding: 'utf8' });
  const [address, pid] = (r.stdout || '').trim().split('\n');
  if (!address || !address.startsWith('unix:')) throw new Error(`private dbus-daemon did not start: ${r.stderr || r.error}`);
  const env = { DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: run };
  const pids = [Number(pid)];
  // A tray host, as every real panel provides; see sni-watcher.py.
  const sni = spawnSync('sh', ['-c', `/usr/bin/python3 "${path.join(here, 'sni-watcher.py')}" "$1" > "$2" 2>&1 & echo $!`, 'sh', address, path.join(dir, 'sni.log')], { encoding: 'utf8' });
  pids.push(Number(sni.stdout.trim()));
  for (let i = 0; i < 50 && !(fs.existsSync(path.join(dir, 'sni.log')) && fs.readFileSync(path.join(dir, 'sni.log'), 'utf8').includes('READY')); i++) spawnSync('sleep', ['0.1']);
  if (!fs.readFileSync(path.join(dir, 'sni.log'), 'utf8').includes('READY')) throw new Error(`StatusNotifierWatcher stub did not start: ${fs.readFileSync(path.join(dir, 'sni.log'), 'utf8')}`);
  if (secretService) {
    const kenv = { PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: path.join(dir, 'data'), ...env };
    fs.mkdirSync(kenv.XDG_DATA_HOME, { recursive: true, mode: 0o700 });
    const u = spawnSync('gnome-keyring-daemon', ['--unlock', '--components=secrets'], { input: 'test-keyring-pw', env: kenv, encoding: 'utf8' });
    spawnSync('gnome-keyring-daemon', ['--start', '--components=secrets'], { env: kenv, encoding: 'utf8' });
    const m = (u.stdout || '').match(/GNOME_KEYRING_PID=(\d+)/);
    if (m) pids.push(Number(m[1]));
  }
  const ownsSecrets = () => /boolean true/.test(spawnSync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'],
  { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout || '');
  const stop = () => {
    // Any gnome-keyring started on this bus carries our runtime dir in its env.
    for (const p of spawnSync('pgrep', ['gnome-keyring-d'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number)) {
      try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').includes(run)) pids.push(p); } catch {}
    }
    for (const p of pids) killTree(p);
  };
  return { env, ownsSecrets, stop };
}

/**
 * Spawn the app. `env` is merged over a copy of process.env with the user's
 * own bus/runtime removed (callers pass a privateBus env).
 */
export function launchApp({ packaged = false, env: extraEnv = {}, configHome, dataDir, peersFile }) {
  const bin = electronBinary({ packaged });
  const devtoolsPort = 9300 + Math.floor(Math.random() * 600);
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY']) delete env[k];
  Object.assign(env, {
    XDG_CONFIG_HOME: configHome,
    GMP_DATA_DIR: dataDir,
    GMP_PUBLIC_PEERS_PATH: peersFile,
    ELECTRON_ENABLE_LOGGING: '1',
  }, extraEnv);
  // Always headless: a test must not put windows on the user's desktop, and CI
  // has no display. Chromium's headless Ozone backend runs the same renderer.
  const extra = [`--remote-debugging-port=${devtoolsPort}`, '--ozone-platform=headless'];
  const [args, cwd] = packaged ? [extra, unpackedDir] : [['.', ...extra], path.join(repo, 'electron')];
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', r));
  const app = {
    describe: `${path.relative(repo, bin)} ${args.join(' ')} (cwd ${path.relative(repo, cwd)})`,
    log: () => log,
    count: (re) => (log.match(new RegExp(re.source, 'g')) || []).length,
    child,
    async stop() {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([exited, sleep(5000)]);
      try { child.kill('SIGKILL'); } catch {}
      await Promise.race([exited, sleep(2000)]);
    },
    async attach(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
          const page = (await res.json()).find((t) => t.type === 'page' && t.url.startsWith('file:'));
          if (page) {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
            let id = 0; const pending = new Map();
            ws.on('message', (m) => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
            const evaluate = (expression) => new Promise((r) => {
              const n = ++id; pending.set(n, (j) => r(j.result?.result?.value));
              ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
            });
            return { url: page.url, evaluate, close: () => ws.close() };
          }
        } catch { /* not up yet */ }
        await sleep(300);
      }
      return null;
    },
  };
  return app;
}

export async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } return null; }
const clickButton = (cdp, re) => cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.textContent.trim()) && !x.disabled);
  if (!b) return false; b.click(); return true; })()`);
const buttons = (cdp) => cdp.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12)`);

/**
 * Walk the first-run flow through the real DOM: splash -> onboarding -> alias
 * -> seed -> "Activate" (setupIdentity: gmp.start IPC, then the setup socket).
 * Returns per-step results; reachedMain means the node answered 'started'
 * over the setup socket and the app left the setup screen.
 */
export async function firstRun(cdp) {
  const steps = {};
  steps.onboarding = !!await waitFor(() => clickButton(cdp, /^(Next|Continue|Get Started|Begin)/i), 15000);
  for (let i = 0; i < 4; i++) {
    if (await cdp.evaluate(`!!document.querySelector('input[placeholder="Enter your alias..."]')`)) break;
    await clickButton(cdp, /^(Next|Continue|Get Started|Begin|Create)/i);
    await sleep(400);
  }
  steps.alias = !!await waitFor(() => cdp.evaluate(`(() => {
    const i = document.querySelector('input[placeholder="Enter your alias..."]'); if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, 'realLaunchTest'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), 10000);
  steps.aliasButtons = await buttons(cdp);
  await sleep(300);
  steps.aliasSubmitted = !!await waitFor(() => clickButton(cdp, /^(Continue|Next|Create|Generate)/i), 5000);
  steps.seed = !!await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => /Written It Down/i.test(b.textContent))`), 10000);
  steps.seedButtons = await buttons(cdp);
  await clickButton(cdp, /Written It Down/i);
  // gl_gmp_mode is set only when the node answers 'started' over the setup
  // socket — i.e. the bridge accepted it — and the app then switches to main.
  steps.reachedMain = !!await waitFor(() => cdp.evaluate(`localStorage.getItem('gl_gmp_mode') === 'active' && !/Starting Ghost Mesh|bridge not found/i.test(document.body.innerText)`), 30000);
  // The main view's connector then opens its own long-lived bridge socket.
  steps.connectorOpen = steps.reachedMain && !!await waitFor(() => cdp.evaluate(`(() => { const s = window.GhostLinkDebug && window.GhostLinkDebug._sigMgr; return !!(s && s.isConnected()); })()`), 20000);
  return steps;
}

export function untokenedProbe() {
  return new Promise((r) => {
    const ws = new WebSocket('ws://127.0.0.1:3002', { headers: { Origin: 'file://' } });
    ws.on('open', () => { ws.close(); r('open'); });
    ws.on('unexpected-response', (_q, res) => r(res.statusCode));
    ws.on('error', () => r('error'));
  });
}
