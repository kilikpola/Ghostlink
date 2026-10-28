/**
 * A peer's claimed fingerprint must be the truncated SHA-256 of the key it
 * arrives with (index.html quickPeerClaimAcceptable).
 *
 * Moved from test/mesh-handshake.test.js when the unloaded P2PConnector was
 * removed (G0): those assertions pinned the same rule on P2PConnector's dead
 * Ghost Mesh handshake. This runs the LIVE check, extracted from index.html:
 * quickPeerClaimAcceptable, fingerprintFromPublicKey and CryptoEngine are the
 * real code; only PeerCache and the connector are stubbed.
 *
 * Run: node test/quick-peer-claim.test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

function slice(startText, endText) {
  const s = html.indexOf(startText);
  if (s < 0) throw new Error(`index.html: ${startText} not found`);
  return html.slice(s, html.indexOf(endText, s) + endText.length);
}
const cryptoEngineSrc = slice('const CryptoEngine = {', '\n};');
const fingerprintSrc = slice('async function fingerprintFromPublicKey(', '\n}');
const pinnableSrc = slice('const PINNABLE_KEY =', ';');
const claimSrc = slice('const quickPeerClaimAcceptable = async', '\n  };');

const subtle = globalThis.crypto.subtle;
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const newKeyHex = async () => {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return hex(await subtle.exportKey('raw', kp.publicKey));
};

function build({ pinned = {}, connected = [] } = {}) {
  const PeerCache = { getPublicKey: (fp) => pinned[fp] || null };
  const fn = new Function('PeerCache', 'window',
    `${cryptoEngineSrc}\n${fingerprintSrc}\n${pinnableSrc}\n${claimSrc}\nreturn { quickPeerClaimAcceptable, fingerprintFromPublicKey };`)(
    PeerCache, {});
  const conn = { isConnected: (fp) => connected.includes(fp) };
  return { ...fn, conn };
}

const them = await newKeyHex();
const other = await newKeyHex();
const { quickPeerClaimAcceptable, fingerprintFromPublicKey, conn } = build();
const fpThem = await fingerprintFromPublicKey(them);
const fpOther = await fingerprintFromPublicKey(other);

console.log('\n=== a claim is accepted only for the fingerprint its key is entitled to ===');
ok(await quickPeerClaimAcceptable(conn, { pubKeyHex: them, fingerprint: fpThem }) === true,
  'positive control: an honest claim (fingerprint of its own key) is accepted');
ok(await quickPeerClaimAcceptable(conn, { pubKeyHex: them, fingerprint: fpOther }) === false,
  'a key announced under someone else\'s fingerprint is refused');

console.log('\n=== a malformed key is refused even when the fingerprint matches it ===');
{
  const bad = 'zz' + them.slice(2);                       // not hex, not a P-256 point encoding
  const fpBad = await fingerprintFromPublicKey(bad);      // the fingerprint it would be "entitled" to
  ok(await quickPeerClaimAcceptable(conn, { pubKeyHex: bad, fingerprint: fpBad }) === false,
    'an unparseable key that claims a matching fingerprint is still refused');
  const short = them.slice(0, 66);                        // compressed-length, not the pinnable form
  ok(await quickPeerClaimAcceptable(conn, { pubKeyHex: short, fingerprint: await fingerprintFromPublicKey(short) }) === false,
    'a key of the wrong length is refused');
  ok(await quickPeerClaimAcceptable(conn, { fingerprint: fpThem }) === false, 'a claim with no key is refused');
}

console.log('\n=== a claim cannot take over a pinned or connected peer ===');
{
  const pinnedOther = build({ pinned: { [fpThem]: other } });
  ok(await pinnedOther.quickPeerClaimAcceptable(pinnedOther.conn, { pubKeyHex: them, fingerprint: fpThem }) === false,
    'a fingerprint already pinned to a different key is refused');
  const live = build({ connected: [fpThem] });
  ok(await live.quickPeerClaimAcceptable(live.conn, { pubKeyHex: them, fingerprint: fpThem }) === false,
    'an already-connected peer is not taken over');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
