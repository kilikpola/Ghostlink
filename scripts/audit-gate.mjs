#!/usr/bin/env node
/**
 * CI audit gate (task B5).
 *
 * Fails on any high or critical advisory in the runtime dependencies of
 * gmp-core, the desktop app (electron) and the root package (web client and
 * bridge). Those can never be allowlisted.
 *
 * Mobile findings are gated too, but may be accepted one by one in
 * audit-allowlist.json: each entry names the package and its advisories, says
 * why, and carries a reviewBy date after which it stops counting. A new
 * advisory on an allowlisted package fails the gate; so does an expired entry.
 * Dev-only dependencies are outside every scope (`npm audit --omit=dev`).
 *
 *   node scripts/audit-gate.mjs                       audit the tree (needs the registry)
 *   node scripts/audit-gate.mjs --fixture gmp-core=a.json --fixture mobile=b.json ...
 *                                                     use saved `npm audit --json` output instead
 *   --allowlist <file>   (default audit-allowlist.json)   --today YYYY-MM-DD (default: today, UTC)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What is audited, and whether its findings may be allowlisted. */
export const SCOPES = [
  { name: 'gmp-core', args: ['--prefix', 'gmp-core'], allowlistable: false, ships: 'desktop, bridge, public peer' },
  { name: 'electron', args: ['--workspace=electron'], allowlistable: false, ships: 'desktop' },
  { name: 'root', args: ['--workspaces=false'], allowlistable: false, ships: 'web client, bridge' },
  { name: 'mobile', args: ['--workspace=mobile'], allowlistable: true, ships: 'mobile (and its build tooling)' },
];
const GATED = new Set(['high', 'critical']);

const advisoriesOf = (v) => (v.via || []).filter((x) => x && typeof x === 'object')
  .map((x) => (typeof x.url === 'string' && x.url.split('/').pop()) || String(x.source || x.title));

/**
 * reports: { [scope]: npm audit --json output }. Returns { failures, accepted, unused }.
 */
export function evaluate({ reports, allowlist = [], today = new Date().toISOString().slice(0, 10) }) {
  const failures = [], accepted = [];
  const used = new Set();
  for (const scope of SCOPES) {
    const report = reports[scope.name];
    if (!report || typeof report !== 'object' || !report.vulnerabilities) {
      failures.push(`${scope.name}: no audit report (${report && report.error ? report.error.summary || report.error : 'missing'})`);
      continue;
    }
    for (const [pkg, v] of Object.entries(report.vulnerabilities)) {
      if (!GATED.has(v.severity)) continue;
      const advisories = advisoriesOf(v);
      const what = `${scope.name}: ${v.severity} ${pkg}${advisories.length ? ` (${advisories.join(', ')})` : ` (via ${(v.via || []).filter((x) => typeof x === 'string').join(', ')})`}`;
      if (!scope.allowlistable) { failures.push(`${what} — runtime dependency of ${scope.name}; cannot be allowlisted`); continue; }
      const entry = allowlist.find((e) => e.scope === scope.name && e.package === pkg);
      if (!entry) { failures.push(`${what} — not in the allowlist`); continue; }
      used.add(entry);
      const unlisted = advisories.filter((a) => !(entry.advisories || []).includes(a));
      if (unlisted.length) { failures.push(`${what} — advisory not covered by its allowlist entry: ${unlisted.join(', ')}`); continue; }
      if (!(typeof entry.reviewBy === 'string' && entry.reviewBy >= today)) { failures.push(`${what} — allowlist entry expired (reviewBy ${entry.reviewBy})`); continue; }
      accepted.push(`${what} — allowlisted until ${entry.reviewBy}: ${entry.reason}`);
    }
  }
  for (const e of allowlist) {
    if (!SCOPES.some((s) => s.name === e.scope && s.allowlistable)) failures.push(`allowlist entry for ${e.package} names scope "${e.scope}", which cannot be allowlisted`);
    else if (!e.reason || !e.reviewBy) failures.push(`allowlist entry for ${e.package} has no reason or reviewBy`);
  }
  const unused = allowlist.filter((e) => !used.has(e)).map((e) => `${e.scope}/${e.package}`);
  return { failures, accepted, unused };
}

function audit(scope) {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json', ...scope.args], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  try { return JSON.parse(r.stdout); } catch { return { error: `npm audit produced no JSON (exit ${r.status}): ${(r.stderr || '').slice(0, 300)}` }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const fixtures = {};
  argv.forEach((a, i) => { if (a === '--fixture') { const [s, f] = argv[i + 1].split('='); fixtures[s] = f; } });
  const allowlist = JSON.parse(fs.readFileSync(opt('--allowlist') || path.join(root, 'audit-allowlist.json'), 'utf8')).entries || [];
  const reports = {};
  for (const s of SCOPES) reports[s.name] = fixtures[s.name] ? JSON.parse(fs.readFileSync(fixtures[s.name], 'utf8')) : audit(s);
  const { failures, accepted, unused } = evaluate({ reports, allowlist, today: opt('--today') || undefined });
  for (const a of accepted) console.log(`accepted  ${a}`);
  for (const u of unused) console.log(`unused allowlist entry  ${u} (no longer reported; remove it)`);
  for (const f of failures) console.log(`FAIL      ${f}`);
  console.log(failures.length ? `\naudit gate: ${failures.length} failing` : `\naudit gate: passed (${accepted.length} allowlisted mobile findings)`);
  process.exit(failures.length ? 1 : 0);
}
