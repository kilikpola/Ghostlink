/**
 * Regression tests for the GhostLinkDebug console interception.
 * Run with: node test/debug-console.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

let failures = 0;
function test(name, fn) {
  // Write directly to stdout: console.* is patched by the module under test.
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures++; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

// ── Minimal browser shim ───────────────────────────────────────────────────
const captured = { info: [], error: [], warn: [], debug: [] };
const fakeLogger = {
  info: (m) => captured.info.push(m),
  error: (m) => captured.error.push(m),
  warn: (m) => captured.warn.push(m),
  debug: (m) => captured.debug.push(m),
};

const nativeWrites = [];
const nativeLog = console.log;
const nativeError = console.error;
const nativeWarn = console.warn;
const nativeDebug = console.debug;
console.log = (...a) => nativeWrites.push(a);
console.error = (...a) => nativeWrites.push(a);
console.warn = (...a) => nativeWrites.push(a);
console.debug = (...a) => nativeWrites.push(a);

// In a browser globalThis === window; mirror that so the module's `exports`
// (globalThis) and its `window` lookups resolve to the same object.
global.window = global;
global.GhostLink = { log: fakeLogger };
global.performance = { memory: null };

require(path.join(__dirname, '..', 'src', 'debug', 'debug-console.js'));

const patchedLog = console.log;
const Debug = global.GhostLink.GhostLinkDebug;

// ── Tests ──────────────────────────────────────────────────────────────────

test('forwards a plain message to the logger', () => {
  captured.info.length = 0;
  console.log('hello', 42);
  assert.strictEqual(captured.info.length, 1);
  assert.ok(captured.info[0].includes('hello'));
  assert.ok(captured.info[0].includes('42'));
});

test('a Proxy whose getPrototypeOf throws does not drop the message', () => {
  captured.info.length = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('nope'); },
    get() { throw new Error('nope'); },
    ownKeys() { throw new Error('nope'); },
  });
  console.log('before', hostile, 'after');
  assert.strictEqual(captured.info.length, 1, 'message was dropped entirely');
  assert.ok(captured.info[0].includes('before'), 'lost the arguments around the bad value');
  assert.ok(captured.info[0].includes('after'), 'lost the arguments around the bad value');
});

test('an Error whose stack throws on conversion does not drop the message', () => {
  captured.info.length = 0;
  const err = new Error('boom');
  // `stack` is writable; a value whose toString throws must stay inside
  // _fmtOne's guard.
  Object.defineProperty(err, 'stack', {
    value: { toString() { throw new Error('hostile stack'); } },
    writable: true, configurable: true,
  });
  console.log('before', err, 'after');
  assert.strictEqual(captured.info.length, 1, 'message was dropped entirely');
  assert.ok(captured.info[0].includes('before'));
  assert.ok(captured.info[0].includes('after'));
});

test('circular references serialize without throwing', () => {
  captured.info.length = 0;
  const a = { name: 'a' }; a.self = a;
  console.log(a);
  assert.strictEqual(captured.info.length, 1);
  assert.ok(captured.info[0].includes('[Circular]'));
});

test('BigInt and Error values survive formatting', () => {
  captured.info.length = 0;
  console.log({ big: 10n });
  console.log(new Error('boom'));
  assert.strictEqual(captured.info.length, 2);
  assert.ok(captured.info[0].includes('10n'));
  assert.ok(captured.info[1].includes('boom'));
});

test('a second instance does not chain the wrappers', () => {
  captured.info.length = 0;
  const second = new Debug();
  console.log('once');
  assert.strictEqual(captured.info.length, 1, `expected 1 forward, got ${captured.info.length}`);
  // A non-owner restoring must not disturb the installed wrapper.
  second.restoreConsole();
  assert.strictEqual(console.log, patchedLog, 'non-owner restored the console');
  assert.strictEqual(captured.info.length, 1, 'forwarding changed after a non-owner detached');
});

test('no duplicate output when the logger falls back to console', () => {
  const owner = global.GhostLinkDebug;
  const prevLog = owner._log;
  owner._log = console;
  nativeWrites.length = 0;
  // console.error is one of the patched methods, so a fallback forward would
  // re-enter the wrapper and print the message a second time.
  console.error('solo');
  assert.strictEqual(nativeWrites.length, 1, `expected 1 native write, got ${nativeWrites.length}`);
  owner._log = prevLog;
});

test('destroying the owner keeps forwarding alive for a remaining instance', () => {
  const a = new Debug();          // not the owner (module instance owns it)
  const b = new Debug();
  const owner = global.GhostLinkDebug;

  // Destroying the original owner must hand ownership over, not uninstall.
  owner.destroy();
  assert.strictEqual(console.log, patchedLog, 'wrappers were torn out while instances remain');

  const seen = [];
  a._log = { info: (m) => seen.push(m), error() {}, warn() {}, debug() {} };
  b._log = { info: (m) => seen.push(m), error() {}, warn() {}, debug() {} };
  captured.info.length = 0;
  console.log('after owner destroyed');
  assert.strictEqual(seen.length, 1, `expected exactly 1 forward, got ${seen.length}`);
  assert.ok(seen[0].includes('after owner destroyed'));

  // Native methods come back only once the last instance is gone.
  a.destroy();
  assert.strictEqual(console.log, patchedLog, 'restored while an instance was still live');
  b.destroy();
  assert.notStrictEqual(console.log, patchedLog, 'wrapper still installed after the last instance');
});

console.log = nativeLog;
console.error = nativeError;
console.warn = nativeWarn;
console.debug = nativeDebug;

if (failures) {
  process.stdout.write(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nAll debug-console tests passed\n');
