/**
 * No behaviour branches on where the code thinks it is running. Tests opt in
 * explicitly (GMP_DEBUG_ASSERTS=1, GMP_LAN_DISCOVERY=false, empty
 * GMP_PUBLIC_PEERS_PATH).
 *
 *  1. gmp-core/src reads no NODE_ENV and sniffs no argv path for "test"
 *  2. NODE_ENV=test alone leaves claim-log debug asserts off
 *  3. GMP_DEBUG_ASSERTS=1 turns them on, in any environment
 *
 * Run with: node test/env-sniffing-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

console.log('\n=== 1. no environment sniffing in gmp-core/src ===');
{
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|js)$/.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(line)) return; // block-comment line
        if (/process\.env\.NODE_ENV/.test(code) || /argv\[\d\][^;\n]*\.includes\(/.test(code)) {
          hits.push(`${path.relative(src, p)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  };
  walk(src);
  for (const h of hits) console.error(`    ${h}`);
  const flags = (line) => { const code = line.replace(/\/\/.*$/, ''); return !/^\s*\*/.test(line) && (/process\.env\.NODE_ENV/.test(code) || /argv\[\d\][^;\n]*\.includes\(/.test(code)); };
  assertAbsent({
    channel: 'NODE_ENV / argv line rule',
    control: () => flags("if (process.env.NODE_ENV === 'test') skip();") && flags("const isTest = process.argv[1].includes('test');") && !flags('// process.env.NODE_ENV is not read'),
    controlMessage: 'the rule flags a NODE_ENV read and an argv path test, and passes a comment',
    absent: () => hits.length === 0,
    message: `no NODE_ENV read and no argv path test in gmp-core/src (${hits.length} found)`,
  });
}

function debugAsserts(env) {
  const script = `import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'dist', 'claim-log.js')).href)}).then((m) => console.log(String(m.DEBUG_ASSERTS)))`;
  const clean = { ...process.env };
  delete clean.NODE_ENV;
  delete clean.GMP_DEBUG_ASSERTS;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...clean, ...env }, encoding: 'utf8' });
  return r.stdout.trim().split('\n').pop();
}

console.log('\n=== 2. NODE_ENV=test alone changes nothing ===');
{
  const v = debugAsserts({ NODE_ENV: 'test' });
  assert(v === 'false', `claim-log debug asserts are off under NODE_ENV=test with no explicit switch (got ${v})`);
}

console.log('\n=== 3. the explicit switch works anywhere ===');
{
  const v = debugAsserts({ GMP_DEBUG_ASSERTS: '1', NODE_ENV: 'production' });
  assert(v === 'true', `GMP_DEBUG_ASSERTS=1 turns them on (got ${v})`);
  const off = debugAsserts({});
  assert(off === 'false', `off by default (got ${off})`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
