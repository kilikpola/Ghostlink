/**
 * NullTransport proof
 *
 *  1. src/transport/null-transport.ts has no Node dependency: the compiled
 *     module imports nothing and touches no Node global
 *  2. with net, tls and dgram imports throwing, two nodes handshake, exchange
 *     DATA, open a relay circuit, complete a store-and-forward round trip with
 *     receipt, and hole-punch — entirely over NullTransport
 *
 * Run: node test/null-transport-test.js
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const here = path.dirname(fileURLToPath(import.meta.url));

console.log('=== 1. the transport itself ===');
const src = fs.readFileSync(path.join(here, '..', 'dist', 'transport', 'null-transport.js'), 'utf8');
const imports = [...src.matchAll(/^\s*import\s.*$/gm)].map((m) => m[0]);
assert(imports.length === 0, `compiled null-transport.js imports nothing (${imports.length} import lines)`);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const nodeGlobals = ['Buffer', 'process', 'setImmediate', 'require(', 'EventEmitter', '__dirname'].filter((g) => code.includes(g));
assert(nodeGlobals.length === 0, `and uses no Node global (${nodeGlobals.join(', ') || 'none'})`);

console.log('\n=== 2. the stack over NullTransport, with net / tls / dgram blocked ===');
const r = spawnSync(process.execPath, ['--no-deprecation', '--import', path.join(here, 'helpers', 'block-net.mjs'), path.join(here, 'helpers', 'null-transport-proof.mjs')],
  { encoding: 'utf8', env: { ...process.env, GMP_LOG_TO_CONSOLE: 'false' }, timeout: 60000 });
const steps = Object.fromEntries((r.stdout || '').split('\n').filter((l) => l.startsWith('{"step"')).map((l) => { const j = JSON.parse(l); return [j.step, j]; }));
if (steps.error) console.error(steps.error.detail);
if (!Object.keys(steps).length) console.error(r.stderr);
for (const step of ['transport', 'handshake', 'data', 'relay-circuit', 'store-and-forward', 'hole-punch', 'no-socket-modules']) {
  const s = steps[step];
  assert(s && s.ok, `${step}: ${s ? s.detail : 'did not run'}`);
}
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
