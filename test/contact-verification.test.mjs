/**
 * Contact verification over FULL NodeIDs (identity-v2.md §5, D9; task R3).
 *
 * Runs the real code: top-level helpers and component functions extracted
 * from index.html, the vendored safety-number module the renderer imports
 * (vendor/safety-number.js, built from gmp-core/src/safety-number.ts), and
 * gmp-core's identity derivation. Every negative has a positive control.
 *
 * Run: node test/contact-verification.test.mjs
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';
import { FIXTURE_A, FIXTURE_B } from './helpers/fixture-phrases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

// ── Extraction (same rule as test/mesh-connector.test.js) ─────────────────
function extract(name) {
  const m = new RegExp(`^(?:const|function|class|async function) ${name}\\b`, 'm').exec(html);
  if (!m) return null;
  const first = html.slice(m.index, html.indexOf('\n', m.index));
  // A one-line const, optionally followed by a // comment.
  if (/^const [^\n]*;\s*(\/\/.*)?$/.test(first)) return first;
  const close = html.indexOf('\n}', m.index);
  return html.slice(m.index, close + (html[close + 2] === ';' ? 3 : 2));
}
function component(startText, endText = '\n  };') {
  const s = html.indexOf(startText);
  return s < 0 ? null : html.slice(s, html.indexOf(endText, s) + endText.length);
}
/** Evaluate `src` with free names resolved from `stubs`; unknown free names become recording no-ops. */
function evaluate(src, stubs, ret) {
  const unknown = new Set();
  const scope = new Proxy(stubs, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k in t ? t[k] : (k === Symbol.unscopables ? undefined : (unknown.add(k), () => {}))),
  });
  const v = new Function('scope', `with (scope) { ${src}\n return ${ret}; }`)(scope);
  return { value: v, unknown };
}

const { deriveIdentityFromSeedPhrase } = await import(path.join(root, 'gmp-core', 'dist', 'identity.js'));
const A = (await deriveIdentityFromSeedPhrase(FIXTURE_A.join(' '))).nodeIdHex;
const B = (await deriveIdentityFromSeedPhrase(FIXTURE_B.join(' '))).nodeIdHex;
const PINNED_AB = '632334512811262621821109808809672846577166907067971366457881';
const KEY = '04' + 'ab'.repeat(64);
const KEY2 = '04' + 'cd'.repeat(64);
const FP = 'A1B2C3D4E5F60718'; // a Quick-Connect peer id: a 16-hex key fingerprint

console.log('\n=== the renderer runs the same safety-number code as gmp-core ===');
{
  const vendorPath = path.join(root, 'vendor', 'safety-number.js');
  const have = fs.existsSync(vendorPath);
  ok(have, 'vendor/safety-number.js exists');
  ok(/"@ghostlink\/safety-number":\s*"\.\/vendor\/safety-number\.js"/.test(html), 'index.html maps @ghostlink/safety-number to it');
  if (have) {
    const esbuild = require('esbuild');
    const built = await esbuild.build({ entryPoints: [path.join(root, 'gmp-core', 'src', 'safety-number.ts')], bundle: true, format: 'esm',
      target: 'es2020', minify: true, platform: 'browser', write: false });
    ok(built.outputFiles[0].text === fs.readFileSync(vendorPath, 'utf8'), 'vendor/safety-number.js is byte-identical to a fresh build of gmp-core/src/safety-number.ts (npm run build:vendor)');
    const sn = await import(vendorPath);
    ok(sn.safetyNumber(A, B) === PINNED_AB && sn.safetyNumber(B, A) === PINNED_AB, `the vendored module gives the pinned FIXTURE_A/B number (${sn.formatSafetyNumber(PINNED_AB).slice(0, 11)}…), both orders`);
  }
}

console.log('\n=== the old P-256 ceremony is gone ===');
{
  const OLD = `const generateSafetyNumber = async (peerPubKeyHex, myPubKeyHex) => {
    const sorted = [String(peerPubKeyHex), String(myPubKeyHex)].sort();
    const material = new TextEncoder().encode('ghostlink-safety-number-v1|' + sorted.join('|'));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));`;
  const oldCeremony = /ghostlink-safety-number-v1|generateSafetyNumber|\[String\(peerPubKeyHex\), String\(myPubKeyHex\)\]\.sort\(\)/;
  assertAbsent({
    channel: 'the P-256 safety-number computation in index.html',
    controlMessage: 'the matcher finds a planted copy of the old function',
    control: () => (oldCeremony.test(OLD) ? 1 : 0),
    absent: () => !oldCeremony.test(html),
    message: 'no SHA-256-over-sorted-P-256-keys safety number remains',
  });
  ok(!extract('peerKeyVerified'), 'peerKeyVerified (verified = a P-256 key) is gone');
}

console.log('\n=== VERIFIED gating ===');
const stateSrc = [extract('NODE_ID_FULL'), extract('VERIFICATION_RECORD_VERSION'), extract('contactVerificationState')];
if (stateSrc.some((s) => !s)) {
  ok(false, 'contactVerificationState / NODE_ID_FULL / VERIFICATION_RECORD_VERSION exist in index.html');
} else {
  const { value: state } = evaluate(stateSrc.join('\n'), {}, 'contactVerificationState');
  const rec = (nodeId) => ({ v: 2, nodeId });
  const meshPin = (nodeId, key) => ({ key, via: 'gmp-pop', nodeId });
  ok(state({ peerId: A, record: rec(A), keyPin: meshPin(A, KEY), currentKey: KEY }) === 'verified',
    '(a) positive control: verified NodeID + key pinned by proof over GMP to that NodeID -> verified');
  ok(state({ peerId: A, record: rec(B), keyPin: meshPin(A, KEY), currentKey: KEY }) === 'nodeid-changed',
    '(b) the recorded NodeID differs from the contact\'s current NodeID -> nodeid-changed (cleared, warned)');
  ok(state({ peerId: FP, record: rec(FP), keyPin: meshPin(FP, KEY), currentKey: KEY }) === 'not-verifiable',
    '(c) a Quick-Connect-only peer (bundle-claimed fingerprint id) -> not-verifiable, whatever is stored');
  ok(state({ peerId: A, record: rec(A), keyPin: null, currentKey: KEY }) === 'key-unproven',
    '(d) key pinned off-GMP (no mesh proof recorded) -> not verified');
  ok(state({ peerId: A, record: rec(A), keyPin: { key: KEY, via: 'datachannel', nodeId: A }, currentKey: KEY }) === 'key-unproven',
    '(d) a pin made over a data channel -> not verified');
  ok(state({ peerId: A, record: rec(A), keyPin: meshPin(A, KEY), currentKey: KEY2 }) === 'key-unproven',
    'the chat key in use is not the mesh-proven one -> not verified');
  ok(state({ peerId: A, record: rec(A), keyPin: meshPin(B, KEY), currentKey: KEY }) === 'key-unproven',
    'a key proven to a different NodeID -> not verified');
  ok(state({ peerId: A, record: KEY, keyPin: meshPin(A, KEY), currentKey: KEY }) === 'unverified',
    'an old-format record (a P-256 key string) does not count');
  ok(state({ peerId: A, record: rec(A.slice(0, 16)), keyPin: meshPin(A, KEY), currentKey: KEY }) !== 'verified',
    'a fingerprint-prefix record does not count');
  ok(state({ peerId: A, record: null, keyPin: meshPin(A, KEY), currentKey: KEY }) === 'unverified', 'never verified -> unverified');
}

console.log('\n=== confirming records the FULL NodeID, never an address or prefix ===');
{
  const src = component('const confirmVerification = () => {');
  if (!src) ok(false, 'confirmVerification exists');
  else {
    const run = (peer) => {
      const written = []; const toasts = [];
      let state = {};
      const { value: confirm } = evaluate(`${stateSrc.join('\n')}\n${src}`, {
        verificationPeer: peer, addToast: (m, k) => toasts.push([m, k]), setShowVerificationCeremony: () => {},
        setVerificationComplete: (fn) => { state = fn(state); },
        SecretStore: { set: (k, v) => written.push([k, v]) }, VERIFIED_STORAGE_KEY: 'gl_verified_contacts',
      }, 'confirmVerification');
      confirm();
      return { state, written, toasts };
    };
    const r = run({ id: A, fingerprint: A, name: 'a', ghostAddress: 'GHOST-AAA-BBB-CCC', pubKey: KEY });
    ok(JSON.stringify(r.state[A]) === JSON.stringify({ v: 2, nodeId: A, at: r.state[A] && r.state[A].at }) && r.state[A].nodeId.length === 128,
      `a mesh contact: the record is { v: 2, nodeId: <128-hex NodeID>, at } (got ${typeof r.state[A] === 'object' ? JSON.stringify(Object.keys(r.state[A])) : typeof r.state[A]})`);
    ok(!JSON.stringify(r.written).includes('GHOST-') && !JSON.stringify(r.written).includes(KEY), 'nothing written holds a Ghost Address or the P-256 key');
    const q = run({ id: FP, fingerprint: FP, name: 'q', pubKey: KEY });
    ok(Object.keys(q.state).length === 0 && q.written.length === 0, 'a Quick-Connect-only peer: nothing is recorded');
  }
}

console.log('\n=== key pins remember whether the proof came over GMP ===');
{
  const src = ['INBOUND_NAME_MAX', 'inboundStr', 'PINNABLE_KEY', 'NODE_ID_FULL', 'createKeyPinning'].map(extract);
  if (src.some((s) => !s)) ok(false, 'createKeyPinning and its helpers exist');
  else {
    const mk = ({ pinned = {}, meshPinned = {} } = {}) => {
      const sent = []; const pins = [];
      const { value: create } = evaluate(src.join('\n'), {}, 'createKeyPinning');
      const kp = create({
        seal: async (obj) => JSON.stringify(obj), unseal: async (s) => JSON.parse(s),
        selfIds: () => ['self-node', 'SELFFP'], send: (peerId, payload) => sent.push([peerId, payload]),
        getPinned: (id) => pinned[id] || null, hasMeshPin: (id, key) => meshPinned[id] === key,
        pin: (peerId, key, name, opts) => pins.push({ peerId, key, viaMesh: !!(opts && opts.viaMesh) }),
        randomHex: () => 'n0nce',
      });
      return { kp, sent, pins };
    };
    const announce = { publicKeyHex: KEY, name: 'x' };
    {
      const t = mk();
      ok(await t.kp.onAnnounce(A, announce, 'gmp') === 'challenged', 'positive control: a new key announced over GMP is challenged');
      t.kp.onProof(A, { nonce: 'n0nce' }, 'gmp');
      ok(t.pins.length === 1 && t.pins[0].viaMesh === true, 'announce + proof over GMP from a NodeID -> pinned as mesh-proven');
    }
    {
      const t = mk();
      await t.kp.onAnnounce(FP, announce, 'datachannel');
      t.kp.onProof(FP, { nonce: 'n0nce' }, 'datachannel');
      ok(t.pins.length === 1 && t.pins[0].viaMesh === false, 'over a Quick-Connect data channel -> pinned, but NOT mesh-proven');
    }
    {
      const t = mk();
      await t.kp.onAnnounce(A, announce, 'datachannel');
      t.kp.onProof(A, { nonce: 'n0nce' }, 'gmp');
      ok(t.pins.length === 1 && t.pins[0].viaMesh === false, 'challenge off-GMP, proof on GMP -> NOT mesh-proven');
    }
    {
      const t = mk({ pinned: { [A]: KEY } });
      ok(await t.kp.onAnnounce(A, announce, 'gmp') === 'challenged', 'a key already pinned WITHOUT mesh proof is re-challenged over GMP');
      const u = mk({ pinned: { [A]: KEY }, meshPinned: { [A]: KEY } });
      ok(await u.kp.onAnnounce(A, announce, 'gmp') === 'known', 'a key already proven over GMP is not re-challenged');
      const w = mk({ pinned: { [A]: KEY2 } });
      ok(await w.kp.onAnnounce(A, announce, 'gmp') === 'mismatch', 'a different key than the pinned one is still refused');
    }
  }
}

console.log('\n=== no text equates matching addresses with verification ===');
{
  const re = /address(es)?\s+(match|matches|matching)\b|match(es|ing)?\s+(the\s+)?(ghost\s+)?address(es)?\b/i;
  const files = ['index.html', 'README.md', 'SECURITY.md', 'gmp-core/SECURITY.md'];
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|ts|mjs|cjs|jsx|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
  files.push(...walk('src'), ...walk('electron/src'), ...walk('mobile/src'), ...walk('gmp-core/src'));
  const hits = files.filter((f) => fs.existsSync(path.join(root, f)) && re.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assertAbsent({
    channel: '"addresses match" wording',
    controlMessage: 'the matcher finds a planted "The addresses match — contact verified"',
    control: () => (re.test('The addresses match — contact verified') ? 1 : 0),
    absent: () => hits.length === 0,
    message: `no "addresses match" wording in ${files.length} files (hits: ${JSON.stringify(hits)})`,
  });
}

console.log('\n=== an ambiguous Ghost Address shows every candidate and adds none (D9) ===');
{
  const NAMES = ['SecretStore', 'PeerCache', 'GHOST_ADDRESS_ALPHABET', 'GHOST_ADDRESS_LENGTH', 'GHOST_ADDRESS_PATTERN', 'NODE_ID_PATTERN',
    'ghostAddressFromNodeId', 'normalizeGhostAddress', 'isGhostAddress', 'isNodeIdHex', 'KNOWN_PEERS_KEY', 'BLOCKED_PEERS_KEY',
    'KNOWN_PEERS_MAX', 'loadBlockedPeers', 'setPeerBlocked', 'loadKnownPeers', 'rememberKnownPeer', 'forgetKnownPeer',
    'getGmpPort', 'isTrustedBridgeTarget', 'getBridgeWsUrl', 'openBridgeSocket', 'MESH_TRANSPORT_LABELS', 'meshModeLabel', 'GMPBridgeConnector'];
  const store = new Map();
  global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  global.window = global.window || { location: { protocol: 'http:', hostname: 'localhost', search: '' } };
  const lib = new Function(`${NAMES.map(extract).join('\n\n')}\nreturn { GMPBridgeConnector, ghostAddressFromNodeId, normalizeGhostAddress, isNodeIdHex };`)();
  const twin = Buffer.from(B, 'hex'); twin[40] ^= 0xff;
  const TWIN = twin.toString('hex');
  const address = lib.ghostAddressFromNodeId(B);
  const joinSrc = component('const joinPeer = async (code) => {');
  const run = async ({ resolve, pinned = null }) => {
    const conn = new lib.GMPBridgeConnector({});
    const dials = [];
    conn._request = async (req) => {
      if (req.type === 'resolve') return resolve;
      if (req.type === 'connectNode') { dials.push(req.nodeId); return { connected: true, nodeId: req.nodeId }; }
      if (req.type === 'pinCheck') return { decision: 'ok' };
      return {};
    };
    conn.pinCheck = async () => 'accept';
    const calls = { pinAddress: [], ambiguous: [], toasts: [] };
    const PeerCache = { findByAddress: () => pinned, pinAddress: (id, a) => { calls.pinAddress.push([id, a]); return true; }, repin: () => true };
    const { value: joinPeer, unknown } = evaluate(joinSrc, {
      p2pConnectorRef: { current: conn }, PeerCache, addToast: (m, k) => calls.toasts.push(m),
      normalizeGhostAddress: lib.normalizeGhostAddress, isNodeIdHex: lib.isNodeIdHex,
      setAmbiguousResolution: (v) => { if (v) calls.ambiguous.push(v); }, setJoinStatus: () => {}, setJoinCode: () => {}, setShowInvite: () => {},
      setVerificationComplete: () => {},
    }, 'joinPeer');
    await joinPeer(address);
    return { dials, calls, unknown };
  };
  if (!joinSrc) ok(false, 'joinPeer exists');
  else {
    const amb = await run({ resolve: { reason: 'ambiguous', candidates: [B, TWIN] } });
    const shown = amb.calls.ambiguous.at(-1);
    ok(lib.ghostAddressFromNodeId(TWIN) === address, `control: two NodeIDs share ${address}`);
    ok(!!shown && shown.address === address && JSON.stringify([...shown.candidates].sort()) === JSON.stringify([B, TWIN].sort()),
      `both full NodeIDs are shown as candidates (${shown ? shown.candidates.length : 0})`);
    const okRun = await run({ resolve: { reason: 'ok', nodeId: B } });
    assertAbsent({
      channel: 'dial or address pin after an ambiguous resolve',
      controlMessage: 'the same join with an unambiguous resolve dials once and pins the address once',
      control: () => (okRun.dials.length === 1 && okRun.calls.pinAddress.length === 1 ? 1 : 0),
      absent: () => amb.dials.length === 0 && amb.calls.pinAddress.length === 0,
      message: `ambiguous: nothing dialled, nothing pinned (dials ${amb.dials.length}, pins ${amb.calls.pinAddress.length})`,
    });
    const pinnedElsewhere = await run({ resolve: { reason: 'ambiguous', candidates: [B, TWIN] }, pinned: 'f'.repeat(128) });
    ok(pinnedElsewhere.dials.length === 0 && pinnedElsewhere.calls.ambiguous.length === 1,
      'a pinned contact whose NodeID is not among the candidates: candidates shown, nothing dialled');
    const pinnedAmong = await run({ resolve: { reason: 'ambiguous', candidates: [B, TWIN] }, pinned: B });
    ok(pinnedAmong.dials.length === 1 && pinnedAmong.dials[0] === B, 'positive control: a pinned contact among the candidates dials only its pinned NodeID');
  }
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
