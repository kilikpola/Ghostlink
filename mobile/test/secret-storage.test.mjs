/**
 * Mobile storage: sealed secrets, no stored Shamir fragments. Runs
 * secret-storage.js unmodified against in-memory fakes, starting from an
 * existing install's plaintext state.
 *
 *  1. upgrade: secrets sealed in place, retired keys deleted, settings left
 *     readable, nothing lost
 *  2. the upgrade is idempotent
 *  3. a crash part-way through is finished by the next start, nothing lost
 *  4. secure storage unavailable: secret writes fail, no plaintext written;
 *     an old plaintext value is still readable
 *  5. a sealed value moved to another key does not open
 *  6. retired and unclassified keys cannot be written
 *  7. wipe forgets the data key: what is left behind cannot be opened
 *  8. source: nothing writes a fragment, only utils/storage.js touches
 *     AsyncStorage, and every storage key literal in src/ is classified
 */
import {webcrypto} from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true, writable: true});

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const rejects = async (fn, code, name) => {
  try { await fn(); ok(false, `${name} (no throw)`); }
  catch (e) { ok(!code || e.code === code, `${name}${code && e.code !== code ? ` (got ${e.code}: ${e.message})` : ''}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// The module is ESM in a package Node treats as CommonJS: load a .mjs copy.
const modPath = path.join(here, '.secret-storage.mjs');
fs.writeFileSync(modPath, fs.readFileSync(path.join(root, 'src/utils/secret-storage.js'), 'utf8'));
const S = await import(modPath);

function memStore(name) {
  const m = new Map();
  let failAfter = Infinity;
  let calls = 0;
  return {
    name, m,
    failSetsAfter(n) { failAfter = n; calls = 0; },
    async getItem(k) { return m.has(k) ? m.get(k) : null; },
    async setItem(k, v) { if (++calls > failAfter) throw new Error(`${name} write failed (simulated)`); m.set(k, v); },
    async removeItem(k) { m.delete(k); },
  };
}
const randomBytes = (n) => webcrypto.getRandomValues(new Uint8Array(n));

// An existing install, as it is on disk today.
const SECRET_TEXT = 'meet me at the north gate at nine';
const legacy = {
  '@ghostlink/identity': JSON.stringify({publicKeyHex: 'ab'.repeat(32), name: 'Kidus', ghostAddress: 'ghost:abcd'}),
  '@ghostlink/messages': JSON.stringify({room1: [{id: 'm1', text: SECRET_TEXT}]}),
  '@ghostlink/peers': JSON.stringify({p1: {name: 'Abebe', ghostAddress: 'ghost:ef01'}}),
  '@ghostlink/ghost_mesh': JSON.stringify({enabled: true, address: '200:1234::1', publicKeyHex: 'cd'.repeat(32), status: 'configured'}),
  '@ghostlink/settings': JSON.stringify({settingsVersion: 3, meshBridgeUrl: '', fontSize: 16}),
  gl_recovery_bundle: JSON.stringify({v: 1, wrappedKey: {iv: 'aa', ciphertext: 'bb'}, publicKeyHex: 'ab'.repeat(32), name: 'Kidus'}),
  '@ghostlink/recovery-fragments': JSON.stringify({tag1: {fragment: 'held-for-someone-else', expiresAt: Date.now() + 1e9}}),
  gl_shamir_fragments: JSON.stringify(Array.from({length: 7}, (_, i) => ({id: i + 1, data: `share-${i + 1}-of-the-bundle`}))),
  gl_invite_code: 'GL-0123ABCD-4567EF01-89ABCDEF-01234567',
};
const fresh = () => {
  const plain = memStore('AsyncStorage');
  for (const [k, v] of Object.entries(legacy)) plain.m.set(k, v);
  const secure = memStore('EncryptedStorage');
  return {plain, secure, storage: S.createSecretStorage({plain, secure, randomBytes})};
};

console.log('\n[0] every key the app writes is classified');
for (const k of Object.keys(legacy)) ok(k in S.STORAGE_CLASSIFICATION, `${k}: ${S.STORAGE_CLASSIFICATION[k]?.secret ? 'secret' : S.STORAGE_CLASSIFICATION[k]?.retired ? 'retired' : 'not secret'}`);

console.log('\n[1] upgrading a device that has plaintext secrets and all 7 fragments');
{
  const {plain, secure, storage} = fresh();
  const report = await storage.migrate();
  // The stored fragments are NOT deleted by the storage upgrade —
  // they may be an install's way back to its identity. They are sealed in
  // place, and the recovery migration (legacy-recovery-migration.test.mjs)
  // deletes them once nothing depends on them.
  ok(plain.m.has('gl_shamir_fragments') && plain.m.get('gl_shamir_fragments').startsWith(S.SEALED_PREFIX), 'the stored Shamir fragments are kept, sealed, for the recovery migration to decide');
  ok(!plain.m.has('gl_invite_code'), 'the never-read invite code is deleted');
  ok(report.deleted.join() === 'gl_invite_code', `report lists the deletions (${report.deleted})`);
  for (const k of S.SECRET_KEYS.filter((k) => k in legacy)) {
    const v = plain.m.get(k);
    ok(typeof v === 'string' && v.startsWith(S.SEALED_PREFIX), `${k} is sealed on disk`);
    ok((await storage.getItem(k)) === legacy[k], `${k} reads back unchanged`);
  }
  const everything = [...plain.m.values()].join('\n');
  ok(!everything.includes(SECRET_TEXT), 'the message text appears nowhere on disk');
  ok(!everything.includes('Abebe') && !everything.includes('held-for-someone-else') && !everything.includes('share-1-of'), 'contacts, held shares and own shares appear nowhere on disk');
  ok(plain.m.get('@ghostlink/settings') === legacy['@ghostlink/settings'], 'settings stay readable as they were (classified not secret)');
  ok(secure.m.has(S.DATA_KEY_NAME) && secure.m.size === 1, 'only the 32-byte data key is in encrypted storage');
}

console.log('\n[2] upgrading twice changes nothing');
{
  const {plain, storage} = fresh();
  await storage.migrate();
  const before = new Map(plain.m);
  const again = await storage.migrate();
  ok(again.sealed.length === 0 && again.deleted.length === 0, 'second run seals and deletes nothing');
  ok([...before].every(([k, v]) => plain.m.get(k) === v), 'every stored value is byte-identical');
}

console.log('\n[3] a crash part-way through the upgrade');
{
  const {plain, secure, storage} = fresh();
  plain.failSetsAfter(2); // two keys sealed, then the "process dies"
  await rejects(() => storage.migrate(), null, 'the interrupted upgrade throws');
  plain.failSetsAfter(Infinity);
  const next = S.createSecretStorage({plain, secure, randomBytes}); // next start
  const report = await next.migrate();
  const present = S.SECRET_KEYS.filter((k) => k in legacy).length;
  ok(report.alreadySealed.length === 2 && report.sealed.length === present - 2, `the next start finishes it (${report.alreadySealed.length} already sealed, ${report.sealed.length} sealed now)`);
  let intact = true;
  for (const k of S.SECRET_KEYS.filter((k) => k in legacy)) if ((await next.getItem(k)) !== legacy[k]) intact = false;
  ok(intact, 'every secret reads back unchanged after the interrupted upgrade');
}

console.log('\n[4] secure storage unavailable');
{
  const plain = memStore('AsyncStorage');
  plain.m.set('@ghostlink/messages', legacy['@ghostlink/messages']);
  const broken = {getItem: async () => { throw new Error('keystore locked'); }, setItem: async () => { throw new Error('keystore locked'); }, removeItem: async () => {}};
  const storage = S.createSecretStorage({plain, secure: broken, randomBytes});
  await rejects(() => storage.setItem('@ghostlink/peers', '{"p":1}'), 'SECURE_UNAVAILABLE', 'a secret write fails (no plaintext fallback)');
  ok(!plain.m.has('@ghostlink/peers'), 'and nothing was written');
  ok((await storage.getItem('@ghostlink/messages')) === legacy['@ghostlink/messages'], 'an old plaintext value is still readable');
  ok(plain.m.get('@ghostlink/messages') === legacy['@ghostlink/messages'], 'and left as it was, to be sealed once secure storage works');
  ok((await storage.setItem('@ghostlink/settings', '{"fontSize":18}'), plain.m.get('@ghostlink/settings') === '{"fontSize":18}'), 'non-secret settings still save');
}

console.log('\n[5] a sealed value does not open under another key');
{
  const {plain, storage} = fresh();
  await storage.migrate();
  plain.m.set('@ghostlink/peers', plain.m.get('@ghostlink/messages'));
  await rejects(() => storage.getItem('@ghostlink/peers'), 'UNREADABLE', 'messages ciphertext moved into the peers slot is refused');
}

console.log('\n[6] retired and unclassified keys cannot be written');
{
  const {storage} = fresh();
  await rejects(() => storage.setItem('gl_shamir_fragments', '[]'), 'RETIRED', 'writing the fragments key is refused');
  await rejects(() => storage.setItem('gl_invite_code', 'x'), 'RETIRED', 'writing the invite code is refused');
  await rejects(() => storage.setItem('@ghostlink/something-new', 'x'), 'UNCLASSIFIED', 'an unclassified key is refused until it is classified');
}

console.log('\n[7] wipe forgets the data key');
{
  const {plain, secure, storage} = fresh();
  await storage.migrate();
  const left = plain.m.get('@ghostlink/messages'); // say the delete failed
  await storage.forgetKey();
  ok(!secure.m.has(S.DATA_KEY_NAME), 'the data key is gone from encrypted storage');
  plain.m.set('@ghostlink/messages', left);
  await rejects(() => storage.getItem('@ghostlink/messages'), 'UNREADABLE', 'a sealed value left behind can no longer be opened');
}

console.log('\n[8] source: nothing writes a fragment; one storage path');
{
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) files.push(p); } };
  walk(path.join(root, 'src'));
  for (const f of [path.join(root, 'App.js'), path.join(root, 'index.js')]) if (fs.existsSync(f)) files.push(f);
  const rel = (f) => path.relative(root, f);
  const code = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const asyncUsers = files.filter((f) => /@react-native-async-storage\/async-storage/.test(code(f)));
  ok(asyncUsers.length === 1 && rel(asyncUsers[0]) === path.join('src', 'utils', 'storage.js'), `only src/utils/storage.js imports AsyncStorage (${asyncUsers.map(rel).join(', ')})`);

  const fragWrites = files.filter((f) => /setItem\(\s*(FRAGMENTS_STORAGE_KEY|['"]gl_shamir_fragments['"])/.test(code(f)));
  ok(fragWrites.length === 0, `no code writes the fragments key (${fragWrites.map(rel).join(', ') || 'none'})`);

  const generators = files.filter((f) => /generateBackupFragments\(/.test(code(f)) && !/export function generateBackupFragments|function generateBackupFragments/.test(fs.readFileSync(f, 'utf8')));
  ok(generators.length === 1 && rel(generators[0]) === path.join('src', 'screens', 'RecoveryScreen.js'),
     `fragments are generated only on the Recovery screen, for the user to copy (${generators.map(rel).join(', ')})`);
  ok(!/generateBackupFragments/.test(code(path.join(root, 'src/screens/SetupScreen.js'))), 'setup no longer generates fragments at all');

  // Every storage-key-shaped literal in src is classified (or is the data key).
  const literals = new Set();
  for (const f of files) for (const m of code(f).matchAll(/['"](@ghostlink\/[a-z_-]+|gl_[a-z0-9_]+)['"]/g)) literals.add(m[1]);
  const unclassified = [...literals].filter((k) => !(k in S.STORAGE_CLASSIFICATION) && k !== S.DATA_KEY_NAME);
  ok(unclassified.length === 0, `every storage key literal in src/ is classified (${unclassified.join(', ') || 'all'})`);
}

fs.rmSync(modPath, {force: true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
