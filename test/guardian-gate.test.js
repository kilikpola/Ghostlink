/**
 * Guardian recovery is gated off in src/utils/capabilities.js; checks the gate
 * exists, fails closed, and is applied on both sides in index.html.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

test('guardian recovery is marked unavailable, with a reason', () => {
  const g = {};
  const src = fs.readFileSync(path.join(root, 'src', 'utils', 'capabilities.js'), 'utf8');
  new Function('globalThis', src)(g);
  assert.strictEqual(g.GhostLink.Capabilities.GUARDIAN_RECOVERY_AVAILABLE, false);
  assert.ok(g.GhostLink.Capabilities.GUARDIAN_RECOVERY_UNAVAILABLE_REASON.length > 0);
});

test('the page reads the flag fail-closed (absent means unavailable)', () => {
  assert.ok(html.includes('window.GhostLink?.Capabilities?.GUARDIAN_RECOVERY_AVAILABLE === true'));
});

test('sending a fragment is refused before anything is sealed or sent', () => {
  const start = html.indexOf('const sendFragmentToPeer');
  const fn = html.slice(start, html.indexOf('// Handle incoming fragments', start));
  assert.ok(fn.includes('sealPayload(') && fn.includes('markFragmentDistributed('), 'could not isolate sendFragmentToPeer');
  const gate = fn.indexOf('if (!guardianRecoveryAvailable)');
  assert.ok(gate > 0, 'sendFragmentToPeer has no gate');
  assert.ok(gate < fn.indexOf('sealPayload('), 'the gate runs after the fragment is sealed');
  assert.ok(gate < fn.indexOf('markFragmentDistributed('), 'the gate runs after the fragment is marked distributed');
});

test('no peer is offered as a fragment recipient while gated', () => {
  assert.ok(html.includes('const eligiblePeers = guardianRecoveryAvailable ? peers.filter('));
});

test('a received fragment is neither opened nor acknowledged as held', () => {
  const i = html.indexOf("if (parsed.type === 'fragment-sealed')");
  assert.ok(i > 0);
  const branch = html.slice(i, html.indexOf('}', html.indexOf("'warning');", i)));
  assert.ok(!branch.includes('unsealPayload'), 'the fragment is still decrypted');
  assert.ok(!/Received fragment/.test(branch), 'the receiver is still told it received a fragment');
});

test('the bundle carries the flag the page reads', () => {
  const bundle = fs.readFileSync(path.join(root, 'app.bundle.js'), 'utf8');
  assert.ok(bundle.includes('GUARDIAN_RECOVERY_AVAILABLE'), 'app.bundle.js is stale — run npm run build');
});

if (!process.exitCode) console.log(`All guardian-gate tests passed (${passed})`);
