/**
 * Rebuild everything the desktop app loads from outside electron/ before it
 * runs or is packaged, so neither can pick up a stale build:
 *   - app.bundle.js (repo root, esbuild of index-entry.js), loaded by index.html
 *   - gmp-core/dist (tsc), the node and the bridge main.js imports
 * index.html itself is not a build output: `npm start` loads the checkout's
 * copy directly (main.js resolveResource) and packaging copies it at package
 * time. Any build failure exits non-zero, which stops start/packaging.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const repo = path.join(__dirname, '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

run(['run', '--silent', 'build'], repo);
run(['run', '--silent', 'build'], path.join(repo, 'gmp-core'));
