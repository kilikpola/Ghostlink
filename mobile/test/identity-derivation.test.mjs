/**
 * A recovery phrase must recover the messaging keypair, not just the address.
 *
 * react-native-keychain is stubbed; the stub is generated from the real source
 * each run.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {FIXTURE_A} from '../../test/helpers/fixture-phrases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = path.join(here, '..', 'src', 'utils', 'crypto.js');

const stubbed = fs.readFileSync(real, 'utf8')
  .replace(/import \* as Keychain from 'react-native-keychain';/,
           'const Keychain = {setGenericPassword: async () => true, getGenericPassword: async () => false, resetGenericPassword: async () => true, getSupportedBiometryType: async () => null, ACCESS_CONTROL: {BIOMETRY_ANY_OR_DEVICE_PASSCODE: 0}};')
  .replace(/import \{NativeModules\} from 'react-native';/,
           'const NativeModules = {};')  // no native PBKDF2 under Node: exercises the JS fallback
  .replace(/from '\.\/wordlist'/, `from '${path.join(here, '..', 'src', 'utils', 'wordlist.js')}'`)
  .replace(/from '\.\/ghost-address'/, `from '${path.join(here, '..', 'src', 'utils', 'ghost-address.js')}'`);

// Written inside the project so its @noble imports still resolve, then
// removed once loaded.
const tmp = path.join(here, '..', `.crypto-under-test-${process.pid}.mjs`);
fs.writeFileSync(tmp, stubbed);
let CryptoEngine;
try {
  CryptoEngine = (await import(`file://${tmp}`)).default;
} finally {
  fs.rmSync(tmp, {force: true});
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

const PHRASE = [...FIXTURE_A];
const OTHER  = [...PHRASE.slice(0, 11), 'zebra'];

const a = await CryptoEngine.deriveIdentityKeyPair(PHRASE);
const b = await CryptoEngine.deriveIdentityKeyPair(PHRASE);
const c = await CryptoEngine.deriveIdentityKeyPair(OTHER);

ok(a.publicKeyHex === b.publicKeyHex,
   'The same phrase derives the same messaging key, so restoring recovers the identity');
ok(a.publicKeyHex !== c.publicKeyHex,
   'A different phrase derives a different key');
ok(a.publicKeyHex.length === 130 && a.publicKeyHex.startsWith('04'),
   'The key is an uncompressed P-256 public key, the form the web client reads');

// Joining the words must not matter to the result.
const joined = await CryptoEngine.deriveIdentityKeyPair(PHRASE.join(' '));
ok(joined.publicKeyHex === a.publicKeyHex, 'A phrase given as a string derives identically to an array');

// The address and the messaging key must come from independent derivations:
// learning one must not lead to the other.
const ghost = await CryptoEngine.deriveGhostIdentity(PHRASE);
ok(ghost.staticPubKeyHex !== a.publicKeyHex, 'The mesh key and the messaging key are different keys');
ok(typeof ghost.ghostAddress === 'string' && ghost.ghostAddress.startsWith('GHOST-'),
   'The same phrase still derives the Ghost Address');

const ghost2 = await CryptoEngine.deriveGhostIdentity(PHRASE);
ok(ghost.ghostAddress === ghost2.ghostAddress, 'The Ghost Address is stable across derivations');

// The whole point, stated as the user would: restore reproduces the identity.
const restored = {
  publicKeyHex: (await CryptoEngine.deriveIdentityKeyPair(PHRASE)).publicKeyHex,
  ghostAddress: (await CryptoEngine.deriveGhostIdentity(PHRASE)).ghostAddress,
};
ok(restored.publicKeyHex === a.publicKeyHex && restored.ghostAddress === ghost.ghostAddress,
   'Restoring from the phrase reproduces both the Ghost Address and the messaging key');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
