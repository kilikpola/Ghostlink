/**
 * Every file of the PACKAGED gmp-core/dist loads from its own bundled
 * node_modules (task R4b).
 *
 * The packaged resources/gmp-core is copied to a temp dir OUTSIDE the
 * checkout, so module resolution cannot walk up into the repo's node_modules
 * (inside the tree it does, and that hid a missing @noble/ciphers). Each
 * dist/**\/*.js is then imported in its own child of the packaged Electron
 * binary under ELECTRON_RUN_AS_NODE=1 — the runtime that ships. A missing
 * runtime dependency of any file fails here, not just of the two entry points.
 *
 *   node test/packaged-gmp-imports.test.mjs   (needs `npm run build:dir` in electron/)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = path.join(repo, 'electron', 'dist', 'linux-unpacked');
const res = path.join(unpacked, 'resources', 'gmp-core');
const bin = path.join(unpacked, 'ghostlink-desktop');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };
const done = () => { console.log(`\nResults: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };

console.log('\n=== packaged gmp-core: every dist file imports from outside the repo ===');
if (!fs.existsSync(res) || !fs.existsSync(bin)) {
  ok(false, `no packaged app at ${path.relative(repo, unpacked)} — run \`npm run build:dir\` in electron/ first`);
  done();
}
console.log(`  packaged app built ${fs.statSync(path.join(unpacked, 'resources', 'app.asar')).mtime.toISOString()}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-packaged-gmp-'));
const copy = path.join(tmp, 'gmp-core');
fs.cpSync(res, copy, { recursive: true });
// Nothing above the copy may hold a node_modules the resolver could fall back to.
const ancestors = [];
for (let d = copy; ; d = path.dirname(d)) { ancestors.push(d); if (path.dirname(d) === d) break; }
const stray = ancestors.slice(1).filter((d) => fs.existsSync(path.join(d, 'node_modules')));
ok(!copy.startsWith(repo + path.sep) && stray.length === 0, `the copy (${copy}) is outside the repo and no ancestor has a node_modules (${JSON.stringify(stray)})`);

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
walk(path.join(copy, 'dist'));

/** Import one file in a fresh packaged-Electron process; → 'IMPORTED' or the error. */
function importIn(file) {
  const code = `import(${JSON.stringify(pathToFileURL(file).href)}).then(` +
    `() => { console.log('IMPORTED'); process.exit(0); },` +
    `(e) => { console.log('IMPORT-FAILED ' + (e.code || '') + ' ' + String(e.message).split('\\n')[0]); process.exit(1); })`;
  const r = spawnSync(bin, ['-e', code], { cwd: tmp, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('IMPORTED') || l.startsWith('IMPORT-FAILED'));
  return line || `NO RESULT (exit ${r.status}, signal ${r.signal}): ${(r.stderr || '').trim().split('\n')[0]}`;
}

// Positive control: a planted file importing a package the copy does not have is caught.
const planted = path.join(copy, 'dist', '__planted-missing-dep.js');
fs.writeFileSync(planted, "import '@noble/not-a-real-package';\n");
const control = importIn(planted);
fs.rmSync(planted);
ok(/^IMPORT-FAILED ERR_MODULE_NOT_FOUND/.test(control), `control: a planted import of a missing package fails (${control.slice(0, 60)})`);

const results = files.map((f) => [path.relative(copy, f), importIn(f)]);
const bad = results.filter(([, r]) => r !== 'IMPORTED');
ok(files.length > 50 && bad.length === 0, `${results.length - bad.length}/${results.length} packaged dist files import under the packaged Electron runtime`);
for (const [f, r] of bad) console.error(`      ${f}: ${r}`);
const ratchet = results.find(([f]) => f === path.join('dist', 'ratchet', 'ratchet.js'));
ok(!!ratchet && ratchet[1] === 'IMPORTED', `dist/ratchet/ratchet.js in particular: ${ratchet ? ratchet[1] : 'not packaged'}`);

const shipped = fs.readdirSync(path.join(copy, 'node_modules'), { withFileTypes: true }).flatMap((e) =>
  e.name.startsWith('@') ? fs.readdirSync(path.join(copy, 'node_modules', e.name)).map((n) => `${e.name}/${n}`) : [e.name]);
console.log(`  packaged gmp-core/node_modules: ${shipped.join(', ')}`);
ok(!shipped.some((n) => /signalapp|libsignal/i.test(n)) && shipped.length > 0, 'libsignal is not among them');

fs.rmSync(tmp, { recursive: true, force: true });
done();
