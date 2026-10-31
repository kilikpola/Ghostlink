/**
 * No test injects failures through file permission bits (task D2). Root — the
 * CI runner — ignores them, so such a test either fails in CI for the wrong
 * reason (ratchet-store-test, three checks) or skips itself there and protects
 * nothing (boot-counter-production-test, claim-log-test). Failures are injected
 * through explicit test-only hooks instead: RatchetStoreOptions.writeFile,
 * advanceBootCounter({ readFile }), NonceStore({ claimLogReadFile }).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { absenceAsserter } from './helpers/assert-absent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

// chmod / chmodSync to a mode without owner write or read, or a root/uid skip.
const injection = /chmod(?:Sync)?\([^)]*,\s*0o?[0-5][0-7]{2}\)|getuid\(\)\s*===\s*0/;
const files = [];
for (const dir of [path.join(repo, 'gmp-core', 'test'), path.join(repo, 'gmp-core', 'test', 'helpers'), path.join(repo, 'test'), path.join(repo, 'test', 'helpers'), path.join(repo, 'mobile', 'test')]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (/\.(m?js)$/.test(f) && f !== path.basename(fileURLToPath(import.meta.url))) files.push(path.join(dir, f));
}
console.log('\n=== no fault injection through permission bits, and no root skips ===');
assertAbsent({
  channel: 'chmod to a no-read / no-write mode, or a uid 0 check, in a test file',
  controlMessage: 'the matcher finds planted chmodSync(f, 0o000), chmodSync(dir, 0o500) and a getuid() === 0 skip',
  control: () => ['fs.chmodSync(f, 0o000);', 'fs.chmodSync(env.dir, 0o500);', 'if (process.getuid() === 0) skip();'].filter((s) => injection.test(s)).length === 3,
  absent: () => files.filter((f) => injection.test(fs.readFileSync(f, 'utf8'))).length === 0,
  message: `none in ${files.length} test files (offenders: ${JSON.stringify(files.filter((f) => injection.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(repo, f)))})`,
});
ok(!injection.test('fs.chmodSync(dir, 0o700);'), 'control: an owner-writable mode (0o700, used for socket dirs) is not flagged');
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
