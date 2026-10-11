/**
 * AppContext's reducer and the storage it clears.
 *
 * The provider is JSX and imports native modules, so the plain-JS region —
 * storage keys, initial state, actions and the reducer — is lifted out of the
 * real source and evaluated, the same way qr-scan.test lifts classifyScan.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {DEFAULT_SETTINGS} from '../src/utils/settings-migration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

// recovery.js pulls in the keychain; only its key constants are needed here.
const recoverySrc = read('src/utils/recovery.js');
const constOf = (src, name) => src.match(new RegExp(`const ${name} = '([^']+)'`))[1];
const BUNDLE_STORAGE_KEY = constOf(recoverySrc, 'BUNDLE_STORAGE_KEY');
const FRAGMENTS_STORAGE_KEY = constOf(recoverySrc, 'FRAGMENTS_STORAGE_KEY');

const ctxSrc = read('src/context/AppContext.js');
const region = ctxSrc.slice(ctxSrc.indexOf('const STORAGE_KEYS'), ctxSrc.indexOf('// ─── Context'));
const {appReducer, Actions, INITIAL_STATE, WIPE_KEYS, IDENTITY_SCOPED_KEYS, STORAGE_KEYS} = new Function(
  'DEFAULT_SETTINGS', 'BUNDLE_STORAGE_KEY', 'FRAGMENTS_STORAGE_KEY',
  `${region}\nreturn {appReducer, Actions, INITIAL_STATE, WIPE_KEYS, IDENTITY_SCOPED_KEYS, STORAGE_KEYS};`,
)(DEFAULT_SETTINGS, BUNDLE_STORAGE_KEY, FRAGMENTS_STORAGE_KEY);

// ── The private key never enters app state (which is persisted in clear) ──
{
  // Exactly what RecoveryScreen passes after restoreFromFragments/unlockBundle.
  const restored = {name: 'A', publicKeyHex: '04ab', privateKeyRaw: 'deadbeef', fingerprint: 'f', ghostAddress: ''};
  const s = appReducer(INITIAL_STATE, {type: Actions.SET_IDENTITY, payload: restored});
  ok(!('privateKeyRaw' in s.identity), 'setIdentity drops privateKeyRaw');
  ok(!JSON.stringify(s.identity).includes('deadbeef'), 'nothing persisted from the identity contains the key');
  ok(s.identity.publicKeyHex === '04ab' && s.identity.name === 'A', 'the public parts are kept');

  // A copy an earlier build already wrote is scrubbed on the next launch.
  const h = appReducer(INITIAL_STATE, {type: Actions.RESTORE_STATE, payload: {identity: restored}});
  ok(!('privateKeyRaw' in h.identity), 'hydrating a leaked identity drops the key');
  ok(appReducer(INITIAL_STATE, {type: Actions.SET_IDENTITY, payload: null}).identity === null,
     'clearing the identity still works');
  const persist = ctxSrc.slice(ctxSrc.indexOf('// ── Persist identity'), ctxSrc.indexOf('// ── Persist messages'));
  ok(persist.includes('JSON.stringify(withoutSecrets(state.identity))'), 'the identity is stripped again at the write');
}

// ── Deleting a peer deletes the conversation ───────────────────────────────
{
  let s = appReducer(INITIAL_STATE, {type: Actions.ADD_PEER, payload: {id: 'peer-1', roomId: 'room-peer-1', name: 'A'}});
  s = appReducer(s, {type: Actions.ADD_PEER, payload: {id: 'peer-2', roomId: 'room-peer-2', name: 'B'}});
  // ChatScreen files messages under the peer id.
  s = appReducer(s, {type: Actions.ADD_MESSAGE, payload: {roomId: 'peer-1', message: {id: 'm1', text: 'secret'}}});
  s = appReducer(s, {type: Actions.ADD_MESSAGE, payload: {roomId: 'peer-2', message: {id: 'm2', text: 'keep'}}});
  s = appReducer(s, {type: Actions.REMOVE_PEER, payload: 'peer-1'});
  ok(!s.peers.has('peer-1'), 'the removed peer is gone');
  ok(!s.messages.has('peer-1'), "the removed peer's messages are gone, not left persisted");
  ok(s.messages.get('peer-2')?.length === 1, "other peers' messages are untouched");
}

// ── Restoring leaves ghostMesh in its full shape ───────────────────────────
{
  const s = appReducer({...INITIAL_STATE, ghostMesh: {enabled: true, address: 'x', publicKeyHex: 'y', status: 'active'}},
    {type: Actions.CLEAR_IDENTITY_DATA});
  ok(s.ghostMesh.status === 'not_configured', 'clearing identity data resets mesh status too');
}

// ── Wipe covers every key the app writes ───────────────────────────────────
{
  // Every literal or constant handed to storage.setItem (utils/storage.js)
  // or AsyncStorage.setItem anywhere in src.
  const constants = {
    BUNDLE_STORAGE_KEY, FRAGMENTS_STORAGE_KEY,
    STORAGE_KEY: constOf(read('src/services/MobileDistributor.js'), 'STORAGE_KEY'),
  };
  for (const [k, v] of Object.entries(STORAGE_KEYS)) constants[`STORAGE_KEYS.${k}`] = v;

  const files = [];
  const walk = d => fs.readdirSync(d, {withFileTypes: true}).forEach(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name)));
  walk(path.join(here, '..', 'src'));

  const written = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:AsyncStorage|storage)\.setItem\(\s*([^,]+?)\s*,/g)) {
      const arg = m[1];
      const literal = arg.match(/^'([^']+)'$/);
      const key = literal ? literal[1] : constants[arg];
      ok(key !== undefined, `setItem key ${arg} in ${path.basename(f)} is resolvable by this test`);
      if (key) written.add(key);
    }
  }
  // The retired fragment and invite-code keys are not written, but are still
  // wiped below for older installs.
  ok(written.size >= 7, `found the app's storage keys (${written.size})`);
  for (const key of written) ok(WIPE_KEYS.includes(key), `wipe removes ${key}`);

  for (const key of [BUNDLE_STORAGE_KEY, FRAGMENTS_STORAGE_KEY, 'gl_invite_code']) {
    ok(IDENTITY_SCOPED_KEYS.includes(key), `restoring a different identity removes ${key}`);
  }
  ok(!IDENTITY_SCOPED_KEYS.includes(STORAGE_KEYS.SETTINGS), 'restoring keeps the user\'s settings');
}

// ── Every screen that shows or takes a recovery phrase sets FLAG_SECURE ───
{
  const recovery = read('src/screens/RecoveryScreen.js');
  ok(/\n  useSecureScreen\(\);/.test(recovery), 'RecoveryScreen (phrase shown and entered) blocks screenshots');
  ok((recovery.match(/ghostAddress: identity\?\.ghostAddress/g) || []).length === 2,
     'backups made from RecoveryScreen keep the Ghost Address');
  ok((recovery.match(/unlockBundle\(blob, words\);\s*\/\/[^\n]*\n\s*await CryptoEngine\.storeKeyPair/g) || []).length === 2,
     'peer-recovered keys go to the keystore, since app state no longer carries them');
}

// ── Settings reports a partial wipe instead of claiming success ────────────
{
  const settings = read('src/screens/SettingsScreen.js');
  ok(/const result = await wipeAll\(\);\s*if \(!result\.ok\)/.test(settings),
     'Settings tells the user when the wipe could not remove everything');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
