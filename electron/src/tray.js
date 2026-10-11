/**
 * GhostLink Desktop — System Tray Module
 *
 * Manages the system tray icon, context menu, badge count,
 * and flash-on-message behavior.
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');

let trayInstance = null;
let flashInterval = null;
let originalIcon = null;
let emptyIcon = null;

/* ═══════════════════════════════════════════════════════════════
   ICON GENERATION
   ═══════════════════════════════════════════════════════════════ */

function loadTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }
  // Fallback: generate 16x16 teal icon
  return generateTrayIcon(false);
}

function generateTrayIcon(empty) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (empty) {
        buf[i] = buf[i + 1] = buf[i + 2] = 0;
        buf[i + 3] = 0; // transparent
      } else {
        // Rounded square with teal gradient
        const cx = size / 2, cy = size / 2, r = 6;
        const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
        const inside = dx <= r && dy <= r && (dx + dy <= r + 2);
        if (inside) {
          const t = (x + y) / (size * 2);
          buf[i] = 0;                              // R
          buf[i + 1] = Math.round(200 + t * 55);   // G
          buf[i + 2] = Math.round(160 + t * 40);   // B
          buf[i + 3] = 255;                         // A
        } else {
          buf[i + 3] = 0; // transparent
        }
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/* ═══════════════════════════════════════════════════════════════
   TRAY CREATION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Create the system tray icon and context menu.
 *
 * @param {Function} getMainWindow - returns the current main window or null
 *   (a getter, since macOS can re-create the window while the tray lives on)
 * @param {Store}    store         - electron-store config instance
 * @param {Function} onQuit        - callback to quit the app
 * @returns {Tray}
 */
function createTray(getMainWindow, store, onQuit) {
  originalIcon = loadTrayIcon();
  emptyIcon = generateTrayIcon(true);

  trayInstance = new Tray(originalIcon);
  trayInstance.setToolTip('GhostLink — Encrypted Messaging');

  /* ─── Context Menu ──────────────────────────────────────────── */
  function buildContextMenu() {
    const isMuted = store.get('mutedNotifications', false);
    const minimizeToTray = store.get('minimizeToTray', true);

    return Menu.buildFromTemplate([
      {
        label: 'Open GhostLink',
        click: () => {
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: isMuted ? 'Unmute Notifications' : 'Mute Notifications',
        click: () => {
          store.set('mutedNotifications', !isMuted);
          trayInstance.setContextMenu(buildContextMenu());
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send('tray-action', {
              action: 'mute-toggle',
              muted: !isMuted,
            });
          }
        },
      },
      {
        label: minimizeToTray ? 'Disable Minimize to Tray' : 'Enable Minimize to Tray',
        click: () => {
          store.set('minimizeToTray', !minimizeToTray);
          trayInstance.setContextMenu(buildContextMenu());
        },
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('tray-action', { action: 'open-settings' });
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit GhostLink',
        click: () => {
          if (onQuit) onQuit();
        },
      },
    ]);
  }

  trayInstance.setContextMenu(buildContextMenu());

  /* ─── Single click: toggle window visibility ────────────────── */
  trayInstance.on('click', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  /* ─── Double-click: always show + focus ─────────────────────── */
  trayInstance.on('double-click', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return trayInstance;
}

/* ═══════════════════════════════════════════════════════════════
   BADGE COUNT
   ═══════════════════════════════════════════════════════════════ */

/**
 * Update the tray tooltip to reflect unread count.
 */
function updateBadge(tray, count) {
  if (!tray || tray.isDestroyed()) return;

  if (count > 0) {
    tray.setToolTip(`GhostLink — ${count} unread message${count > 1 ? 's' : ''}`);
  } else {
    tray.setToolTip('GhostLink — Encrypted Messaging');
    stopFlash(tray);
  }
}

/* ═══════════════════════════════════════════════════════════════
   FLASH TRAY ICON (new message attention)
   ═══════════════════════════════════════════════════════════════ */

/**
 * Flash the tray icon to attract attention on new message.
 * Alternates between the real icon and a blank icon.
 */
function flashTray(tray) {
  if (!tray || tray.isDestroyed()) return;
  if (flashInterval) return; // already flashing

  let visible = true;
  flashInterval = setInterval(() => {
    if (!tray || tray.isDestroyed()) {
      stopFlash(tray);
      return;
    }
    visible = !visible;
    tray.setImage(visible ? originalIcon : emptyIcon);
  }, 500);

  // Stop flashing after 5 seconds
  setTimeout(() => stopFlash(tray), 5000);
}

function stopFlash(tray) {
  if (flashInterval) {
    clearInterval(flashInterval);
    flashInterval = null;
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(originalIcon);
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLEANUP
   ═══════════════════════════════════════════════════════════════ */

function destroyTray(tray) {
  stopFlash(tray);
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  trayInstance = null;
}

/* ─── Exports ───────────────────────────────────────────────── */

module.exports = {
  createTray,
  updateBadge,
  flashTray,
  destroyTray,
};
