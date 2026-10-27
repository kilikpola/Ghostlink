/**
 * Before electron-builder: rebuild the renderer bundle and gmp-core/dist
 * (build-inputs.cjs) so the copies extraResources takes are current.
 *
 * Then the workaround for electron-builder + npm workspaces: with hoisted
 * dependencies electron/node_modules never exists, so electron-builder runs a
 * production install that prunes dev dependencies it then needs. Creating the
 * directory makes it skip that step.
 */
const fs = require('fs');
require('./build-inputs.cjs');
fs.mkdirSync(__dirname + '/../node_modules', { recursive: true });
