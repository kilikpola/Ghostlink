'use strict';
/**
 * Real-Electron harness for the fail-closed seed store and contact vault key.
 * Runs under `electron`, against REAL safeStorage. Dispatches on argv so a shell
 * script can drive multi-process (restart) scenarios and force a backend with
 * --password-store=<basic|gnome-libsecret>.
 *
 *   electron secure-storage.electron.cjs <dataDir> <op>
 *   op = probe | seed-set <phrase> | seed-get | seed-status | key-get
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createSeedStore } = require('../../electron/src/seed-store.js');
const { getContactVaultKey, secureStorageStatus } = require('../../electron/src/contact-key.js');

// Electron/Chromium switches (--headless, --no-sandbox, --password-store=...)
// can appear anywhere in process.argv; take only the non-flag positionals that
// follow this script's own path.
const selfIdx = process.argv.findIndex((a) => a.endsWith('secure-storage.electron.cjs'));
const positionals = process.argv.slice(selfIdx + 1).filter((a) => !a.startsWith('-'));
const dataDir = positionals[0];
const op = positionals[1];
const arg = positionals[2];

// A tiny file-backed store with the {get,set,delete} shape createSeedStore and
// getContactVaultKey expect — isolates the test from electron-store specifics.
function fileStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { data = {}; }
  const flush = () => fs.writeFileSync(file, JSON.stringify(data));
  return {
    get: (k) => (k in data ? data[k] : undefined),
    set: (k, v) => { data[k] = v; flush(); },
    delete: (k) => { delete data[k]; flush(); },
  };
}

app.whenReady().then(() => {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_e) {}
  const store = fileStore(path.join(dataDir, 'store.json'));
  const seed = createSeedStore({ safeStorage, store });
  let out;
  try {
    if (op === 'probe') {
      out = { status: secureStorageStatus(safeStorage) };
    } else if (op === 'seed-set') {
      let persisted = false, error = null;
      try { persisted = seed.setSeed(arg); } catch (e) { error = e.message; }
      out = { persisted, error, status: seed.status() };
    } else if (op === 'seed-get') {
      out = { seed: seed.getSeed(), hasStoredSeed: seed.status().hasStoredSeed };
    } else if (op === 'seed-status') {
      out = { status: seed.status() };
    } else if (op === 'key-get') {
      const r = getContactVaultKey(safeStorage, store);
      // Never print the key bytes; report shape only.
      out = { available: r.available, backend: r.backend, reason: r.reason, keyLen: r.keyHex ? r.keyHex.length : 0 };
    } else {
      out = { err: 'unknown op ' + op };
    }
  } catch (e) {
    out = { fatal: String(e && e.stack || e) };
  }
  process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
  app.quit();
});
app.on('window-all-closed', () => app.quit());
