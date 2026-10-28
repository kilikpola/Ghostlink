'use strict';
/**
 * Keyring states and the contact-vault key (R1c).
 *
 * Three states are never collapsed: "locked" (a real backend that cannot
 * encrypt right now), "insecure" (basic_text, a fixed built-in key) and
 * "unreadable" (encryption works but the stored key will not decrypt). A key
 * that will not decrypt is never overwritten: only an explicit replace moves it
 * aside (dot-free key, copy verified), and it is moved back if storing the new
 * key fails. While locked, nothing in the store is touched at all.
 *
 * Real electron/src/contact-key.js; safeStorage and electron-store are fakes
 * shaped like STEP 0's measurements. Run: node test/contact-key-states.test.js
 */
const ck = require('../electron/src/contact-key.js');
const { getContactVaultKey, secureStorageStatus, CONTACT_KEY_STORE } = ck;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

// A store that counts writes, optionally failing some of them.
function fakeStore(init = {}, { failSet = () => false } = {}) {
  const m = new Map(Object.entries(init));
  const writes = [];
  return {
    get: (k) => (m.has(k) ? m.get(k) : undefined),
    set: (k, v) => { if (failSet(k, v)) throw new Error('disk full (test)'); writes.push(['set', k]); m.set(k, v); },
    delete: (k) => { writes.push(['delete', k]); m.delete(k); },
    map: m, writes,
  };
}
const keyring = (tag) => ({
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (s) => Buffer.from(`${tag}:${s}`, 'utf8'),
  decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith(`${tag}:`)) throw new Error('wrong keyring'); return t.slice(tag.length + 1); },
});
const locked = () => ({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: () => { throw new Error('locked'); }, decryptString: () => { throw new Error('locked'); } });
const basicText = () => ({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text',
  encryptString: (s) => Buffer.from(`HARDCODED:${s}`), decryptString: (b) => b.toString().replace(/^HARDCODED:/, '') });
const sealed = (tag, keyHex) => keyring(tag).encryptString(keyHex).toString('base64');
const KEY_A = 'a'.repeat(64);
const asideKeys = (store) => [...store.map.keys()].filter((k) => k.startsWith(`${CONTACT_KEY_STORE}_unreadable_`));
const replace = ck.replaceContactVaultKey || (() => ({ available: false, state: 'missing', reason: 'replaceContactVaultKey not implemented' }));

console.log('\n=== status: three states, each with its own message ===');
{
  const L = secureStorageStatus(locked());
  ok(L.state === 'locked', `locked keyring -> state "locked" (got ${JSON.stringify(L.state)})`);
  ok(L.reason === 'Your system keyring is locked. Unlock it and restart GhostLink.', `locked message is exact (got ${JSON.stringify(L.reason)})`);
  const I = secureStorageStatus(basicText());
  ok(I.state === 'insecure', `basic_text -> state "insecure" (got ${JSON.stringify(I.state)})`);
  ok(/gnome-keyring/.test(I.reason) && /KWallet/.test(I.reason) && /install/i.test(I.reason), `insecure message names the fix (${JSON.stringify(I.reason)})`);
  ok(![L.reason, I.reason].some((r) => /not found|no system keyring/i.test(r)), 'neither says the keyring was "not found"');
  const U = secureStorageStatus(keyring('k2'));
  ok(U.available === true && U.state === 'ok' && U.reason === '', 'positive control: a working keyring is "ok" with no reason');
}

console.log('\n=== contact key: locked -> nothing touched ===');
{
  const store = fakeStore({ [CONTACT_KEY_STORE]: sealed('k2', KEY_A) });
  const before = store.get(CONTACT_KEY_STORE);
  const r = getContactVaultKey(locked(), store);
  ok(r.available === false && r.state === 'locked', `locked -> unavailable, state "locked" (got ${JSON.stringify(r.state)})`);
  ok(store.writes.length === 0 && store.get(CONTACT_KEY_STORE) === before, `no store writes, key byte-identical (writes: ${store.writes.length})`);
  const rr = replace(locked(), store, 'REPLACE');
  ok(rr.available === false && store.writes.length === 0, 'replace while locked does nothing');
  // Positive control: the same stored key opens once the keyring is unlocked.
  const c = getContactVaultKey(keyring('k2'), store);
  ok(c.available === true && c.keyHex === KEY_A, 'control: unlocked, the same key opens');
}

console.log('\n=== contact key: undecryptable -> refused, never overwritten ===');
{
  const store = fakeStore({ [CONTACT_KEY_STORE]: sealed('k1', KEY_A) });   // sealed under another keyring
  const before = store.get(CONTACT_KEY_STORE);
  const r = getContactVaultKey(keyring('k2'), store);
  ok(r.available === false && r.state === 'unreadable', `state "unreadable", no key handed out (got ${JSON.stringify(r)})`);
  ok(store.get(CONTACT_KEY_STORE) === before && store.writes.length === 0, `the stored key is byte-identical, no writes (writes: ${store.writes.length})`);
  const again = getContactVaultKey(keyring('k2'), store);
  ok(again.state === 'unreadable' && store.get(CONTACT_KEY_STORE) === before, 'a second launch still refuses (no silent regeneration later)');
  const malformed = fakeStore({ [CONTACT_KEY_STORE]: sealed('k2', 'not-hex') });
  const m0 = malformed.get(CONTACT_KEY_STORE);
  ok(getContactVaultKey(keyring('k2'), malformed).state === 'unreadable' && malformed.get(CONTACT_KEY_STORE) === m0, 'a malformed key is also "unreadable", kept');
  // Positive control: an empty store still provisions a fresh key.
  const fresh = fakeStore();
  const f = getContactVaultKey(keyring('k2'), fresh);
  ok(f.available === true && /^[0-9a-f]{64}$/.test(f.keyHex), 'control: no stored key -> a new one is provisioned');
}

console.log('\n=== contact key: explicit replace moves the old key aside ===');
{
  const store = fakeStore({ [CONTACT_KEY_STORE]: sealed('k1', KEY_A) });
  const before = store.get(CONTACT_KEY_STORE);
  const wrong = replace(keyring('k2'), store, 'replace');
  ok(wrong.available === false && store.get(CONTACT_KEY_STORE) === before && asideKeys(store).length === 0, 'a wrong confirmation word changes nothing');
  const r = replace(keyring('k2'), store, 'REPLACE');
  const aside = asideKeys(store);
  ok(r.available === true && /^[0-9a-f]{64}$/.test(r.keyHex) && r.keyHex !== KEY_A, 'a new key is stored and handed out');
  ok(aside.length === 1 && store.get(aside[0]) === before, `the old key is under a new name, byte-identical (${JSON.stringify(aside)})`);
  ok(aside.length === 1 && !aside[0].includes('.') && /\d{8}T\d{6}Z$/.test(aside[0]), 'the new name has a UTC timestamp and no "."');
  ok(aside.length === 1 && keyring('k1').decryptString(Buffer.from(store.get(aside[0]), 'base64')) === KEY_A, 'the old key still opens under its own keyring at the new name');
  ok(getContactVaultKey(keyring('k2'), store).keyHex === r.keyHex, 'the new key is what later launches get');
  const readable = fakeStore({ [CONTACT_KEY_STORE]: sealed('k2', KEY_A) });
  const rr = replace(keyring('k2'), readable, 'REPLACE');
  ok(rr.available === false && asideKeys(readable).length === 0 && readable.get(CONTACT_KEY_STORE) === sealed('k2', KEY_A), 'a READABLE key is never replaced');
}

console.log('\n=== contact key: storing the new key fails -> old key moved back ===');
{
  const old = sealed('k1', KEY_A);
  const store = fakeStore({ [CONTACT_KEY_STORE]: old }, { failSet: (k, v) => k === CONTACT_KEY_STORE && v !== old });
  const r = replace(keyring('k2'), store, 'REPLACE');
  ok(r.available === false, 'replace reports failure');
  ok(store.get(CONTACT_KEY_STORE) === old, 'the old key is back under its own name, byte-identical');
  ok(asideKeys(store).length === 0, `no aside copy left (${JSON.stringify(asideKeys(store))})`);
  const asideFails = fakeStore({ [CONTACT_KEY_STORE]: old }, { failSet: (k) => k !== CONTACT_KEY_STORE });
  const r2 = replace(keyring('k2'), asideFails, 'REPLACE');
  ok(r2.available === false && asideFails.get(CONTACT_KEY_STORE) === old && asideFails.writes.length === 0, 'if the aside copy cannot be written, nothing changes');
}

console.log('\n=== renderer: contacts sealed under the old key are moved aside, or put back ===');
(async () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const fnSrc = (name) => { const i = html.indexOf(`\n${name}`); return i < 0 ? null : html.slice(i, html.indexOf('\n}\n', i) + 3); };
  const parts = ['const __GL_CONTACT_SECRET_KEYS', 'function __glMoveSealedContactsAside(', 'function __glPutContactsBack(', 'async function __glReplaceContactKey('].map(fnSrc);
  if (parts.some((p) => !p)) { ok(false, 'renderer replace helpers exist in index.html'); return done(); }
  const keysLine = html.slice(html.indexOf('\nconst __GL_CONTACT_SECRET_KEYS'), html.indexOf(';', html.indexOf('\nconst __GL_CONTACT_SECRET_KEYS')) + 1);
  const R = new Function(`${keysLine}\n${parts.slice(1).join('\n')}\nreturn { __glReplaceContactKey };`)();
  const mkStorage = (init) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const SEALED = 'gl-sealed:v1:00ff:abcd';
  {
    const st = mkStorage({ gl_peer_cache: SEALED, gl_verified_contacts: SEALED + 'x', unrelated: 'keep' });
    let reloaded = 0;
    const res = await R.__glReplaceContactKey({ contactVault: { replace: async () => ({ available: true, keyHex: 'b'.repeat(64) }) } }, st, 'REPLACE', () => reloaded++);
    const aside = [...st.m.keys()].filter((k) => k.includes('_unreadable_'));
    ok(res.available && reloaded === 1, 'key replaced -> page reloads');
    ok(aside.length === 2 && st.getItem('gl_peer_cache') === null && aside.some((k) => k.startsWith('gl_peer_cache_unreadable_') && st.getItem(k) === SEALED),
      `sealed entries now live under aside names, byte-identical (${JSON.stringify(aside)})`);
    ok(st.getItem('unrelated') === 'keep', 'other keys untouched');
  }
  {
    const st = mkStorage({ gl_peer_cache: SEALED });
    let reloaded = 0;
    const res = await R.__glReplaceContactKey({ contactVault: { replace: async () => ({ available: false, reason: 'disk full (test)' }) } }, st, 'REPLACE', () => reloaded++);
    ok(!res.available && reloaded === 0, 'key NOT replaced -> no reload');
    ok(st.getItem('gl_peer_cache') === SEALED && ![...st.m.keys()].some((k) => k.includes('_unreadable_')), 'entries put back byte-identical, no aside copies left');
  }
  done();
})();
function done() {
  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
