/**
 * The Ghost Address is a name two people exchange. If mobile derives it even
 * slightly differently from gmp-core, two clients compute two different names
 * for the same identity and nobody can reach anybody. So this checks mobile's
 * output against the *real* gmp-core implementation, not against a fixture.
 */
import {webcrypto} from 'crypto';
import fs from 'fs';
import {FIXTURE_B} from '../../test/helpers/fixture-phrases.mjs';
Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true, writable: true});

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}`)); };

// Repo root, relative to this file — a hardcoded absolute path only ever
// worked on one developer's machine.
const ROOT = new URL('../../', import.meta.url);

// The reference: gmp-core, exactly as the desktop and web app use it.
const {ghostAddressFromNodeId: refAddress, normalizeGhostAddress: refNormalize} =
  await import(new URL('gmp-core/dist/ghost-address.js', ROOT).href);
const {deriveIdentityFromSeedPhrase} = await import(new URL('gmp-core/dist/identity.js', ROOT).href);

// Mobile's port, with its RN-only import stubbed.
const prep = (rel, out, reps = []) => {
  let src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const [a, b] of reps) src = src.split(a).join(b);
  const u = new URL(out, import.meta.url);
  fs.writeFileSync(u, src);
  return u;
};
const gaPath = prep('../src/utils/ghost-address.js', './.ga.mjs');
const cryptoPath = prep('../src/utils/crypto.js', './.ga-crypto.mjs', [
  ["import * as Keychain from 'react-native-keychain';", 'const Keychain = {};'],
  ["import {NativeModules} from 'react-native';", 'const NativeModules = {};'],
  ["from './wordlist'", "from '../src/utils/wordlist.js'"],
  ["from './ghost-address'", "from './.ga.mjs'"],
]);
const mobileGA = await import(gaPath.href);
const {CryptoEngine, generateSeedPhrase} = await import(cryptoPath.href);

console.log('\n[1] Address encoding matches gmp-core');
{
  // Random NodeIDs, plus edge values.
  const samples = [
    '0'.repeat(128),
    'f'.repeat(128),
    ...Array.from({length: 40}, () =>
      Array.from(webcrypto.getRandomValues(new Uint8Array(64)))
        .map(b => b.toString(16).padStart(2, '0')).join('')),
  ];
  let bad = 0;
  for (const id of samples) {
    if (mobileGA.ghostAddressFromNodeId(id) !== refAddress(id)) bad++;
  }
  ok(`${samples.length} NodeIDs encode identically to gmp-core (${bad} mismatches)`, bad === 0);
  ok('canonical shape', mobileGA.GHOST_ADDRESS_PATTERN.test(mobileGA.ghostAddressFromNodeId(samples[5])));
}

console.log('\n[2] Normalisation matches gmp-core');
{
  const addr = refAddress('a'.repeat(128));
  const body = addr.replace(/^GHOST-/, '').replace(/-/g, '');
  const variants = [
    addr, addr.toLowerCase(), body, body.toLowerCase(),
    `ghost ${body}`, `GHOST_${body}`, addr.replace(/-/g, ' '),
    `  ${addr}  `, body.replace(/0/g, 'O'), body.replace(/1/g, 'I'),
  ];
  let bad = 0;
  for (const v of variants) {
    if (mobileGA.normalizeGhostAddress(v) !== refNormalize(v)) { bad++; console.log(`       differs on ${JSON.stringify(v)}`); }
  }
  ok(`${variants.length} input spellings normalise identically (${bad} mismatches)`, bad === 0);
  for (const junk of ['', 'hello', 'GHOST-1', 'GL-ABCD', null, undefined, 'GHOST-AAA-BBB-CCCC']) {
    ok(`rejects ${JSON.stringify(junk)}`, mobileGA.normalizeGhostAddress(junk) === refNormalize(junk));
  }
}

console.log('\n[3] Same phrase → same address as the desktop/web client');
{
  const phrases = [
    [...FIXTURE_B],
    generateSeedPhrase(),
    generateSeedPhrase(),
  ];
  for (const words of phrases) {
    const mine = await CryptoEngine.deriveGhostIdentity(words);
    const ref = await deriveIdentityFromSeedPhrase(words.join(' '));
    ok(`nodeId matches gmp-core (${mine.ghostAddress})`, mine.nodeIdHex === ref.nodeIdHex);
    ok('x25519 public key matches', mine.staticPubKeyHex === ref.staticPubKeyHex);
    ok('address matches what the other clients show', mine.ghostAddress === refAddress(ref.nodeIdHex));
  }
}

console.log('\n[4] The address is stable and phrase-specific');
{
  const words = generateSeedPhrase();
  const a = await CryptoEngine.deriveGhostIdentity(words);
  const b = await CryptoEngine.deriveGhostIdentity([...words]);
  ok('same phrase derives the same address twice', a.ghostAddress === b.ghostAddress);
  const other = await CryptoEngine.deriveGhostIdentity(generateSeedPhrase());
  ok('a different phrase gives a different address', other.ghostAddress !== a.ghostAddress);
  ok('round-trips through normalisation', mobileGA.normalizeGhostAddress(a.ghostAddress) === a.ghostAddress);
  ok('address does not leak the phrase', !words.some(w => w.length > 3 && a.ghostAddress.includes(w.toUpperCase())));
}

for (const f of [gaPath, cryptoPath]) fs.unlinkSync(f);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
