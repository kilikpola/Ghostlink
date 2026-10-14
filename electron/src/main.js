/**
 * GhostLink Desktop — Main Process
 * Zero Trust · Zero Trace · Zero Servers
 *
 * Electron main process handling window management, tray, IPC,
 * native integrations, security policies, and auto-updates.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  globalShortcut,
  Notification,
  nativeImage,
  safeStorage,
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const net = require('net');
const { createTray, updateBadge, flashTray, destroyTray } = require('./tray');
const { initUpdater, updateReady, quitAndInstall } = require('./updater');
const { getContactVaultKey, secureStorageStatus } = require('./contact-key');
const { createSeedStore } = require('./seed-store');
let gmpManager = null;
let gmpBridge = null;
let gmpStarting = null;

/**
 * Start the node and its loopback bridge once. Concurrent callers share one
 * attempt; a failure is cleaned up so the next call can retry.
 */
function startGMPNode(seedPhrase) {
  if (!gmpStarting) {
    gmpStarting = (async () => {
      // Redirect mutable node state to the per-user data dir (gmp-core's own is
      // read-only when installed), via entry-points.js, which imports nothing
      // else from gmp-core so it runs before paths.ts reads GMP_DATA_DIR.
      // Windows needs a file:// URL for dynamic import().
      const coreModule = (name) => import(pathToFileURL(path.join(GMP_CORE_DIR, 'dist', name)).href);
      const { electronDataDir, electronManagerOptions } = await coreModule('entry-points.js');
      const dataDir = electronDataDir({ isPackaged: app.isPackaged, userDataPath: app.getPath('userData'), env: process.env });
      if (dataDir) {
        process.env.GMP_DATA_DIR = dataDir;
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const { GMPNodeManager } = await coreModule('gmp-node-manager.js');
      const { startBridge } = await coreModule('gmp-bridge.js');

      gmpManager = new GMPNodeManager(electronManagerOptions({ seedPhrase }));
      gmpBridge = await startBridge(gmpManager, 3002);
      const { port } = await gmpManager.start();
      console.log(`[Electron GMP] Node Manager started on port ${port}, Bridge on 3002`);
    })().catch((err) => {
      stopGMPNode();
      throw err;
    });
  }
  return gmpStarting;
}

function stopGMPNode() {
  if (gmpBridge) {
    // close() releases the bridge's TCP listener and stops any nodes the
    // bridge started for other seed phrases.
    const bridge = gmpBridge;
    Promise.resolve(bridge.close ? bridge.close() : bridge.wss && bridge.wss.close()).catch(() => {});
  }
  if (gmpManager) {
    // stop() is async: a try/catch alone never sees its rejection.
    gmpManager.stop().catch(() => {});
  }
  gmpManager = null;
  gmpBridge = null;
  gmpStarting = null;
}

/* ─── Constants ─────────────────────────────────────────────── */

const IS_DEV = process.argv.includes('--dev');
const PROTOCOL = 'ghostlink';

/**
 * Locate a repo-root resource: from the checkout in development, otherwise
 * from process.resourcesPath (resources/webapp/, resources/gmp-core/).
 */
function resolveResource(checkoutRelative, packagedRelative) {
  const checkoutPath = path.join(__dirname, '..', '..', checkoutRelative);
  if (fs.existsSync(checkoutPath)) return checkoutPath;
  return path.join(process.resourcesPath, packagedRelative);
}

const INDEX_PATH = resolveResource('index.html', path.join('webapp', 'index.html'));
const GMP_CORE_DIR = resolveResource('gmp-core', 'gmp-core');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

/* ─── Persistent config store ───────────────────────────────── */

const store = new Store({
  name: 'ghostlink-config',
  defaults: {
    windowBounds: { width: 1200, height: 800, x: undefined, y: undefined },
    minimizeToTray: true,
    autoLaunch: false,
    mutedNotifications: false,
  },
  // Obfuscation only (constant key); this store holds only non-secret prefs.
  encryptionKey: 'gl-desktop-cfg-v1', // light obfuscation for prefs
});

/* ─── Recovery seed at rest ─────────────────────────────────── */

/**
 * The GMP seed phrase (master identity) at rest. FAIL CLOSED via
 * secureBackendOk (NOT the raw safeStorage.isEncryptionAvailable(), which can
 * be true for Linux 'basic_text' — a hardcoded key that protects nothing). On
 * an untrustworthy backend the seed is not persisted; the renderer shows an
 * amber banner and the identity is re-entered each launch. See seed-store.js.
 */
const seedStore = createSeedStore({ safeStorage, store });
const setStoredSeed = (seed) => seedStore.setSeed(seed);
const getStoredSeed = () => seedStore.getSeed();

/* ─── Ghost Mesh TCP bridge state ───────────────────────────── */
// Must differ from the GMP node's port (default 49500): both bind [::] in this
// process. The renderer dials without a port and gets this.
const GHOSTMESH_PORT = 49600;
let ghostMeshServer = null;
const activeMeshSockets = new Map(); // connId -> net.Socket

/* ─── Window tracking ───────────────────────────────────────── */

let mainWindow = null;
let tray = null;
let isQuitting = false;

/* ═══════════════════════════════════════════════════════════════
   SINGLE INSTANCE LOCK
   ═══════════════════════════════════════════════════════════════ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Handle deep link from second instance on Windows/Linux
    const deepLink = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink && mainWindow) {
      mainWindow.webContents.send('deep-link', deepLink);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   DEEP LINK PROTOCOL
   ═══════════════════════════════════════════════════════════════ */

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// macOS deep link
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/* ═══════════════════════════════════════════════════════════════
   WINDOW CREATION
   ═══════════════════════════════════════════════════════════════ */

function createMainWindow() {
  const saved = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 800,
    minHeight: 600,
    frame: false,              // frameless — custom title bar
    titleBarStyle: 'hidden',   // macOS: keep traffic-light buttons
    trafficLightPosition: { x: -100, y: -100 }, // hide native buttons; we draw our own
    backgroundColor: '#0a0a0f',
    show: false,               // show when ready to avoid flash
    icon: getAppIcon(),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      enableWebSQL: false,
    },
  });

  // Inject strict Content-Security-Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          // Local file:// bundle with vendored dependencies: no remote script
          // origins and no 'unsafe-eval'.
          'Content-Security-Policy': [
            "default-src 'self' blob: data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "media-src 'self' blob: data:; " +
            // Loopback only: GMP bridge (ws 3002), signaling (ws 3001) and the
            // relay-queue fetch on that origin. WebRTC is not governed by connect-src.
            "connect-src 'self' " +
            "http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:* " +
            "ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*; " +
            "font-src 'self' data:; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-src 'none'; " +
            "form-action 'none';",
          ],
        },
      });
    }
  );

  mainWindow.loadFile(INDEX_PATH);

  // Inject custom titlebar + Electron bridge CSS after DOM ready
  mainWindow.webContents.on('did-finish-load', () => {
    injectTitleBar(mainWindow);
    injectElectronStyles(mainWindow);
  });

  // Graceful show
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Persist window bounds
  const saveBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray on close (if enabled)
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/* ═══════════════════════════════════════════════════════════════
   TITLE BAR INJECTION
   ═══════════════════════════════════════════════════════════════ */

function injectTitleBar(win) {
  const titleBarJS = fs.readFileSync(
    path.join(__dirname, 'titlebar.js'),
    'utf-8'
  );
  win.webContents
    .executeJavaScript(titleBarJS.replace("'__WINDOW_TITLE__'", JSON.stringify('GhostLink')))
    .catch((err) => console.error('[GhostLink] Title bar injection failed:', err.message));
}

function injectElectronStyles(win) {
  win.webContents.insertCSS(`
    /* Push page content below custom title bar */
    body { padding-top: 38px !important; }
    html { overflow: hidden; }
    /* Smooth scrolling for main content */
    #root { height: calc(100vh - 38px); overflow-y: auto; }
  `);
}

/* ═══════════════════════════════════════════════════════════════
   EXTERNAL LINK SAFETY
   ═══════════════════════════════════════════════════════════════ */

/**
 * Hand a URL to the OS only if it is http/https or mailto:, so message links
 * cannot reach other locally registered protocol handlers.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function openExternalIfSafe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return false;
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn('[GhostLink] Blocked external open for scheme:', parsed.protocol);
    return false;
  }
  shell.openExternal(parsed.toString());
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   GHOST MESH SOCKETS
   ═══════════════════════════════════════════════════════════════ */

// Cap on one newline-delimited frame, so a peer cannot grow the heap without
// bound by never sending a newline.
const MAX_MESH_LINE_CHARS = 1024 * 1024;

function wireMeshSocket(socket, connId, label) {
  // setEncoding keeps a multi-byte character that straddles two TCP chunks
  // intact; decoding each chunk on its own turned it into U+FFFD.
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data;
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) {
        mainWindow?.webContents.send('ghostmesh-data', { connId, data: line });
      }
      boundary = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_MESH_LINE_CHARS) {
      console.warn(`[GhostMesh ${label}] Dropping ${connId}: frame exceeds ${MAX_MESH_LINE_CHARS} chars`);
      socket.destroy();
    }
  });

  socket.on('close', () => {
    activeMeshSockets.delete(connId);
    mainWindow?.webContents.send('ghostmesh-peer-disconnected', { connId });
  });

  socket.on('error', (err) => {
    console.warn(`[GhostMesh ${label} Socket Error]`, err.message);
  });
}

/* ═══════════════════════════════════════════════════════════════
   IPC HANDLERS
   ═══════════════════════════════════════════════════════════════ */

function setupIPC() {
  /* ── Window controls ────────────────────────────────────────── */
  ipcMain.on('minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.on('maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  /* ── Notifications ──────────────────────────────────────────── */
  ipcMain.on('notify', (_e, title, body) => {
    if (store.get('mutedNotifications')) return;
    const notif = new Notification({
      title,
      body,
      icon: getAppIcon(),
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
    flashTray(tray);
  });

  /* ── Badge count ────────────────────────────────────────────── */
  ipcMain.on('badge-count', (_e, count) => {
    updateBadge(tray, count);
    if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
    if (process.platform === 'linux' || process.platform === 'win32') {
      mainWindow?.setTitle(count > 0 ? `GhostLink (${count})` : 'GhostLink');
    }
  });

  /* ── Clipboard ──────────────────────────────────────────────── */
  ipcMain.on('clipboard-write', (_e, text) => {
    clipboard.writeText(text);
  });

  /* ── File operations ────────────────────────────────────────── */
  // The desktop contact vault's 32-byte data key, from safeStorage (OS keyring).
  // Fails closed on basic_text / no keyring: the renderer then keeps contacts in
  // memory and shows a warning rather than sealing with a key that protects nothing.
  ipcMain.handle('contact-vault-key', () => getContactVaultKey(safeStorage, store));

  // One source of truth for the fail-closed UI banner: is this device able to
  // protect secrets at rest at all? Used for both the seed and the contacts.
  ipcMain.handle('secure-storage-status', () => secureStorageStatus(safeStorage));

  ipcMain.handle('save-file', async (_e, data, filename) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePath) return null;
    try {
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      dialog.showErrorBox('Save Failed', err.message);
      return null;
    }
  });

  ipcMain.handle('open-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || filePaths.length === 0) return null;
    try {
      const filePath = filePaths[0];
      const data = fs.readFileSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        data: Array.from(new Uint8Array(data)),
        size: data.length,
      };
    } catch (err) {
      dialog.showErrorBox('Open Failed', err.message);
      return null;
    }
  });

  /* ── GMP Node/Bridge IPC Handlers ───────────────────────────── */
  ipcMain.handle('gmp-start', async (_e, seed) => {
    // Persisting the seed and running the node are independent: if secure
    // storage is unavailable we still start the session (identity works this
    // launch), we just do NOT write the seed to disk, and we tell the renderer
    // so it can show the amber "identity isn't saved on this device" banner.
    // Never fall back to plaintext.
    let seedPersisted = false;
    let seedPersistError = null;
    try {
      seedPersisted = setStoredSeed(seed) === true;
    } catch (err) {
      seedPersistError = err.message;
      console.warn('[Electron GMP] Seed not persisted (running session-only):', err.message);
    }
    await startGMPNode(seed);
    return { ok: true, seedPersisted, seedPersistError, secureStorage: secureStorageStatus(safeStorage) };
  });

  /* ── Auto-update trigger ────────────────────────────────────── */
  ipcMain.on('install-update', () => {
    // Only flag the quit when an update is actually installed; otherwise a
    // stray call left isQuitting set and the window stopped hiding to tray.
    if (updateReady()) {
      isQuitting = true;
      quitAndInstall();
    }
  });

  /* ── Ghost Mesh (Yggdrasil TCP Socket Bridge) ───────────────── */
  ipcMain.handle('ghostmesh-start-server', async () => {
    if (ghostMeshServer) {
      return { success: true, message: 'Server already running' };
    }
    
    return new Promise((resolve) => {
      try {
        ghostMeshServer = net.createServer((socket) => {
          const connId = `mesh-${Math.random().toString(36).slice(2, 10)}`;
          activeMeshSockets.set(connId, socket);
          
          mainWindow?.webContents.send('ghostmesh-peer-connected', {
            connId,
            remoteAddress: socket.remoteAddress,
            type: 'incoming'
          });
          
          wireMeshSocket(socket, connId, 'Server');
        });
        
        ghostMeshServer.on('error', (err) => {
          console.error('[GhostMesh Server Error]', err.message);
          resolve({ success: false, error: err.message });
        });
        
        ghostMeshServer.listen({ host: '::', port: GHOSTMESH_PORT }, () => {
          console.log(`[GhostMesh] Server listening on [::]:${GHOSTMESH_PORT}`);
          resolve({ success: true });
        });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  ipcMain.handle('ghostmesh-stop-server', async () => {
    if (!ghostMeshServer) {
      return { success: true };
    }
    return new Promise((resolve) => {
      // destroy, not end: a half-closed socket can stay open forever and
      // server.close() would never call back.
      for (const [connId, socket] of activeMeshSockets.entries()) {
        try { socket.destroy(); } catch (e) {}
        activeMeshSockets.delete(connId);
      }
      ghostMeshServer.close(() => {
        ghostMeshServer = null;
        console.log('[GhostMesh] Server stopped');
        resolve({ success: true });
      });
    });
  });

  ipcMain.handle('ghostmesh-dial', async (_e, { host, port = GHOSTMESH_PORT }) => {
    return new Promise((resolve) => {
      try {
        console.log(`[GhostMesh] Dialing ${host}:${port}...`);
        const socket = net.connect({ host, port }, () => {
          const connId = `mesh-${Math.random().toString(36).slice(2, 10)}`;
          activeMeshSockets.set(connId, socket);
          
          wireMeshSocket(socket, connId, 'Dial');
          resolve({ success: true, connId });
        });
        
        socket.on('error', (err) => {
          console.error('[GhostMesh Dial Error]', err.message);
          resolve({ success: false, error: err.message });
        });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  ipcMain.handle('ghostmesh-send', async (_e, { connId, data }) => {
    const socket = activeMeshSockets.get(connId);
    if (socket) {
      try {
        socket.write(data + '\n');
        return true;
      } catch (err) {
        console.error('[GhostMesh Send Error]', err.message);
        return false;
      }
    }
    return false;
  });

  ipcMain.handle('ghostmesh-close', async (_e, { connId }) => {
    const socket = activeMeshSockets.get(connId);
    if (socket) {
      try {
        socket.end();
        activeMeshSockets.delete(connId);
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  });
}

/* ═══════════════════════════════════════════════════════════════
   GLOBAL SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */

function registerShortcuts() {
  // Ctrl+Shift+G — toggle main window visibility
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow) {
      createMainWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   AUTO-LAUNCH
   ═══════════════════════════════════════════════════════════════ */

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath,
  });
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function getAppIcon() {
  const iconName =
    process.platform === 'win32' ? 'icon.ico' :
    process.platform === 'darwin' ? 'icon.icns' : 'icon.png';
  const iconPath = path.join(__dirname, '..', 'assets', iconName);
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // Fallback: generate a simple 32x32 icon programmatically
  return generateFallbackIcon();
}

function generateFallbackIcon() {
  // 16x16 solid teal square as a minimal placeholder
  const size = 16;
  const channels = 4; // RGBA
  const buf = Buffer.alloc(size * size * channels);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0;     // R
    buf[i * 4 + 1] = 255;   // G
    buf[i * 4 + 2] = 200;   // B
    buf[i * 4 + 3] = 255;   // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/* ═══════════════════════════════════════════════════════════════
   APP LIFECYCLE
   ═══════════════════════════════════════════════════════════════ */

app.whenReady().then(async () => {
  // Auto-start GMP node on app launch if seed exists
  const savedSeed = getStoredSeed();
  if (savedSeed) {
    try {
      await startGMPNode(savedSeed);
    } catch (err) {
      console.error('[Electron GMP] Failed to auto-start GMP Node:', err.message);
    }
  }

  // Electron grants every permission by default; allow only what calls need.
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  setupIPC();
  registerShortcuts();

  mainWindow = createMainWindow();

  // System tray
  tray = createTray(() => mainWindow, store, () => {
    isQuitting = true;
    app.quit();
  });

  // Auto-updater (non-blocking)
  if (!IS_DEV) {
    initUpdater(mainWindow);
  }

  // Set auto-launch from saved preference
  if (store.get('autoLaunch')) {
    setAutoLaunch(true);
  }

  // macOS: re-create window on dock click
  app.on('activate', () => {
    if (!mainWindow) {
      mainWindow = createMainWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  stopGMPNode();
  globalShortcut.unregisterAll();
  destroyTray(tray);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/* ─── Prevent navigation to external URLs inside the app ────── */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navEvent, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      navEvent.preventDefault();
      return;
    }
    if (parsed.protocol !== 'file:') {
      navEvent.preventDefault();
      openExternalIfSafe(url);
    }
  });

  // Nothing in this app embeds a webview, and an attached one would not
  // inherit the window's webPreferences hardening.
  contents.on('will-attach-webview', (attachEvent) => {
    attachEvent.preventDefault();
  });
});
