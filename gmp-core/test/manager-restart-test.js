/**
 * A failed GMPNodeManager.start() (here EADDRINUSE) must leave the manager
 * restartable.
 *
 * Run with: node test/manager-restart-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import net from 'net';

import { GMPNodeManager } from '../dist/gmp-node-manager.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

const PORT = 47431;
const blocker = net.createServer().listen(PORT, '::');
await new Promise((r) => blocker.once('listening', r));

const manager = new GMPNodeManager({ seedPhrase: 'manager restart test seed', port: PORT, GMP_PORT: PORT, GMP_METRICS_PORT: 47432 });

let firstError = null;
try { await manager.start(); } catch (e) { firstError = e; }
assert(firstError !== null, 'start() fails while the port is taken');
assert(manager.node === null, 'a failed start() leaves no half-started node behind');

await new Promise((r) => blocker.close(r));

let retryError = null;
try { await manager.start(); } catch (e) { retryError = e; }
assert(retryError === null, `start() succeeds once the port is free${retryError ? ` (got: ${retryError.message})` : ''}`);
assert(manager.node !== null && !!manager.node.identity, 'the restarted node has an identity');

await manager.stop();
console.log(`Results: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
