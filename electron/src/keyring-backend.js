'use strict';
/**
 * Pick the Linux safeStorage backend on desktops Chromium does not recognise.
 *
 * Chromium chooses the password store from XDG_CURRENT_DESKTOP: GNOME-family
 * desktops get libsecret, KDE gets kwallet, and everything else (Hyprland,
 * Sway, i3, river, niri, ...) gets 'basic_text' — a hardcoded key — even when a
 * Secret Service (gnome-keyring, KeePassXC, KWallet's ksecretd) is running.
 * seed-store.js then correctly refuses to persist, so the identity is never
 * saved on those desktops.
 *
 * On such a desktop, if org.freedesktop.secrets is owned (or D-Bus-activatable)
 * on the session bus, select it with --password-store=gnome-libsecret. This
 * must run before app 'ready'. It only ever ADDS a real backend; when no
 * Secret Service is found nothing changes and seed-store.js stays fail-closed
 * on basic_text. Desktops Chromium already handles are left alone, so an
 * existing KWallet- or libsecret-sealed seed keeps opening.
 */
const { execFileSync } = require('child_process');

const SECRET_SERVICE = 'org.freedesktop.secrets';

// XDG_CURRENT_DESKTOP tokens for which Chromium already picks a real store
// (components/os_crypt key_storage_util_linux + base/nix/xdg_util).
const HANDLED_DESKTOPS = ['gnome', 'unity', 'pantheon', 'xfce', 'x-cinnamon', 'cinnamon', 'deepin', 'ukui', 'kde'];

function desktopHandledByChromium(env) {
  const tokens = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase().split(':').map((s) => s.trim()).filter(Boolean);
  return tokens.some((t) => HANDLED_DESKTOPS.includes(t));
}

/**
 * Is a Secret Service reachable on the session bus? Asks the bus daemon
 * (NameHasOwner, then ListActivatableNames) via dbus-send, falling back to
 * busctl. Every probe is bounded; any failure means "not found".
 */
function secretServiceOnBus({ exec = execFileSync, env = process.env } = {}) {
  if (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR) return false;
  const opts = { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], env };
  const probes = [
    () => /boolean true/.test(exec('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${SECRET_SERVICE}`], opts)),
    () => exec('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListActivatableNames'], opts).includes(`"${SECRET_SERVICE}"`),
    () => /^b true/.test(exec('busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus', 'NameHasOwner', 's', SECRET_SERVICE], opts).trim()),
  ];
  for (const probe of probes) {
    try { if (probe()) return true; } catch (_e) { /* tool missing or bus error: try the next */ }
  }
  return false;
}

/**
 * Decide and apply. Returns what was decided so main.js can log it.
 * @returns {{action:'kept-explicit'|'chromium-default'|'selected-libsecret'|'none-found'|'not-linux', desktop:string}}
 */
function selectKeyringBackend({ app, platform = process.platform, env = process.env, argv = process.argv, exec } = {}) {
  const desktop = env.XDG_CURRENT_DESKTOP || '';
  if (platform !== 'linux') return { action: 'not-linux', desktop };
  if (argv.some((a) => a.startsWith('--password-store')) || app.commandLine.hasSwitch('password-store')) {
    return { action: 'kept-explicit', desktop };
  }
  if (desktopHandledByChromium(env)) return { action: 'chromium-default', desktop };
  if (!secretServiceOnBus({ exec, env })) return { action: 'none-found', desktop };
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  return { action: 'selected-libsecret', desktop };
}

module.exports = { selectKeyringBackend, secretServiceOnBus, desktopHandledByChromium, SECRET_SERVICE };
