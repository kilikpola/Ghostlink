/**
 * Workaround for electron-builder + npm workspaces: with hoisted dependencies
 * electron/node_modules never exists, so electron-builder runs a production
 * install that prunes dev dependencies it then needs. Creating the directory
 * makes it skip that step.
 */
const fs = require('fs');
fs.mkdirSync(__dirname + '/../node_modules', { recursive: true });
