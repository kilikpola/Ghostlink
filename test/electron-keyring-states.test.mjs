/**
 * Keyring states in the REAL app (R1c), on a private D-Bus with a throwaway
 * gnome-keyring — never the user's keyring.
 *
 *   UNLOCKED (positive control): node auto-starts from the stored seed.
 *   LOCKED   (the keyring's collection locked over D-Bus): state "locked", the
 *            exact unlock message, restore refused as "locked" even with
 *            REPLACE, no node, seed blob and contact key byte-identical.
 *   STOPPED  (no Secret Service -> basic_text): state "insecure", the message
 *            names gnome-keyring / KWallet, restore refused, blobs untouched.
 *
 * Prints no phrase. Run: node test/electron-keyring-states.test.mjs [--packaged]
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
// The sealed values main.js keeps (electron-store, obfuscated with its fixed key). Never printed.
const sealedValues = (configHome) => {
  const c = new Conf({ cwd: path.join(configHome, 'ghostlink-desktop'), configName: 'ghostlink-config', encryptionKey: 'gl-desktop-cfg-v1', projectName: 'x' });
  return { seed: c.get('gmp_seed_phrase_enc') ?? null, contact: c.get('gl_contact_vault_key_enc') ?? null,
    keys: Object.keys(c.store).filter((k) => /^(gmp_seed|gl_contact_vault_key)/.test(k)) };
};
const secretCall = (env, ...args) => spawnSync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.secrets', ...args],
  { env: { ...process.env, ...env }, encoding: 'utf8' });

const tmp = shortTmp('gl-ks-');
const peersFile = path.join(tmp, 'public-peers.json'); fs.writeFileSync(peersFile, '[]');
const configHome = path.join(tmp, 'config');
const opts = (env) => ({ packaged, env: { ...env, XDG_CURRENT_DESKTOP: 'Hyprland' }, configHome, dataDir: path.join(tmp, 'gmp-data'), peersFile });

async function observe(app, phrase) {
  const cdp = await app.attach();
  const status = cdp && await waitFor(() => cdp.evaluate('window.ghostlink && window.ghostlink.secureStorage.status()'), 15000);
  await sleep(4000);
  const restore = cdp && await cdp.evaluate(`window.ghostlink.gmp.restore(${JSON.stringify(phrase)}, null, 'REPLACE')
    .then((x) => ({ status: x.status, error: x.error || null }), (e) => ({ status: 'threw', error: e.message }))`);
  const banner = cdp && await cdp.evaluate(`(() => { const b = document.getElementById('gl-secure-banner'); return b ? b.textContent : null; })()`);
  cdp && cdp.close();
  const nodeStarted = /Node Manager started on port \d+/.test(app.log());
  await app.stop();
  return { status, restore, banner, nodeStarted };
}

const bus = privateBus(tmp, { secretService: true });
let bus2 = null;
try {
  console.log('\n=== setup: first run with the throwaway keyring unlocked ===');
  ok(bus.ownsSecrets(), 'throwaway gnome-keyring owns org.freedesktop.secrets on the private bus');
  let app = launchApp(opts(bus.env));
  let cdp = await app.attach();
  const fr = await firstRun(cdp);
  const phrase = await cdp.evaluate('window.seedPhrase ? window.seedPhrase.join(" ") : null');
  cdp.close(); await app.stop();
  const before = sealedValues(configHome);
  ok(fr.reachedMain && !!phrase && !!before.seed && !!before.contact, 'identity created; sealed seed and contact key are stored');

  console.log('\n=== UNLOCKED (positive control) ===');
  const U = await observe(launchApp(opts(bus.env)), phrase);
  ok(U.status && U.status.state === 'ok' && U.status.available === true, `status "ok" (got ${JSON.stringify(U.status)})`);
  ok(U.restore && U.restore.status === 'started', `restore of the correct phrase -> started (got ${JSON.stringify(U.restore && U.restore.status)})`);

  console.log('\n=== LOCKED ===');
  secretCall(bus.env, '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service.Lock', 'array:objpath:/org/freedesktop/secrets/collection/login');
  const lockedProp = secretCall(bus.env, '/org/freedesktop/secrets/collection/login', 'org.freedesktop.DBus.Properties.Get',
    'string:org.freedesktop.Secret.Collection', 'string:Locked').stdout;
  ok(/boolean true/.test(lockedProp || ''), 'the throwaway keyring collection reports Locked=true');
  const L = await observe(launchApp(opts(bus.env)), phrase);
  ok(L.status && L.status.state === 'locked', `status "locked", not unreadable/insecure (got ${JSON.stringify(L.status && L.status.state)})`);
  ok(L.status && L.status.reason === 'Your system keyring is locked. Unlock it and restart GhostLink.', `exact unlock message (${JSON.stringify(L.status && L.status.reason)})`);
  ok(L.restore && L.restore.status === 'locked', `restore with REPLACE is refused as "locked" (got ${JSON.stringify(L.restore)})`);
  ok(typeof L.banner === 'string' && /keyring is locked/i.test(L.banner) && !/not found/i.test(L.banner), `banner says locked, not "not found" (${JSON.stringify(L.banner)})`);
  assertAbsent({
    channel: 'node auto-start log line',
    controlMessage: 'the UNLOCKED launch logged the node starting',
    control: () => (U.nodeStarted ? 1 : 0),
    absent: () => !L.nodeStarted,
    message: 'LOCKED: no node started',
  });
  const afterLocked = sealedValues(configHome);
  ok(afterLocked.seed === before.seed && afterLocked.contact === before.contact, 'LOCKED: seed blob and contact key byte-identical');
  ok(JSON.stringify(afterLocked.keys) === JSON.stringify(before.keys), `LOCKED: nothing moved aside (${JSON.stringify(afterLocked.keys)})`);

  console.log('\n=== STOPPED (no Secret Service -> basic_text) ===');
  bus.stop(); await sleep(500);
  bus2 = privateBus(path.join(tmp, 'b2'), { secretService: false });
  ok(!bus2.ownsSecrets(), 'no Secret Service on the bus');
  const I = await observe(launchApp(opts(bus2.env)), phrase);
  ok(I.status && I.status.state === 'insecure' && I.status.backend === 'basic_text', `status "insecure", backend basic_text (got ${JSON.stringify(I.status && I.status.state)})`);
  ok(I.status && /gnome-keyring/.test(I.status.reason) && /KWallet/.test(I.status.reason), 'message names gnome-keyring and KWallet');
  ok(I.restore && I.restore.status === 'insecure', `restore refused as "insecure" (got ${JSON.stringify(I.restore)})`);
  ok(typeof I.banner === 'string' && /gnome-keyring/.test(I.banner) && !/not found/i.test(I.banner), `banner names the fix (${JSON.stringify(I.banner)})`);
  ok(!I.nodeStarted, 'STOPPED: no node started');
  const afterStopped = sealedValues(configHome);
  ok(afterStopped.seed === before.seed && afterStopped.contact === before.contact, 'STOPPED: seed blob and contact key byte-identical');
} catch (e) {
  failed++; console.error('  ✗ harness error:', (e && e.stack) || e);
} finally {
  try { bus.stop(); } catch {}
  try { bus2 && bus2.stop(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
