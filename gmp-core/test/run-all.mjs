/**
 * Runs every assertion suite and reports all of them.
 *
 * `test:all` used to be one long `&&` chain, so the first failure stopped the
 * run and everything after it silently never executed — at one point nine
 * suites were being skipped because an early one broke. This runs each suite
 * regardless and fails at the end if any did.
 */
import {readdirSync, mkdtempSync, rmSync, accessSync, constants} from 'fs';
import os from 'os';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITE_TIMEOUT_MS = 180000;

/**
 * Where suites keep their scratch files.
 *
 * The claim log fsyncs every record before a claim counts, and some suites
 * make 100,000 claims. On a disk-backed temp dir that is dominated by fsync:
 * claim-log-test took 185 s on btrfs, over the per-suite limit, and GitLab CI
 * (disk-backed /tmp) killed it mid-run. A RAM-backed directory makes fsync
 * cheap without changing what the code does: every fsync still runs, the
 * suites still exercise the same write, flush and recovery paths.
 *
 * GMP_TEST_TMPDIR overrides the choice; otherwise /dev/shm when it is writable
 * (Linux, including Docker, whose default 64 MB is ample — peak use is ~24 MB),
 * else the OS temp dir.
 */
function scratchRoot() {
  if (process.env.GMP_TEST_TMPDIR) return process.env.GMP_TEST_TMPDIR;
  try {
    accessSync('/dev/shm', constants.W_OK);
    return '/dev/shm';
  } catch {
    return os.tmpdir();
  }
}
const scratch = scratchRoot();

// The run-manual-* and simulate-* scripts are interactive or long-running
// demonstrations, not assertion suites.
const suites = readdirSync(here)
  .filter(f => f.endsWith('-test.js') && !f.startsWith('run-manual') && !f.startsWith('simulate'))
  .sort();

const results = [];
for (const suite of suites) {
  // NODE_ENV=test turns on the internal invariant assertions (see
  // ASSERT_BOUNDARIES in claim-log.ts), so a suite that trips one fails loudly
  // rather than carrying on with a broken offset.
  //
  // GMP_DATA_DIR gives each suite its own throwaway state directory. Without
  // it every suite that builds a node wrote nonce claim logs, nonce-state.json
  // and peer-cache.json into the developer's real gmp-core/data (one new claim
  // log pair per identity per run), and suites could see each other's state.
  //
  // TMPDIR sends the suite's own os.tmpdir() scratch files to the same place.
  const dataDir = mkdtempSync(path.join(scratch, 'gmp-suite-'));
  const r = spawnSync(process.execPath, [path.join(here, suite)], {
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    env: {...process.env, NODE_ENV: 'test', GMP_DATA_DIR: dataDir, TMPDIR: scratch},
  });
  rmSync(dataDir, {recursive: true, force: true});
  let out = (r.stdout || '') + (r.stderr || '');
  // A suite killed by the timeout otherwise shows only the output it had
  // printed so far, which reads like a crash with no error.
  if (r.error && r.error.code === 'ETIMEDOUT') {
    out += `\n  ✗ killed: suite exceeded the ${SUITE_TIMEOUT_MS / 1000} s limit (scratch dir: ${scratch})`;
  }
  const m = out.match(/Results: (\d+) passed, (\d+) failed/) || out.match(/=== (\d+)\/(\d+) passed/);
  const skipped = /=== skipped ===/.test(out);
  results.push({
    suite,
    ok: r.status === 0,
    passed: m ? Number(m[1]) : 0,
    skipped,
    out,
  });
}

let total = 0;
const failed = [];
for (const r of results) {
  total += r.passed;
  const label = r.skipped ? 'SKIP' : r.ok ? 'ok  ' : 'FAIL';
  if (!r.ok) failed.push(r);
  console.log(`  ${label}  ${r.suite.padEnd(34)} ${r.passed ? r.passed + ' assertions' : ''}`);
}

console.log(`\n  ${results.length} suites, ${total} assertions, ${failed.length} failing   (scratch: ${scratch})`);
for (const f of failed) {
  console.log(`\n──── ${f.suite} ────`);
  console.log(f.out.split('\n').filter(l => !l.includes('"component":')).slice(-14).join('\n'));
}
process.exit(failed.length ? 1 : 0);
