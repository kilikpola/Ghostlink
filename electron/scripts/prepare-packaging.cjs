/**
 * Before electron-builder: rebuild the renderer bundle and gmp-core/dist
 * (build-inputs.cjs) so the copies extraResources takes are current.
 *
 * Then the workaround for electron-builder + npm workspaces: with hoisted
 * dependencies electron/node_modules never exists, so electron-builder runs a
 * production install that prunes dev dependencies it then needs. Creating the
 * directory makes it skip that step.
 *
 * Last, stage gmp-core's runtime node_modules (R4b). The packaged gmp-core/dist
 * resolves its imports from resources/gmp-core/node_modules only, so that
 * directory must hold every runtime dependency of gmp-core and nothing else.
 * It used to be a hand-written list in extraResources, which missed
 * @noble/ciphers (ratchet.js failed with ERR_MODULE_NOT_FOUND outside the
 * checkout). The set now comes from gmp-core's own lockfile: every installed
 * package not marked dev, copied from gmp-core/node_modules (the versions
 * gmp-core is built and tested with). devDependencies — libsignal among them
 * (AGPL, test-only) — are never copied.
 */
const fs = require('fs');
const path = require('path');

require('./build-inputs.cjs');
fs.mkdirSync(__dirname + '/../node_modules', { recursive: true });

const gmp = path.join(__dirname, '..', '..', 'gmp-core');
const staging = path.join(__dirname, '..', 'build-staging', 'gmp-core-node_modules');

function stageGmpRuntimeDeps() {
  const lock = JSON.parse(fs.readFileSync(path.join(gmp, 'package-lock.json'), 'utf8'));
  const direct = Object.keys(JSON.parse(fs.readFileSync(path.join(gmp, 'package.json'), 'utf8')).dependencies || {});
  const runtime = Object.entries(lock.packages || {})
    .filter(([key, v]) => key.startsWith('node_modules/') && !v.dev && !v.devOptional && !v.extraneous);
  const keys = new Set(runtime.map(([key]) => key));
  const missingDirect = direct.filter((name) => !keys.has(`node_modules/${name}`));
  if (missingDirect.length) throw new Error(`gmp-core lockfile has no runtime entry for ${missingDirect.join(', ')}`);
  const agpl = runtime.filter(([key]) => /@signalapp\//.test(key));
  if (agpl.length) throw new Error(`refusing to package ${agpl.map(([k]) => k).join(', ')}: libsignal must stay a devDependency`);

  fs.rmSync(staging, { recursive: true, force: true });
  for (const [key, v] of runtime) {
    const from = path.join(gmp, key);
    const pj = path.join(from, 'package.json');
    if (!fs.existsSync(pj)) throw new Error(`gmp-core/${key} is not installed — run \`npm run install:gmp\` first`);
    const installed = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    if (installed !== v.version) throw new Error(`gmp-core/${key} is ${installed}, lockfile says ${v.version} — run \`npm run install:gmp\``);
    // Nested node_modules are copied by their own lockfile entries (dev ones never).
    fs.cpSync(from, path.join(staging, key.slice('node_modules/'.length)), {
      recursive: true,
      filter: (src) => path.relative(from, src).split(path.sep)[0] !== 'node_modules',
    });
  }
  console.log(`[prepare-packaging] staged gmp-core runtime deps: ${runtime.map(([k, v]) => `${k.slice(13)}@${v.version}`).join(', ')}`);
}

stageGmpRuntimeDeps();
