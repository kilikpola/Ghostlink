/**
 * Invite signatures are ECDSA P-256 only (B2-1).
 *
 * qr-invite.js used to fall back to an HMAC keyed with the PUBLIC key when
 * ECDSA signing failed, and verifyInvite accepted that HMAC. Anyone holding a
 * public key could therefore forge an invite "signed" by it.
 * Run: node test/qr-invite-signature.test.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
createRequire(import.meta.url)(path.join(here, '..', 'src', 'utils', 'qr-invite.js'));
const { QRInvite } = globalThis;
const { subtle } = globalThis.crypto;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const hex = (buf) => Buffer.from(new Uint8Array(buf)).toString('hex');
const enc = (s) => new TextEncoder().encode(s);

// The app's identity key: ECDH P-256, extractable (index.html CryptoEngine.generateKeyPair).
async function appIdentity(name, extractable = true) {
  const keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveKey']);
  const publicKeyHex = hex(await subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, publicKeyHex, name };
}

console.log('\n=== positive control: a genuinely signed invite verifies ===');
const alice = await appIdentity('alice');
const genuine = await new QRInvite(alice).generateInvite();
ok((await QRInvite.verifyInvite(genuine)).valid === true, 'an invite signed with the identity key (ECDH key re-imported as ECDSA) verifies');
ok(genuine.signature.length === 128, 'its signature is a 64-byte raw ECDSA P-256 signature');

const tampered = { ...genuine, name: 'mallory' };
ok((await QRInvite.verifyInvite(tampered)).valid === false, 'changing a signed field breaks a genuine signature');

console.log('\n=== forgery from a public key alone is rejected ===');
// Everything the attacker uses is public: alice's public key from any invite.
const code = 'GL-0123ABCD-4567EF01-89ABCDEF-01234567';
const timestamp = Date.now();
const payload = `${code}|${alice.publicKeyHex}|alice|${timestamp}`;
const hmacKey = await subtle.importKey('raw', enc(alice.publicKeyHex.slice(0, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const forged = { code, publicKey: alice.publicKeyHex, name: 'alice', timestamp, signature: hex(await subtle.sign('HMAC', hmacKey, enc(payload))) };
const verdict = await QRInvite.verifyInvite(forged);
ok(verdict.valid === false, `an HMAC "signature" keyed with the public key is rejected (got ${JSON.stringify(verdict)})`);

console.log('\n=== signing never falls back: it fails with a named error ===');
async function signError(identity) {
  try {
    const invite = await new QRInvite(identity).generateInvite();
    return { returned: invite.signature };
  } catch (e) {
    return { name: e.name, message: e.message };
  }
}
const noKey = await signError({ publicKeyHex: alice.publicKeyHex, name: 'alice', keyPair: null });
ok(noKey.name === 'InviteSigningError', `no private key -> InviteSigningError (got ${JSON.stringify(noKey)})`);
const sealed = await signError(await appIdentity('bob', false));
ok(sealed.name === 'InviteSigningError', `non-extractable key -> InviteSigningError (got ${JSON.stringify(sealed)})`);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
