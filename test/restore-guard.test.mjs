/**
 * Safe restore (identity-v2.md D11, task R1).
 *
 * Runs the REAL restore code: validateAndDeriveKey and its helpers extracted
 * from index.html, and electron/src/restore-guard.js (what the `gmp-restore`
 * IPC handler runs) with real gmp-core identity derivation. Only the React
 * setters, the IPC hop and the OS keyring are stubbed. Prints no phrase.
 *
 * Run: node test/restore-guard.test.mjs
 */
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { FIXTURE_A, FIXTURE_B } from './helpers/fixture-phrases.mjs';
import { BIP39_WORDS, ACCEPTED_WORDS, isAcceptedWord } from '../shared/wordlist.js';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

// ── The real code under test ─────────────────────────────────────────
function slice(startText, endText) {
  const s = html.indexOf(startText);
  return s < 0 ? null : html.slice(s, html.indexOf(endText, s) + endText.length);
}
const topLevel = (name) => slice(`\nfunction ${name}(`, '\n}') ?? slice(`\nasync function ${name}(`, '\n}');
const cryptoEngineSrc = slice('const CryptoEngine = {', '\n};');
const restoreSrc = slice('const validateAndDeriveKey = async', '\n  };');
const declineSrc = slice('const declineRestore = ', '};');
const helperSrc = ['closestWords', 'unknownPhraseWords', 'bip39ChecksumValid'].map(topLevel);
const helpersPresent = helperSrc.every(Boolean);
const helpers = helpersPresent
  ? new Function(`${helperSrc.join('\n')}\nreturn { closestWords, unknownPhraseWords, bip39ChecksumValid };`)()
  : { closestWords: () => [], unknownPhraseWords: () => [], bip39ChecksumValid: async () => true };
const CryptoEngine = new Function(`${cryptoEngineSrc}\nreturn CryptoEngine;`)();

let createRestoreGuard = null;
try { ({ createRestoreGuard } = require(path.join(root, 'electron', 'src', 'restore-guard.js'))); } catch { /* A: not written yet */ }
const { deriveIdentityFromSeedPhrase } = await import(path.join(root, 'gmp-core', 'dist', 'identity.js'));
const { ghostAddressFromNodeId } = await import(path.join(root, 'gmp-core', 'dist', 'ghost-address.js'));
const deriveIdentity = async (phrase) => {
  const id = await deriveIdentityFromSeedPhrase(phrase);
  return { nodeIdHex: id.nodeIdHex, ghostAddress: ghostAddressFromNodeId(id.nodeIdHex) };
};

// ── A device: keyring + main process, as main.js wires them ─────────
function makeDevice({ storedSeed = null, persistFails = false } = {}) {
  const dev = { seed: storedSeed, starts: [], legacyStarts: [], persists: 0 };
  const setStoredSeed = (s) => {
    if (persistFails) throw new Error('secure storage unavailable (test)');
    dev.persists++; dev.seed = s; return true;
  };
  const startNode = async (s) => { dev.starts.push(s); };
  const guard = createRestoreGuard
    ? createRestoreGuard({ deriveIdentity, getStoredSeed: () => dev.seed, getStoredSeedState: () => (dev.seed ? 'readable' : 'none'), setStoredSeed, startNode })
    : null;
  dev.bridge = {
    isElectron: true,
    gmp: {
      // The pre-R1 handler: persist (errors swallowed), then start.
      start: async (s) => { dev.legacyStarts.push(s); try { setStoredSeed(s); } catch { /* session-only */ } await startNode(s); },
      restore: async (phrase, confirmedNodeId, replaceConfirmation) => {
        if (!guard) throw new Error('restore guard missing');
        return guard.restore(phrase, { confirmedNodeId, replaceConfirmation });
      },
    },
  };
  return dev;
}

// ── Run the extracted renderer restore against a device ─────────────
async function runRestore(dev, phrase, { confirm = false, overrides = {} } = {}) {
  const ui = { status: [], wordIssues: null, checksumWarning: null, pending: null, mismatch: null, error: null };
  const env = {
    verifyInput: phrase,
    setRestoreStatus: (v) => ui.status.push(v),
    setRestoreStep: () => {}, setSeedPhrase: () => {}, setMasterKeyTemp: () => {}, setIdentity: () => {},
    setShowRecovery: () => {}, setView: () => {}, unlockHistoryVault: async () => {},
    setRestoreWordIssues: (v) => { ui.wordIssues = v; },
    setRestoreChecksumWarning: (v) => { ui.checksumWarning = v; },
    setRestorePending: (v) => { ui.pending = v; },
    setRestoreMismatch: (v) => { ui.mismatch = v; },
    setRestoreError: (v) => { ui.error = v; },
    restoreReplaceWord: '',
    loadRecoveryWordlist: async () => ({ BIP39_WORDS, ACCEPTED_WORDS, isAcceptedWord }),
    ...helpers,
    SecretStore: { get: () => null }, setTimeout: () => {},
    CryptoEngine,
    localStorage: { getItem: () => null },
    window: { ghostlink: dev.bridge },
    ...overrides,
  };
  const fn = new Function(...Object.keys(env), `${restoreSrc}\nreturn validateAndDeriveKey;`)(...Object.values(env));
  await fn();
  if (confirm && ui.pending && ui.pending.nodeIdHex) await fn(ui.pending.nodeIdHex);
  return ui;
}

const phraseOf = (indices) => indices.map((i) => BIP39_WORDS[i]).join(' ');
const indicesOf = (words) => words.map((w) => BIP39_WORDS.indexOf(w));
const A_IDX = indicesOf(FIXTURE_A);
const B_IDX = indicesOf(FIXTURE_B);
const lastStatus = (ui) => ui.status.at(-1);
// Phrases as gmp-core made them before R1b: 12 uniform words, no checksum.
const legacyPhrase = () => Array.from({ length: 12 }, () => BIP39_WORDS[crypto.randomInt(2048)]).join(' ');

console.log('\n=== same device: a typo that is still a list word is refused ===');
{
  const stored = phraseOf(A_IDX);
  const storedBytes = Buffer.from(stored, 'utf8');
  const typoIdx = [...A_IDX]; typoIdx[5] = (typoIdx[5] + 1) % 2048;   // a real word, wrong one
  const dev = makeDevice({ storedSeed: stored });
  const ui = await runRestore(dev, phraseOf(typoIdx));
  ok(lastStatus(ui) === 'mismatch', `restore is refused as a different identity (status: ${JSON.stringify(lastStatus(ui))})`);
  ok(Buffer.from(dev.seed, 'utf8').equals(storedBytes), 'the stored seed is byte-identical afterwards');
  // Positive control through the same spy: the correct phrase on the same device starts the node.
  const control = makeDevice({ storedSeed: stored });
  await runRestore(control, stored);
  const controlStarts = control.starts.concat(control.legacyStarts);
  assertAbsent({
    channel: 'node-start spy',
    controlMessage: 'the spy records a start for the CORRECT phrase on the same device',
    control: () => (controlStarts.length > 0 && controlStarts.every((s) => s === stored) ? controlStarts.length : 0),
    absent: () => dev.starts.length === 0 && dev.legacyStarts.length === 0,
    message: `no node is started for the typo'd phrase (starts: ${dev.starts.length + dev.legacyStarts.length})`,
  });
  ok(dev.persists === 0, `nothing is persisted (persist calls: ${dev.persists})`);
}

console.log('\n=== a word that is not on the list is rejected, with suggestions ===');
{
  const words = phraseOf(B_IDX).split(' ');
  const original = words[3];
  let bent = original.slice(0, -1) + (original.endsWith('z') ? 'y' : 'z');
  if (isAcceptedWord(bent)) bent = original + 'xq';
  words[3] = bent;
  const dev = makeDevice();
  const ui = await runRestore(dev, words.join(' '));
  ok(lastStatus(ui) === 'badword', `status is "badword" (got ${JSON.stringify(lastStatus(ui))})`);
  const issue = (ui.wordIssues || []).find((x) => x.position === 4);
  ok(!!issue, 'the issue names word 4');
  ok(!!issue && Array.isArray(issue.suggestions) && issue.suggestions.includes(original), 'the suggestions include the intended list word');
  ok(dev.starts.length === 0 && dev.legacyStarts.length === 0 && dev.persists === 0, 'nothing started, nothing persisted');
}

console.log('\n=== legacy checksum-less phrase on a fresh device: accepted after confirmation ===');
{
  let legacy = null;
  for (let i = 0; i < 200 && !legacy; i++) {
    const p = legacyPhrase();
    if (!(await helpers.bip39ChecksumValid(p.split(' '), BIP39_WORDS)) || !helpersPresent) legacy = p;
  }
  const dev = makeDevice();
  const first = await runRestore(dev, legacy);
  ok(lastStatus(first) === 'confirm', `first pass asks the user to confirm (status: ${JSON.stringify(lastStatus(first))})`);
  ok(!!first.pending && /^GHOST-/.test(first.pending.ghostAddress || ''), 'the derived Ghost Address is shown for confirmation');
  ok(first.checksumWarning === true, 'the failed BIP-39 checksum is a warning');
  ok(dev.persists === 0 && dev.starts.length === 0 && dev.legacyStarts.length === 0, 'before confirmation: nothing persisted, no node started');
  const second = await runRestore(dev, legacy, { confirm: true });
  ok(dev.persists === 1 && dev.seed === legacy, 'after confirmation the phrase is persisted');
  ok(dev.starts.length === 1 && dev.starts[0] === legacy, 'after confirmation the node starts with that phrase');
  ok(!second.status.includes('badword') && !second.status.includes('error'), 'the legacy phrase is never rejected');
}

console.log('\n=== §9 R1 gate: 20/20 legacy (pre-R1b gmp-core) phrases accepted on a fresh device ===');
{
  let accepted = 0, checksumFailures = 0;
  for (let i = 0; i < 20; i++) {
    const p = legacyPhrase();
    const dev = makeDevice();
    const ui = await runRestore(dev, p, { confirm: true });
    if (ui.checksumWarning) checksumFailures++;
    if (dev.seed === p && dev.starts.length === 1 && dev.starts[0] === p && !ui.status.includes('badword')) accepted++;
  }
  ok(accepted === 20, `${accepted}/20 accepted after confirmation (${checksumFailures}/20 failed the BIP-39 checksum: warned, not rejected)`);
}

console.log('\n=== confirmation declined: nothing persisted, no node started ===');
{
  const dev = makeDevice();
  const ui = await runRestore(dev, phraseOf(A_IDX));
  let declined = false;
  if (declineSrc) {
    const decline = new Function('setRestorePending', 'setRestoreStatus', `${declineSrc}\nreturn declineRestore;`)(
      (v) => { ui.pending = v; }, (v) => ui.status.push(v));
    decline();
    declined = ui.pending === null;
  }
  ok(declined, 'declineRestore clears the pending confirmation');
  ok(dev.persists === 0 && dev.seed === null, 'nothing persisted');
  ok(dev.starts.length === 0 && dev.legacyStarts.length === 0, 'no node started');
  if (createRestoreGuard) {
    const res = await dev.bridge.gmp.restore(phraseOf(A_IDX), null);
    ok(res.status === 'confirm' && dev.persists === 0 && dev.starts.length === 0,
      'main refuses to persist an unconfirmed phrase even if the renderer asks directly');
    const wrong = await dev.bridge.gmp.restore(phraseOf(A_IDX), 'f'.repeat(128));
    ok(wrong.status === 'confirm' && dev.persists === 0, 'a confirmation for a different NodeID does not count');
  } else {
    ok(false, 'main refuses to persist an unconfirmed phrase (restore guard missing)');
    ok(false, 'a confirmation for a different NodeID does not count (restore guard missing)');
  }
}

console.log('\n=== persist failure: the node is not started ===');
{
  const dev = makeDevice({ persistFails: true });
  const ui = await runRestore(dev, phraseOf(B_IDX), { confirm: true });
  ok(dev.starts.length === 0 && dev.legacyStarts.length === 0, `no node started (starts: ${dev.starts.length + dev.legacyStarts.length})`);
  ok(lastStatus(ui) === 'restorefailed' && /secure storage/.test(ui.error || ''), `the user is told why (status: ${JSON.stringify(lastStatus(ui))})`);
}

// ── Unreadable seed blob (seed-store.js getSeed -> null on a blob that won't open)
const { createSeedStore, SEED_STORE_KEY } = require(path.join(root, 'electron', 'src', 'seed-store.js'));
// A keyring whose sealed values carry its tag; a blob sealed by another keyring won't open.
const keyring = (tag) => ({
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (s) => Buffer.from(`${tag}:${s}`, 'utf8'),
  decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith(`${tag}:`)) throw new Error('wrong keyring'); return t.slice(tag.length + 1); },
});
const sealedBy = (tag, phrase) => keyring(tag).encryptString(phrase).toString('base64');
/** A device wired as main.js wires it: real seed-store + real restore guard. */
function makeKeyringDevice({ blob = null, failAside = false } = {}) {
  const map = new Map(blob ? [[SEED_STORE_KEY, blob]] : []);
  const store = {
    get: (k) => map.get(k),
    set: (k, v) => { if (failAside && k !== SEED_STORE_KEY) throw new Error('disk full (test)'); map.set(k, v); },
    delete: (k) => map.delete(k),
  };
  const seedStore = createSeedStore({ safeStorage: keyring('k2'), store });
  const dev = { map, starts: [], legacyStarts: [], persists: 0 };
  const guard = createRestoreGuard ? createRestoreGuard({
    deriveIdentity,
    getStoredSeed: () => seedStore.getSeed(),
    getStoredSeedState: seedStore.readState ? () => seedStore.readState() : undefined,
    moveSeedAside: seedStore.moveAside ? () => seedStore.moveAside() : undefined,
    restoreSeedAside: seedStore.restoreAside ? (k) => seedStore.restoreAside(k) : undefined,
    setStoredSeed: (s) => { dev.persists++; return seedStore.setSeed(s); },
    startNode: async (s) => { dev.starts.push(s); },
  }) : null;
  dev.seedStore = seedStore;
  dev.bridge = { isElectron: true, gmp: {
    start: async (s) => { dev.legacyStarts.push(s); try { seedStore.setSeed(s); } catch { /* session-only */ } },
    restore: async (phrase, confirmedNodeId, replaceConfirmation) => {
      if (!guard) throw new Error('restore guard missing');
      return guard.restore(phrase, { confirmedNodeId, replaceConfirmation });
    },
  } };
  return dev;
}
const asideKeys = (dev) => [...dev.map.keys()].filter((k) => k !== SEED_STORE_KEY);
const startCount = (dev) => dev.starts.length + dev.legacyStarts.length;

console.log('\n=== unreadable seed blob: normal restore is refused, blob untouched ===');
{
  const blob = sealedBy('k1', phraseOf(A_IDX));          // sealed under a keyring this device no longer has
  const dev = makeKeyringDevice({ blob });
  const ui = await runRestore(dev, phraseOf(A_IDX), { confirm: true });
  ok(lastStatus(ui) === 'unreadable', `status is "unreadable", not a fresh-device confirmation (got ${JSON.stringify(lastStatus(ui))})`);
  // Even a renderer that skips straight to a NodeID confirmation is refused.
  const { nodeIdHex } = await deriveIdentity(phraseOf(A_IDX));
  const direct = await dev.bridge.gmp.restore(phraseOf(A_IDX), nodeIdHex, null).catch((e) => ({ status: e.message }));
  ok(direct.status === 'unreadable', `main refuses a confirmed restore without the replace step (got ${JSON.stringify(direct.status)})`);
  const wrongWord = await dev.bridge.gmp.restore(phraseOf(A_IDX), nodeIdHex, 'replace please').catch((e) => ({ status: e.message }));
  ok(wrongWord.status === 'unreadable', 'a wrong confirmation word does not count');
  ok(dev.map.get(SEED_STORE_KEY) === blob && asideKeys(dev).length === 0, 'the blob is byte-identical and nothing was moved');
  ok(dev.persists === 0 && startCount(dev) === 0, `nothing persisted, no node started (persists ${dev.persists}, starts ${startCount(dev)})`);
  // The new-identity path (gmp-start) must not overwrite it either.
  await dev.bridge.gmp.start(phraseOf(B_IDX));
  ok(dev.map.get(SEED_STORE_KEY) === blob, 'gmp-start (new identity) does not overwrite the unreadable blob');
}

console.log('\n=== positive control: a readable blob still restores normally ===');
{
  const dev = makeKeyringDevice({ blob: sealedBy('k2', phraseOf(A_IDX)) });
  const ui = await runRestore(dev, phraseOf(A_IDX));
  ok(lastStatus(ui) !== 'unreadable' && dev.starts.length === 1 && dev.starts[0] === phraseOf(A_IDX),
    `the correct phrase starts the node on a readable device (starts ${dev.starts.length}, status ${JSON.stringify(lastStatus(ui))})`);
}

console.log('\n=== replace confirmed: old blob moved aside, new seed stored ===');
{
  const blob = sealedBy('k1', phraseOf(A_IDX));
  const dev = makeKeyringDevice({ blob });
  const ui = await runRestore(dev, phraseOf(B_IDX), { confirm: true, overrides: { restoreReplaceWord: 'REPLACE' } });
  const aside = asideKeys(dev);
  ok(aside.length === 1 && dev.map.get(aside[0]) === blob, `the old blob exists under a new name, byte-identical (${JSON.stringify(aside)})`);
  ok(aside.length === 1 && aside[0].startsWith(SEED_STORE_KEY) && /\d{8}T\d{6}/.test(aside[0]) && !aside[0].includes('.'),
    'the new name is the old key + a timestamp, with no "." (electron-store reads dots as nesting)');
  ok(dev.seedStore.getSeed() === phraseOf(B_IDX), 'the new seed is stored and reads back');
  ok(dev.starts.length === 1 && dev.starts[0] === phraseOf(B_IDX), 'the node starts with the new phrase');
  ok(ui.status.includes('confirm'), 'the derived Ghost Address was still confirmed first');
}

console.log('\n=== replace: moving aside fails -> nothing stored, no node started ===');
{
  const blob = sealedBy('k1', phraseOf(A_IDX));
  const dev = makeKeyringDevice({ blob, failAside: true });
  const ui = await runRestore(dev, phraseOf(B_IDX), { confirm: true, overrides: { restoreReplaceWord: 'REPLACE' } });
  ok(dev.map.get(SEED_STORE_KEY) === blob && asideKeys(dev).length === 0, 'the blob is byte-identical and nothing new was stored');
  ok(startCount(dev) === 0, `no node started (starts ${startCount(dev)})`);
  ok(lastStatus(ui) === 'restorefailed', `the user is told (status ${JSON.stringify(lastStatus(ui))})`);
}

console.log('\n=== browser/CLI build: a typo is never handed to the bridge ===');
{
  // No Electron, so no restore guard: the connector sends window.seedPhrase
  // (set by setSeedPhrase) to the bridge, which starts a node for any seed it
  // is given (node-registry.ts acquire). The phrase may only be set once the
  // stored identity's key unwraps under it.
  const { keyPair } = await CryptoEngine.generateKeyPair();
  const wrapped = await CryptoEngine.wrapPrivKey(keyPair.privateKey, await CryptoEngine.deriveKeyFromSeed(phraseOf(A_IDX).split(' ')));
  const savedIdentity = JSON.stringify({ name: 't', pubKeyHex: '00', fingerprint: 'x', wrappedPrivKey: wrapped });
  const browserRun = async (phrase) => {
    const handed = [];
    const ui = await runRestore({ bridge: undefined }, phrase, { overrides: {
      window: {},
      localStorage: { getItem: (k) => (k === 'gl_identity' ? savedIdentity : null) },
      setSeedPhrase: (w) => handed.push(Array.isArray(w) ? w.join(' ') : w),
    } });
    return { ui, handed };
  };
  const typoIdx = [...A_IDX]; typoIdx[7] = (typoIdx[7] + 1) % 2048;
  const typo = await browserRun(phraseOf(typoIdx));
  const control = await browserRun(phraseOf(A_IDX));
  ok(lastStatus(control.ui) === 'ok', `control: the correct phrase restores (status: ${JSON.stringify(lastStatus(control.ui))})`);
  assertAbsent({
    channel: 'setSeedPhrase spy (feeds the bridge start message)',
    controlMessage: 'the spy records the CORRECT phrase being handed over',
    control: () => control.handed.filter((s) => s === phraseOf(A_IDX)).length,
    absent: () => typo.handed.length === 0,
    message: `the typo'd phrase is never set for the bridge (set ${typo.handed.length} time(s))`,
  });
}

console.log('\n=== helpers ===');
{
  ok(helpersPresent, 'closestWords / unknownPhraseWords / bip39ChecksumValid are top-level in index.html');
  ok(await helpers.bip39ChecksumValid(phraseOf(A_IDX).split(' '), BIP39_WORDS) === (await helpers.bip39ChecksumValid(FIXTURE_A, BIP39_WORDS)), 'checksum helper is deterministic');
  ok(await helpers.bip39ChecksumValid(phraseOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]).split(' '), BIP39_WORDS) === true,
    'the BIP-39 all-zero test vector passes the checksum');
  ok(await helpers.bip39ChecksumValid(phraseOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).split(' '), BIP39_WORDS) === false,
    'word 0 twelve times fails the checksum');
}

assert.ok(true);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
