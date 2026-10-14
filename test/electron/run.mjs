/**
 * Electron-binary test: drives the real Electron app's main-process secure
 * storage and the renderer contact-vault boot, forcing each backend with
 * --password-store, and asserts pass/fail. Run: node test/electron/run.mjs
 * (headless; needs node_modules/.bin/electron).
 */
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, '..', '..');
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron');
const SEED = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

function run(passwordStore, harness, args) {
  const marker = harness.includes('renderer') ? 'PROBE' : 'RESULT';
  const out = execFileSync(ELECTRON, ['--headless', '--disable-gpu', '--no-sandbox', `--password-store=${passwordStore}`, path.join(DIR, harness), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90000 });
  const line = out.split('\n').find((l) => l.startsWith(marker));
  if (!line) throw new Error(`no ${marker} from ${harness} ${args.join(' ')}`);
  return JSON.parse(line.slice(marker.length + 1));
}

console.log('\n=== main process: seed store + contact key against REAL safeStorage ===');
const D1 = path.join(os.tmpdir(), 'gl-elec-keyring-' + Date.now()); fs.rmSync(D1, { recursive: true, force: true });
const set1 = run('gnome-libsecret', 'secure-storage.electron.cjs', [D1, 'seed-set', SEED]);
ok(set1.persisted === true && set1.status.available === true, 'keyring: seed is persisted (sealed)');
const get1 = run('gnome-libsecret', 'secure-storage.electron.cjs', [D1, 'seed-get']);
ok(get1.seed === SEED, 'keyring: seed survives a restart (separate process)');
ok(!fs.readFileSync(path.join(D1, 'store.json'), 'utf8').includes('bravo'), 'keyring: the seed phrase is NOT in cleartext on disk');
const key1 = run('gnome-libsecret', 'secure-storage.electron.cjs', [D1, 'key-get']);
ok(key1.available === true && key1.keyLen === 64, 'keyring: contact vault key is a 32-byte key');

const D2 = path.join(os.tmpdir(), 'gl-elec-basic-' + Date.now()); fs.rmSync(D2, { recursive: true, force: true });
const set2 = run('basic', 'secure-storage.electron.cjs', [D2, 'seed-set', SEED]);
ok(set2.persisted === false && set2.status.available === false, 'basic_text: seed is NOT persisted (fail closed)');
ok(!fs.existsSync(path.join(D2, 'store.json')), 'basic_text: nothing was written to disk at all');
const key2 = run('basic', 'secure-storage.electron.cjs', [D2, 'key-get']);
ok(key2.available === false && key2.keyLen === 0, 'basic_text: no contact vault key is handed out');

console.log('\n=== renderer boot (real index.html in an offscreen BrowserWindow) ===');
const a = run('gnome-libsecret', 'renderer-boot.electron.cjs', ['available']);
ok(a.vaultInstalled && a.vaultAvailable, 'available: the vault is installed and usable before mount');
ok(a.peerCacheSealed === true && a.peerCacheHasPlaintextDana === false, 'available: a plaintext contact store is migrated to sealed, no plaintext left');
ok(a.verifiedSealed === true && a.fragMetaHasPlaintextEve === false, 'available: gl_verified_contacts + gl_fragment_meta are sealed too (Item 6)');
ok(a.bannerShown === false, 'available: no fail-closed banner');
ok(a.vaultKeyPresent === false, 'available: the removed gl_vault_key (LocalVault) is deleted by the startup migration (Part 3)');
ok(a.firstReadAt == null || a.firstReadAt >= a.bootDoneAt, 'available: no contact read precedes the vault install (ordering)');

const u = run('basic', 'renderer-boot.electron.cjs', ['unavailable']);
ok(!u.vaultInstalled && u.storageUnavailableFlag, 'unavailable: FAIL CLOSED (session-only), vault not installed');
ok(u.bannerShown === true, 'unavailable: the amber banner is shown');
ok(u.peerCacheHasPlaintextDana === false && u.fragMetaHasPlaintextEve === false && u.peerCacheAbsent === true, 'unavailable: pre-existing plaintext is removed from disk, nothing written');
ok(u.firstReadMode === 'session', 'unavailable: reads are session-only, never plaintext');
ok(u.firstReadAt == null || u.firstReadAt >= u.bootDoneAt, 'unavailable: no contact read precedes the boot (ordering)');

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
