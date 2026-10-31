/**
 * The CI audit step fails on a high/critical advisory in runtime dependencies
 * (task B5). Offline: `npm` is a stub that prints a saved audit report.
 *
 *   1. The audit lines in .github/workflows/ci.yml and .gitlab-ci.yml, run as CI
 *      would (bash -e), fail on a planted high advisory in gmp-core, and pass
 *      on a clean report (control).
 *   2. scripts/audit-gate.mjs rules: runtime findings cannot be allowlisted; a
 *      mobile finding needs an entry, an entry must cover each advisory and
 *      expires at reviewBy; moderate findings do not gate.
 *
 * Run: node test/audit-gate.test.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };

const report = (vulns = {}) => ({ auditReportVersion: 2, vulnerabilities: vulns, metadata: { vulnerabilities: {} } });
const vuln = (name, severity, ghsa, via = []) => ({ name, severity, isDirect: false,
  via: [...via, ...(ghsa ? [{ source: 1, name, title: 'planted', url: `https://github.com/advisories/${ghsa}`, severity }] : [])], fixAvailable: true });
const PLANTED = report({ 'planted-pkg': vuln('planted-pkg', 'high', 'GHSA-plnt-0000-0001') });

// ── 1. The CI files' own audit lines ──────────────────────────────────────
const ciLines = (file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n')
  .filter((l) => /npm audit|audit-gate/.test(l) && !/--no-audit/.test(l) && !/^\s*#/.test(l) && !/^\s*(?:-\s+)?name:/.test(l))
  .map((l) => l.replace(/^\s*(?:-\s+)?(?:run:\s*)?/, '').trim());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-audit-gate-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
fs.writeFileSync(path.join(tmp, 'npm'), '#!/bin/sh\ncat "$AUDIT_FIXTURE"\n[ -n "$AUDIT_FIXTURE_CLEAN" ] && exit 0\nexit 1\n', { mode: 0o755 });
const fixture = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const plantedFile = fixture('planted.json', PLANTED);
const cleanFile = fixture('clean.json', report());
const runCi = (lines, file, clean) => spawnSync('bash', ['-e', '-c', lines.join('\n')], { cwd: root, encoding: 'utf8',
  env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, AUDIT_FIXTURE: file, ...(clean ? { AUDIT_FIXTURE_CLEAN: '1' } : {}) } });

for (const file of ['.github/workflows/ci.yml', '.gitlab-ci.yml']) {
  console.log(`\n=== ${file} ===`);
  const lines = ciLines(file);
  ok(lines.length > 0, `control: found the audit step (${lines.map((l) => l.slice(0, 60)).join(' | ')})`);
  const clean = runCi(lines, cleanFile, true);
  ok(clean.status === 0, `control: a clean audit report passes (exit ${clean.status})`);
  const planted = runCi(lines, plantedFile, false);
  ok(planted.status !== 0, `a planted high advisory fails the step (exit ${planted.status})`);
}

// ── 2. Gate rules ─────────────────────────────────────────────────────────
console.log('\n=== gate rules ===');
const { evaluate } = await import(path.join(root, 'scripts', 'audit-gate.mjs'));
const all = (over) => ({ 'gmp-core': report(), electron: report(), root: report(), mobile: report(), ...over });
const entry = (pkg, advisories, reviewBy = '2027-01-31', scope = 'mobile') => ({ scope, package: pkg, advisories, reason: 'test', reviewBy });
const today = '2026-10-31';
const mob = report({ m: vuln('m', 'high', 'GHSA-mmmm-0000-0001') });
ok(evaluate({ reports: all(), today }).failures.length === 0, 'control: clean reports pass');
ok(evaluate({ reports: all({ 'gmp-core': PLANTED }), today }).failures.length === 1, 'high in gmp-core runtime fails');
ok(evaluate({ reports: all({ electron: report({ x: vuln('x', 'critical', 'GHSA-xxxx-0000-0001') }) }), today }).failures.length === 1, 'critical in electron runtime fails');
ok(evaluate({ reports: all({ 'gmp-core': PLANTED }), allowlist: [entry('planted-pkg', ['GHSA-plnt-0000-0001'], '2027-01-31', 'gmp-core')], today }).failures.length >= 1,
  'a runtime finding cannot be allowlisted (the entry itself is refused)');
ok(evaluate({ reports: all({ 'gmp-core': report({ y: vuln('y', 'moderate', 'GHSA-yyyy-0000-0001') }) }), today }).failures.length === 0, 'a moderate finding does not gate');
ok(evaluate({ reports: all({ mobile: mob }), today }).failures.length === 1, 'a mobile high with no allowlist entry fails');
ok(evaluate({ reports: all({ mobile: mob }), allowlist: [entry('m', ['GHSA-mmmm-0000-0001'])], today }).failures.length === 0, 'control: an allowlisted mobile high passes');
ok(evaluate({ reports: all({ mobile: mob }), allowlist: [entry('m', ['GHSA-mmmm-0000-0001'], '2026-10-30')], today }).failures.length === 1, 'an expired entry fails');
ok(evaluate({ reports: all({ mobile: report({ m: vuln('m', 'high', 'GHSA-mmmm-0000-0002') }) }), allowlist: [entry('m', ['GHSA-mmmm-0000-0001'])], today }).failures.length === 1,
  'a new advisory on an allowlisted package fails');
ok(evaluate({ reports: { ...all(), electron: undefined }, today }).failures.length === 1, 'a missing report fails (no silent pass)');
const real = JSON.parse(fs.readFileSync(path.join(root, 'audit-allowlist.json'), 'utf8')).entries;
ok(real.length > 0 && real.every((e) => e.scope === 'mobile' && e.package && Array.isArray(e.advisories) && e.reason && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)),
  `audit-allowlist.json: ${real.length} entries, all mobile, each with package, advisories, reason, reviewBy`);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
