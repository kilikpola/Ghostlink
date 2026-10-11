/**
 * License subsystem client-side checks: the stored key is re-verified on load
 * (tier and expiry come from it), and no console helper can mint keys.
 *
 * Run with: node test/license-storage.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const store = {};
global.window = global;
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
require('../src/license/license-core.js');
require('../src/license/license-validator.js');
require('../src/license/license-manager.js');
const { LicenseCore, LicenseValidator, LicenseManager } = global.GhostLink;

const DEVICE = 'DEVICE-FINGERPRINT-0001';
const fp = { getFingerprint: async () => DEVICE };
const manager = () => new LicenseManager({ validator: new LicenseValidator({ deviceFingerprint: fp }), deviceFingerprint: fp });

test('a hand-written localStorage record no longer grants a tier', async () => {
  store.gl_license = JSON.stringify({ key: 'GHOST-AAAA-AAAA-AAAA-AAAA-AAAA', tier: 'enterprise', activatedAt: 0, expiresAt: 9e15 });
  const m = manager();
  await m.init();
  assert.strictEqual(await m.getTier(), 'free');
  assert.ok(!('gl_license' in store), 'the forged record should be discarded');
});

test('a stored genuine key keeps working, with tier and expiry taken from the key', async () => {
  const { key } = await LicenseCore.generateLicenseKey({ tier: 'pro', durationMonths: 12, deviceId: DEVICE });
  const activatedAt = Date.now() - 1000;
  // Tier and expiry edited upward after a genuine activation.
  store.gl_license = JSON.stringify({ key, tier: 'enterprise', activatedAt, expiresAt: 9e15 });
  const m = manager();
  await m.init();
  assert.strictEqual(await m.getTier(), 'pro');
  const lic = await m.getActiveLicense();
  assert.strictEqual(lic.expiresAt, LicenseCore.computeExpiryTimestamp(activatedAt, 12));
});

test('a stored key bound to another device is refused', async () => {
  const { key } = await LicenseCore.generateLicenseKey({ tier: 'pro', durationMonths: 12, deviceId: 'SOME-OTHER-DEVICE-99' });
  store.gl_license = JSON.stringify({ key, tier: 'pro', activatedAt: Date.now(), expiresAt: 9e15 });
  const m = manager();
  await m.init();
  assert.strictEqual(await m.getTier(), 'free');
});

test('no license-minting function ships in the bundle entry', () => {
  const entry = fs.readFileSync(path.join(__dirname, '..', 'index-entry.js'), 'utf8');
  assert.ok(!/dev-console/.test(entry), 'index-entry.js imports the license dev console');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'license', 'dev-console.js')));
  const bundle = path.join(__dirname, '..', 'app.bundle.js');
  if (fs.existsSync(bundle)) {
    assert.ok(!fs.readFileSync(bundle, 'utf8').includes('GHOSTPRO'), 'app.bundle.js still carries the unlock word');
  }
});

setTimeout(() => { console.log('FAIL: timed out'); process.exit(1); }, 30000).unref();

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack}`); }
  }
  console.log(failures ? `\n${failures} failing` : `\nall ${tests.length} passed`);
  process.exit(failures ? 1 : 0);
})();
