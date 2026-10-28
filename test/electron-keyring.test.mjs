/**
 * Linux secure-storage backend selection (electron/src/keyring-backend.js).
 *
 * 1. Decision table (no Electron): which desktops are left to Chromium, an
 *    explicit --password-store is kept, a missing/broken D-Bus means "none".
 * 2. Real app, launched as `npm start` does, XDG_CURRENT_DESKTOP=Hyprland, on a
 *    private session bus (never the user's keyring):
 *    PRESENT — isolated gnome-keyring owns org.freedesktop.secrets:
 *      libsecret is selected, the renderer sees available:true, no banner, the
 *      seed is sealed, and after a restart the node auto-starts from it.
 *    ABSENT — no Secret Service, nothing activatable:
 *      basic_text, available:false, the amber banner shows, no seed is stored,
 *      and after a restart the node does NOT auto-start. The PRESENT case is
 *      the positive control for every ABSENT negative (same probe, same code).
 *
 * Run: node test/electron-keyring.test.mjs
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { repo, electronBinary, portsBusy, shortTmp, privateBus, launchApp, firstRun, waitFor, sleep } from './helpers/electron-app.mjs';

const require = createRequire(import.meta.url);
const { selectKeyringBackend, desktopHandledByChromium } = require('../electron/src/keyring-backend.js');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };

console.log('=== 1. decision table ===');
const fakeApp = () => { const sw = {}; return { sw, commandLine: { hasSwitch: (k) => k in sw, appendSwitch: (k, v) => { sw[k] = v; } } }; };
const busYes = (cmd, args) => (args.includes('org.freedesktop.DBus.NameHasOwner') ? 'boolean true' : '');
const busNo = () => 'boolean false';
const busBroken = () => { throw new Error('ENOENT'); };
const busEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' };
for (const [desktop, handled] of [['GNOME', true], ['ubuntu:GNOME', true], ['KDE', true], ['X-Cinnamon', true], ['XFCE', true],
  ['Hyprland', false], ['sway', false], ['i3', false], ['niri', false], ['', false]]) {
  ok(desktopHandledByChromium({ XDG_CURRENT_DESKTOP: desktop }) === handled, `${desktop || '(unset)'}: ${handled ? 'left to Chromium' : 'probed'}`);
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { ...busEnv, XDG_CURRENT_DESKTOP: 'Hyprland' }, argv: [], exec: busYes });
  ok(r.action === 'selected-libsecret' && a.sw['password-store'] === 'gnome-libsecret', 'Hyprland + Secret Service -> --password-store=gnome-libsecret');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { ...busEnv, XDG_CURRENT_DESKTOP: 'Hyprland' }, argv: [], exec: busNo });
  ok(r.action === 'none-found' && !('password-store' in a.sw), 'Hyprland, no Secret Service -> no switch (stays basic_text, fail-closed)');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { ...busEnv, XDG_CURRENT_DESKTOP: 'sway' }, argv: [], exec: busBroken });
  ok(r.action === 'none-found' && !('password-store' in a.sw), 'D-Bus tools missing/failing -> no switch');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'Hyprland' }, argv: [], exec: busYes });
  ok(r.action === 'none-found', 'no session bus in the environment -> no switch, no probe');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { ...busEnv, XDG_CURRENT_DESKTOP: 'KDE' }, argv: [], exec: busYes });
  ok(r.action === 'chromium-default' && !('password-store' in a.sw), 'KDE keeps Chromium\'s kwallet (existing sealed seeds keep opening)');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'linux', env: { ...busEnv, XDG_CURRENT_DESKTOP: 'Hyprland' }, argv: ['electron', '.', '--password-store=basic'], exec: busYes });
  ok(r.action === 'kept-explicit' && !('password-store' in a.sw), 'an explicit --password-store is never overridden');
}
{
  const a = fakeApp();
  const r = selectKeyringBackend({ app: a, platform: 'darwin', env: busEnv, argv: [], exec: busYes });
  ok(r.action === 'not-linux' && !('password-store' in a.sw), 'macOS/Windows untouched');
}

console.log('\n=== 2. real app on a private bus ===');
const missing = ['dbus-daemon', 'dbus-send', 'gnome-keyring-daemon'].filter((t) => spawnSync('which', [t]).status !== 0);
if (!electronBinary() || missing.length) {
  console.log(`  ~ skipped (${!electronBinary() ? 'Electron not installed' : 'missing ' + missing.join(', ')})`);
} else if ((await portsBusy()).length) {
  failed++; console.error('  ✗ ports 3002/49500/49600 in use — close GhostLink first');
} else {
  const configKey = (configHome) => {
    const f = path.join(configHome, 'ghostlink-desktop', 'ghostlink-config.json');
    return fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0);
  };
  const results = {};
  for (const present of [true, false]) {
    const label = present ? 'PRESENT' : 'ABSENT';
    console.log(`\n  --- ${label}: Secret Service ${present ? 'running' : 'absent'} ---`);
    const tmp = shortTmp('gl-kr-');
    const peersFile = path.join(tmp, 'public-peers.json');
    fs.writeFileSync(peersFile, '[]');
    const bus = privateBus(tmp, { secretService: present });
    ok(bus.ownsSecrets() === present, `${label}: org.freedesktop.secrets ${present ? 'is' : 'is not'} owned on the private bus`);
    const opts = { env: { ...bus.env, XDG_CURRENT_DESKTOP: 'Hyprland' }, configHome: path.join(tmp, 'config'), dataDir: path.join(tmp, 'gmp-data'), peersFile };
    const r = {};
    try {
      const app1 = launchApp(opts);
      const cdp = await app1.attach();
      r.decision = (app1.log().match(/secure storage: (\S+)/) || [])[1] || (await sleep(1000), (app1.log().match(/secure storage: (\S+)/) || [])[1]);
      r.status = cdp && await waitFor(() => cdp.evaluate(`window.ghostlink.secureStorage.status()`), 10000);
      const s = cdp ? await firstRun(cdp) : {};
      r.reachedMain = s.reachedMain;
      r.banner = cdp && await cdp.evaluate(`(() => { const b = document.getElementById('gl-secure-banner'); return b ? b.textContent : null; })()`);
      r.gmpStartReply = cdp && await cdp.evaluate(`window.ghostlink.secureStorage.status()`);
      cdp && cdp.close();
      await app1.stop();
      // electron-store obfuscates the file, so check for the seed key via the
      // app's own status on the restart instead of parsing the file.
      r.configWritten = configKey(opts.configHome).length > 0;

      const app2 = launchApp(opts);
      const cdp2 = await app2.attach();
      // The node auto-starts from a stored seed before any UI interaction.
      r.autoStarted = !!await waitFor(async () => /Node Manager started on port \d+/.test(app2.log()), present ? 20000 : 10000);
      r.status2 = cdp2 && await cdp2.evaluate(`window.ghostlink.secureStorage.status()`);
      cdp2 && cdp2.close();
      await app2.stop();
    } catch (e) {
      failed++; console.error('  ✗ harness error:', (e && e.stack) || e);
    }
    bus.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    results[label] = r;
    console.log(`    decision=${r.decision} status=${JSON.stringify(r.status)} restartStatus=${JSON.stringify(r.status2)}`);
  }

  const P = results.PRESENT, A = results.ABSENT;
  console.log('\n  --- assertions ---');
  ok(P.decision === 'selected-libsecret', `PRESENT: main selected libsecret (logged "${P.decision}")`);
  ok(P.status && P.status.available === true && P.status.backend === 'gnome_libsecret', `PRESENT: renderer sees available:true, backend gnome_libsecret`);
  ok(P.reachedMain, 'PRESENT: first run completed');
  ok(P.banner === null, 'PRESENT: no "identity not saved" banner');
  ok(P.status2 && P.status2.hasStoredSeed === true, 'PRESENT: after restart a sealed seed is on disk');
  ok(P.autoStarted, 'PRESENT: after restart the node auto-started from the stored seed (no re-entry)');

  ok(A.decision === 'none-found', `ABSENT: main found no Secret Service (logged "${A.decision}")`);
  ok(A.status && A.status.available === false && A.status.backend === 'basic_text', 'ABSENT: renderer sees available:false, backend basic_text (fail-closed)');
  ok(A.reachedMain, 'ABSENT: first run still completes (session-only identity)');
  ok(typeof A.banner === 'string' && /keyring/i.test(A.banner), `ABSENT: amber banner shown (${A.banner && A.banner.slice(0, 60)}…)`);
  // Negatives, each with PRESENT as the positive control on the same probe.
  ok(P.status2?.hasStoredSeed === true && A.status2 && A.status2.hasStoredSeed === false, 'ABSENT: no seed on disk after restart (control: PRESENT has one)');
  ok(P.autoStarted === true && A.autoStarted === false, 'ABSENT: node did not auto-start after restart (control: PRESENT did)');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
