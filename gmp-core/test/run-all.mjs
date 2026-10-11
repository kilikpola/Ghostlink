/** Runs every assertion suite, continuing past failures, and fails at the end if any did. */
import {readdirSync, readFileSync, mkdtempSync, rmSync, accessSync, writeFileSync, constants} from 'fs';
import os from 'os';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITE_TIMEOUT_MS = 180000;

/**
 * Suites that legitimately print no "N passed, K failed" summary. Every other
 * suite must print one or "=== skipped ===" (guard 3 below).
 */
const SUMMARY_EXEMPT = new Set([
  // Prints "  ok  <name>" per test and "All metrics-csrf tests passed"; exits 1
  // on any failure and on a throw.
  'metrics-csrf-test.js',
]);

/**
 * Where suites keep scratch files: GMP_TEST_TMPDIR, else /dev/shm when
 * writable (cheap fsync for claim-heavy suites), else the OS temp dir.
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
const emptyPeers = path.join(mkdtempSync(path.join(scratch, 'gmp-peers-')), 'public-peers.json');
writeFileSync(emptyPeers, '[]\n');

// The run-manual-* and simulate-* scripts are interactive or long-running
// demonstrations, not assertion suites.
const suites = readdirSync(here)
  .filter(f => f.endsWith('-test.js') && !f.startsWith('run-manual') && !f.startsWith('simulate'))
  .sort();

/**
 * createGMPNode is the only construction path: refuse the run if `new
 * GMPNode(` appears in gmp-core/src, gmp-core/test or electron/src.
 * (`new Old.GMPNode(` for interop does not match.)
 */
function handBuiltNodes() {
  const roots = [path.join(here, '..', 'src'), here, path.join(here, '..', '..', 'electron', 'src')];
  const allowed = new Set([path.resolve(here, '..', 'src', 'node-factory.ts')]);
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(m?js|ts)$/.test(e.name) || allowed.has(path.resolve(p))) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![.\w$])new\s+GMPNode\s*\(/.test(line)) hits.push(`${path.relative(path.join(here, '..', '..'), p)}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  roots.forEach(walk);
  return hits;
}
const handBuilt = handBuiltNodes();
if (handBuilt.length) {
  console.error('\u2717 harness: GMPNode constructed outside createGMPNode (src/node-factory.ts) — every node must be built the way production builds it (GM-M4-1):');
  for (const h of handBuilt) console.error(`    ${h}`);
  process.exit(1);
}

const results = [];
for (const suite of suites) {
  // GMP_DEBUG_ASSERTS=1 enables the internal invariant assertions; each suite
  // gets its own GMP_DATA_DIR and TMPDIR.
  const dataDir = mkdtempSync(path.join(scratch, 'gmp-suite-'));
  const r = spawnSync(process.execPath, [path.join(here, suite)], {
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    // GMP_LAN_DISCOVERY / GMP_PUBLIC_PEERS_PATH: network isolation through the
    // environment (see helpers/isolate-data.mjs); the node does no test detection.
    env: {...process.env, GMP_DEBUG_ASSERTS: '1', GMP_DATA_DIR: dataDir, TMPDIR: scratch,
      GMP_LAN_DISCOVERY: 'false', GMP_PUBLIC_PEERS_PATH: emptyPeers},
  });
  rmSync(dataDir, {recursive: true, force: true});
  let out = (r.stdout || '') + (r.stderr || '');
  // A suite killed by the timeout otherwise shows only the output it had
  // printed so far, which reads like a crash with no error.
  if (r.error && r.error.code === 'ETIMEDOUT') {
    out += `\n  ✗ killed: suite exceeded the ${SUITE_TIMEOUT_MS / 1000} s limit (scratch dir: ${scratch})`;
  }
  // One regex for every summary form; the failed count is always group 3.
  //   Results: N passed, K failed[, T total]
  //   === N/M passed, K failed ===
  //   N/M passed, K failed
  const m = out.match(/(?:Results:\s*|===\s*)?(\d+)(?:\/(\d+))?\s*passed,\s*(\d+)\s*failed/);
  const skipped = /=== skipped ===/.test(out);
  // A zero exit is still FAIL when:
  //   1. a ✗ (failed assertion) was printed;
  //   2. a non-zero failed count was reported;
  //   3. neither a summary nor a skip marker was printed (an early throw was
  //      swallowed). SUMMARY_EXEMPT lists suites with their own format.
  const reportedFail = m ? Number(m[3]) : null;
  const printedFailure = /\u2717/.test(out); // \u2717, printed only by a failed assertion
  const noSummary = !m && !skipped && !SUMMARY_EXEMPT.has(suite);
  let ok = r.status === 0 && !printedFailure && !noSummary && !(reportedFail && reportedFail > 0);
  if (r.status === 0 && !ok) {
    const why = printedFailure ? 'printed a failure marker'
      : (reportedFail && reportedFail > 0) ? `self-reported ${reportedFail} failed`
      : 'printed no summary and no skip marker, so it never reached the end of its own run — a swallowed throw';
    out += `\n  \u2717 harness: suite exited 0 but ${why} — forced FAIL`;
  }
  results.push({
    suite,
    ok,
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
