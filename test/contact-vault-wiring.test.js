'use strict';
/**
 * The renderer contact stores (gl_peer_cache, gl_gmp_known_peers,
 * gl_gmp_blocked_peers) must go through the SecretStore seam so that, when a
 * contact vault is installed on window.__contactVault, they are SEALED at rest
 * exactly as mobile seals @ghostlink/peers. This extracts the real code out of
 * index.html (same mechanism as mesh-connector.test.js) and drives it with a
 * real vault built from vendor-src/contact-vault.js.
 *
 * A/B: before the SecretStore seam existed, PeerCache.save wrote plaintext JSON,
 * so `isSealed(on-disk)` was false and this suite failed (and the extraction of
 * `SecretStore` threw "index.html no longer declares"). After the seam, with a
 * vault installed, the on-disk value is sealed and carries no plaintext.
 *
 * Run: node test/contact-vault-wiring.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createContactVault, isSealed } = require('../vendor-src/contact-vault.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extract(name) {
  const pattern = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm');
  const match = pattern.exec(html);
  if (!match) throw new Error(`index.html no longer declares: ${name}`);
  const start = match.index;
  const firstLineEnd = html.indexOf('\n', start);
  const firstLine = html.slice(start, firstLineEnd);
  if (firstLine.startsWith('const') && firstLine.trimEnd().endsWith(';')) return firstLine;
  const close = html.indexOf('\n}', start);
  if (close === -1) throw new Error(`Could not find the end of: ${name}`);
  const semicolon = html[close + 2] === ';' ? 3 : 2;
  return html.slice(start, close + semicolon);
}

const SOURCE = [
  'SecretStore',
  'PeerCache',
  'NODE_ID_PATTERN', 'isNodeIdHex',
  'KNOWN_PEERS_KEY', 'BLOCKED_PEERS_KEY', 'KNOWN_PEERS_MAX',
  'loadBlockedPeers', 'setPeerBlocked', 'loadKnownPeers', 'rememberKnownPeer', 'forgetKnownPeer',
].map(extract).join('\n\n');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ ${msg}`); } }

// A fresh renderer-like scope per scenario, with an injectable window.__contactVault.
function makeScope(vault) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const window = { location: { protocol: 'http:', search: '', hostname: 'localhost' } };
  if (vault !== undefined) window.__contactVault = vault;
  const scope = new Function('window', 'localStorage', `
    ${SOURCE}
    return { SecretStore, PeerCache, loadKnownPeers, rememberKnownPeer, setPeerBlocked, loadBlockedPeers, forgetKnownPeer, KNOWN_PEERS_KEY, BLOCKED_PEERS_KEY };
  `)(window, localStorage);
  return { scope, store, localStorage };
}

const KEY = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
const vaultOver = (localStorage, key) => createContactVault({ storage: localStorage, getKey: () => key });

const NODE_A = 'a1'.repeat(64);

console.log('\n=== with a vault installed, the contact stores are SEALED at rest ===');
{
  const { scope, store, localStorage } = makeScope(/* set below */ undefined);
  // Install the vault AFTER the scope exists so it shares the same localStorage.
  const vault = vaultOver(localStorage, KEY);
  scope.SecretStore; // sanity: seam exists
  // Re-make the scope with the vault bound to the same backing store.
  const store2 = new Map();
  const ls2 = { getItem: (k) => (store2.has(k) ? store2.get(k) : null), setItem: (k, v) => store2.set(k, String(v)), removeItem: (k) => store2.delete(k) };
  const win2 = { location: {}, __contactVault: vaultOver(ls2, KEY) };
  const s2 = new Function('window', 'localStorage', `${SOURCE}\n return { PeerCache, rememberKnownPeer, setPeerBlocked, loadKnownPeers, loadBlockedPeers, KNOWN_PEERS_KEY, BLOCKED_PEERS_KEY };`)(win2, ls2);

  s2.PeerCache.addPeer(NODE_A, { name: 'Alice', publicKeyHex: 'bb', pinnedAddress: 'GHOST-A4F-0Y6-YA8' });
  const onDisk = ls2.getItem('gl_peer_cache');
  ok(isSealed(onDisk), 'gl_peer_cache is sealed on disk (gl-sealed:v1: prefix)');
  ok(!onDisk.includes('Alice') && !onDisk.includes('GHOST-A4F'), 'the social-graph plaintext is not present on disk');
  ok(s2.PeerCache.getPeer(NODE_A).name === 'Alice', 'PeerCache reads the contact back through the vault');
  ok(s2.PeerCache.getPeer(NODE_A).pinnedAddress === 'GHOST-A4F-0Y6-YA8', 'the Phase-1c pinnedAddress field survives sealing');

  s2.rememberKnownPeer(NODE_A, { name: 'Alice' });
  ok(isSealed(ls2.getItem(s2.KNOWN_PEERS_KEY)), 'gl_gmp_known_peers is sealed on disk');
  ok(s2.loadKnownPeers().some((p) => p.nodeId === NODE_A), 'known peers read back through the vault');

  s2.setPeerBlocked(NODE_A, true);
  ok(isSealed(ls2.getItem(s2.BLOCKED_PEERS_KEY)), 'gl_gmp_blocked_peers is sealed on disk');
}

console.log('\n=== migration: a store written by the CURRENT (plaintext) build ===');
{
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  // Exactly what today's build writes: plaintext JSON.
  store.set('gl_peer_cache', JSON.stringify({ [NODE_A]: { name: 'Bob', pinnedAddress: 'GHOST-B22-000-001', lastSeen: 1 } }));
  const win = { location: {}, __contactVault: vaultOver(ls, KEY) };
  const s = new Function('window', 'localStorage', `${SOURCE}\n return { PeerCache };`)(win, ls);
  ok(s.PeerCache.getPeer(NODE_A).name === 'Bob', 'a plaintext contact store still reads after the vault is installed');
  ok(isSealed(ls.getItem('gl_peer_cache')), 'reading migrated the plaintext store to sealed in place');
  ok(JSON.parse(require('../vendor-src/contact-vault.js').open(KEY, 'gl_peer_cache', ls.getItem('gl_peer_cache')))[NODE_A].pinnedAddress === 'GHOST-B22-000-001', 'pinnedAddress carried through migration');
}

console.log('\n=== Item 2 A/B: inside Electron with NO usable vault -> FAIL CLOSED (session-only), not plaintext ===');
{
  // Electron is signalled by window.ghostlink.isElectron; no vault is installed
  // (unavailable backend, or pre-boot). OLD behaviour wrote plaintext to disk;
  // NEW behaviour keeps contacts in memory only and fires the banner hook.
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  let banner = null;
  const win = { location: {}, ghostlink: { isElectron: true }, __onSecretStoreUnavailable: (k) => { banner = k; } };
  const s = new Function('window', 'localStorage', `${SOURCE}\n return { PeerCache, SecretStore };`)(win, ls);
  s.PeerCache.addPeer(NODE_A, { name: 'Mallory' });
  ok(ls.getItem('gl_peer_cache') == null, 'NEW: nothing is written to localStorage in Electron without a vault (OLD wrote plaintext here)');
  ok(!JSON.stringify([...store]).includes('Mallory'), 'the contact name never reached disk in any form');
  ok(s.PeerCache.getPeer(NODE_A) && s.PeerCache.getPeer(NODE_A).name === 'Mallory', 'contacts still work this session (in memory)');
  ok(banner === 'gl_peer_cache', 'the unavailable write fired the banner hook (window.__onSecretStoreUnavailable)');
}

console.log('\n=== back-compat: NON-Electron (web/test), no vault -> explicit plaintext path ===');
{
  const { scope, store, localStorage } = makeScope(/* no vault, no ghostlink */);
  scope.PeerCache.addPeer(NODE_A, { name: 'Carol' });
  const onDisk = localStorage.getItem('gl_peer_cache');
  ok(!isSealed(onDisk) && onDisk.includes('Carol'), 'with no vault AND not Electron, the store is plaintext (unchanged web/test behavior)');
  ok(scope.PeerCache.getPeer(NODE_A).name === 'Carol', 'and reads back');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
