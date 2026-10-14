'use strict';
/**
 * Real-Electron test of the renderer contact-vault boot (index.html), loaded in
 * an OFFSCREEN BrowserWindow with a preload that injects a MOCK window.ghostlink
 * (so no GMP backend is needed). Verifies, in a real Chromium renderer:
 *   - the vault is installed BEFORE the first contact read (ordering),
 *   - with a keyring: a pre-existing plaintext gl_peer_cache is MIGRATED to
 *     sealed, and reads go through the vault,
 *   - without a keyring: FAIL CLOSED — the amber banner is shown, no plaintext.
 *
 *   electron renderer-boot.electron.cjs <available|unavailable>
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const selfIdx = process.argv.findIndex((a) => a.endsWith('renderer-boot.electron.cjs'));
const mode = (process.argv.slice(selfIdx + 1).filter((a) => !a.startsWith('-'))[0]) || 'available';
const REPO = path.join(__dirname, '..', '..');

// Preload: inject a mock ghostlink and a known plaintext contact BEFORE page JS.
const preloadFile = path.join(require('os').tmpdir(), `gl-mock-preload-${mode}.cjs`);
const KEYHEX = 'ab'.repeat(32); // 64 hex = 32 bytes
const PLAINTEXT = JSON.stringify({ ['d'.repeat(128)]: { name: 'Dana', pinnedAddress: 'GHOST-D11-222-333', lastSeen: 1 } });
fs.writeFileSync(preloadFile, `
  const avail = ${mode === 'available' ? 'true' : 'false'};
  try {
    window.localStorage.setItem('gl_peer_cache', ${JSON.stringify(PLAINTEXT)});
    window.localStorage.setItem('gl_verified_contacts', JSON.stringify({ zzz: true }));
    window.localStorage.setItem('gl_fragment_meta', JSON.stringify([{ id: 1, peerName: 'Eve', peerId: 'z'.repeat(128) }]));
    window.localStorage.setItem('gl_vault_key', 'ff'.repeat(32)); // removed LocalVault key; migration must delete it
  } catch (e) {}
  window.ghostlink = {
    isElectron: true,
    platform: 'linux',
    contactVault: { getKey: async () => avail ? { available: true, keyHex: ${JSON.stringify(KEYHEX)} } : { available: false, backend: 'basic_text', reason: 'OS secure storage is basic_text' } },
    secureStorage: { status: async () => avail ? { available: true, backend: 'gnome_libsecret', reason: '' } : { available: false, backend: 'basic_text', reason: 'OS secure storage is basic_text (a hardcoded key)' } },
    // stubs the app may call during mount:
    gmp: { start: async () => ({ ok: true }) },
    saveFile: async () => true, openFile: async () => null,
    onDeepLink: () => () => {}, onUpdateAvailable: () => () => {}, onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {}, onTrayAction: () => () => {},
    ghostMesh: { startServer: async()=>({}), stopServer: async()=>({}), onPeerConnected:()=>()=>{}, onData:()=>()=>{}, onPeerDisconnected:()=>()=>{} },
    notify: () => {}, setBadgeCount: () => {}, minimize:()=>{}, maximize:()=>{}, close:()=>{},
  };
`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: preloadFile, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const logs = [];
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg));
  await win.loadFile(path.join(REPO, 'index.html'));
  // Give the boot + React mount a moment, then probe + exercise a contact write.
  await new Promise((r) => setTimeout(r, 1500));
  const probe = await win.webContents.executeJavaScript(`(async () => {
    // Exercise a write through the real SecretStore seam, if reachable.
    let wroteSealed = null, memOnly = null;
    try {
      // Peek at the on-disk value for gl_peer_cache.
      const raw = localStorage.getItem('gl_peer_cache');
      wroteSealed = typeof raw === 'string' ? raw.startsWith('gl-sealed:v1:') : null;
      memOnly = raw == null;
    } catch (e) {}
    return {
      bootDoneAt: window.__vaultBootDoneAt ?? null,
      firstReadAt: window.__firstContactReadAt ?? null,
      firstReadMode: window.__firstContactReadMode ?? null,
      vaultInstalled: !!window.__contactVault,
      vaultAvailable: !!(window.__contactVault && window.__contactVault.available && window.__contactVault.available()),
      storageUnavailableFlag: !!window.__contactStorageUnavailable,
      bannerShown: !!document.getElementById('gl-secure-banner'),
      peerCacheSealed: wroteSealed,
      peerCacheAbsent: memOnly,
      peerCacheHasPlaintextDana: (localStorage.getItem('gl_peer_cache')||'').includes('Dana'),
      verifiedSealed: (() => { const r = localStorage.getItem('gl_verified_contacts'); return r == null ? 'absent' : r.startsWith('gl-sealed:v1:'); })(),
      fragMetaHasPlaintextEve: (localStorage.getItem('gl_fragment_meta')||'').includes('Eve'),
      vaultKeyPresent: localStorage.getItem('gl_vault_key') != null,
    };
  })()`);
  process.stdout.write('LOGS ' + JSON.stringify(logs.slice(0,15)) + '\n'); process.stdout.write('PROBE ' + JSON.stringify(probe) + '\n');
  win.destroy();
  app.quit();
});
app.on('window-all-closed', () => app.quit());
