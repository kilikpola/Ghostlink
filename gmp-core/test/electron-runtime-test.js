/**
 * The packaged desktop runtime: node construction under Electron's bundled Node.
 *
 *  1. Electron's Node satisfies the engines floor of gmp-core and the root package
 *  2. under ELECTRON_RUN_AS_NODE=1: dist/link.js loads, the lazy TCP default
 *     and LAN discovery load, and two nodes complete a TCP handshake
 *  3. negative control: the same probe with `net` blocked fails
 *
 * Skipped when the Electron binary is not installed.
 *
 * Run: node test/electron-runtime-test.js
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

let electron = null;
try {
  electron = createRequire(path.join(repo, 'electron', 'package.json'))('electron');
} catch { /* not installed */ }
if (!electron || !fs.existsSync(electron)) {
  console.log('  ~ Electron binary not installed — cannot check the packaged runtime');
  console.log('\n=== skipped ===');
  process.exit(0);
}

const semver = (v) => v.replace(/^[^\d]*/, '').split('.').map(Number);
const atLeast = (v, floor) => { const a = semver(v), b = semver(floor); for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return true; };
const floorOf = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).engines?.node?.replace(/^>=\s*/, '') ?? null;

const run = (extra = []) => spawnSync(electron, [...extra, path.join(here, 'helpers', 'electron-runtime-probe.mjs')],
  { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GMP_LOG_TO_CONSOLE: 'false' }, timeout: 60000 });
const steps = (r) => Object.fromEntries((r.stdout || '').split('\n').filter((l) => l.startsWith('{"step"')).map((l) => { const j = JSON.parse(l); return [j.step, j]; }));

/**
 * Why the binary produced no steps, from what the child left behind. Without
 * this a binary that cannot start (missing shared libraries in a slim CI
 * image) showed up only as "Electron undefined" — the failure was reported,
 * its cause was not.
 */
function whyNoOutput(res) {
  const stderr = (res.stderr || '').trim();
  const lib = stderr.match(/error while loading shared libraries: ([^:\s]+)/);
  const lines = [
    `    binary: ${electron}`,
    `    exit status ${res.status}, signal ${res.signal}${res.error ? `, spawn error ${res.error.code || res.error.message}` : ''}`,
  ];
  if (lib) lines.push(`    MISSING SYSTEM LIBRARY ${lib[1]}: this image lacks Electron's runtime libraries (install them before this test; .gitlab-ci.yml desktop-package does)`);
  if (stderr) lines.push('    stderr (last lines):', ...stderr.split('\n').slice(-8).map((l) => `      ${l}`));
  else lines.push('    stderr: (empty)');
  return lines.join('\n');
}

console.log('=== 1. runtime versus engines floors ===');
const r = run();
const s = steps(r);
if (!s.runtime) console.error(`  ! the Electron binary produced no output — it did not run:\n${whyNoOutput(r)}`);
const rt = s.runtime ? JSON.parse(s.runtime.detail) : {};
console.log(`    Electron ${rt.electron}, bundled Node ${rt.node}; system Node ${process.versions.node}`);
for (const pkg of [path.join(here, '..', 'package.json'), path.join(repo, 'package.json')]) {
  const floor = floorOf(pkg);
  assert(floor && rt.node && atLeast(rt.node, floor), `${path.relative(repo, pkg)} engines >=${floor}: Electron's Node ${rt.node} satisfies it`);
}
assert(rt.node && atLeast(rt.node, '22.12.0'), `Electron's Node supports require() of ES modules (>= 22.12), which link.js's lazy loads need`);

console.log('\n=== 2. under the Electron binary ===');
if (s.error) console.error(s.error.detail);
for (const step of ['load', 'default-transport', 'lan-discovery-loaded', 'tcp-handshake']) {
  assert(s[step] && s[step].ok, `${step}: ${s[step] ? s[step].detail : 'did not run'}`);
}

console.log('\n=== 3. negative control ===');
const blockedRun = run(['--import', path.join(here, 'helpers', 'block-net.mjs')]);
const blocked = steps(blockedRun);
if (!blocked.error && !blocked.runtime) console.error(`  ! the blocked run produced no output either:\n${whyNoOutput(blockedRun)}`);
assert(blocked.error && /BLOCKED import of 'net'/.test(blocked.error.detail) && !blocked['tcp-handshake'],
  'with `net` blocked the same probe fails at the lazy TCP load — this test sees module-loading breaks');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
