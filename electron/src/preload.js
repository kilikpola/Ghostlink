/**
 * GhostLink Desktop — Preload Script
 *
 * Bridges the renderer (web app) with native Electron APIs
 * through a secure, sandboxed contextBridge interface.
 *
 * Everything exposed here is available as window.ghostlink.*
 */

const { contextBridge, ipcRenderer } = require('electron');

/* ─── Allowed IPC channels (whitelist) ──────────────────────── */

const SEND_CHANNELS = [
  'minimize',
  'maximize',
  'close',
  'notify',
  'badge-count',
  'clipboard-write',
  'install-update',
];

const INVOKE_CHANNELS = [
  'save-file',
  'open-file',
  'ghostmesh-start-server',
  'ghostmesh-stop-server',
  'ghostmesh-dial',
  'ghostmesh-send',
  'ghostmesh-close',
  'gmp-start',
  'contact-vault-key',
  'secure-storage-status',
  'bridge-token',
];

const RECEIVE_CHANNELS = [
  'deep-link',
  'update-available',
  'update-downloaded',
  'update-error',
  'tray-action',
  'ghostmesh-peer-connected',
  'ghostmesh-data',
  'ghostmesh-peer-disconnected',
];

/* ─── Secure send helper (validates channel) ────────────────── */

function secureSend(channel, ...args) {
  if (SEND_CHANNELS.includes(channel)) {
    ipcRenderer.send(channel, ...args);
  }
}

function secureInvoke(channel, ...args) {
  if (INVOKE_CHANNELS.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
  return Promise.reject(new Error(`Blocked IPC invoke: ${channel}`));
}

function secureOn(channel, callback) {
  if (RECEIVE_CHANNELS.includes(channel)) {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, handler);
  }
}

/* ═══════════════════════════════════════════════════════════════
   EXPOSED API — window.ghostlink
   ═══════════════════════════════════════════════════════════════ */

contextBridge.exposeInMainWorld('ghostlink', {
  /* ── Platform info ──────────────────────────────────────────── */
  platform: process.platform,
  isElectron: true,

  /* ── Window controls ────────────────────────────────────────── */
  minimize: () => secureSend('minimize'),
  maximize: () => secureSend('maximize'),
  close: () => secureSend('close'),

  /* ── Notifications ──────────────────────────────────────────── */
  notify: (title, body) => secureSend('notify', title, body),

  /* ── Tray badge ─────────────────────────────────────────────── */
  setBadgeCount: (count) => secureSend('badge-count', count),

  /* ── Clipboard ──────────────────────────────────────────────── */
  copyToClipboard: (text) => secureSend('clipboard-write', text),

  /* ── File operations ────────────────────────────────────────── */
  saveFile: (data, filename) => secureInvoke('save-file', data, filename),
  openFile: () => secureInvoke('open-file'),

  /* ── Deep links ─────────────────────────────────────────────── */
  onDeepLink: (callback) => secureOn('deep-link', callback),

  /* ── Auto-update ────────────────────────────────────────────── */
  onUpdateAvailable: (callback) => secureOn('update-available', callback),
  onUpdateDownloaded: (callback) => secureOn('update-downloaded', callback),
  onUpdateError: (callback) => secureOn('update-error', callback),
  installUpdate: () => secureSend('install-update'),

  /* ── Ghost Mesh ─────────────────────────────────────────────── */
  ghostMesh: {
    startServer: () => secureInvoke('ghostmesh-start-server'),
    stopServer: () => secureInvoke('ghostmesh-stop-server'),
    dial: (host, port) => secureInvoke('ghostmesh-dial', { host, port }),
    send: (connId, data) => secureInvoke('ghostmesh-send', { connId, data }),
    close: (connId) => secureInvoke('ghostmesh-close', { connId }),
    onPeerConnected: (callback) => secureOn('ghostmesh-peer-connected', callback),
    onData: (callback) => secureOn('ghostmesh-data', callback),
    onPeerDisconnected: (callback) => secureOn('ghostmesh-peer-disconnected', callback),
  },

  gmp: {
    start: (seed) => secureInvoke('gmp-start', seed),
  },

  /* ── Contact vault key (OS keyring, fail-closed) ────────────────
     Returns {available:true, keyHex} when the OS keyring really
     protects the key, else {available:false, reason, backend}. The
     renderer must treat available:false as "no secure storage": keep
     contacts in memory and warn, never seal with a weak key. */
  contactVault: {
    getKey: () => secureInvoke('contact-vault-key'),
  },

  /* ── Secure storage status (drives the fail-closed banner) ────── */
  secureStorage: {
    status: () => secureInvoke('secure-storage-status'),
  },

  /* ── Per-launch bridge token (presented as a WebSocket subprotocol) ── */
  bridgeToken: () => secureInvoke('bridge-token'),

  /* ── Tray actions listener ──────────────────────────────────── */
  onTrayAction: (callback) => secureOn('tray-action', callback),
});

/* ═══════════════════════════════════════════════════════════════
   DRAG-AND-DROP GUARD
   ═══════════════════════════════════════════════════════════════
   A file dropped outside the chat drop zone would otherwise make
   Chromium navigate the window to that file. The chat pane's own
   onDrop handler (React, on #root) runs before these bubble-phase
   listeners on document. */

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});
