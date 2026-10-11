/**
 * Listener errors after a successful bind are logged. The error is emitted on
 * the real TcpTransport's net.Server (libuv absorbs EMFILE on accept, so a
 * descriptor flood cannot trigger this path).
 *
 * Run: node test/listener-error-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import net from 'net';
import { createGMPNode } from '../dist/node-factory.js';
import { generateSeedPhrase } from '../dist/seed-phrase.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const node = createGMPNode({ port: 0, disableBootstrap: true, lanDiscovery: false });
await node.loadIdentity(generateSeedPhrase());
await node.listen();
const server = node.listener && node.listener.server;
assert(server instanceof net.Server && server.listening, 'the node listens on a real net.Server');

console.log('\n=== a server error after listen ===');
const lines = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
let threw = null;
try {
  const err = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', errno: -24, syscall: 'accept' });
  server.emit('error', err);
} catch (e) {
  threw = e;
} finally {
  Object.assign(console, orig);
}
const logged = lines.filter((l) => /"event":"listener-error"/.test(l));
console.log(`  ${logged.length} listener-error line(s)${logged[0] ? `: ${logged[0]}` : ''}`);
assert(!threw, 'does not throw out of the emitter');
assert(logged.length === 1, 'is logged, once');
assert(logged.every((l) => /"level":"ERROR"/.test(l)), 'at ERROR');
assert(logged.some((l) => /EMFILE/.test(l) && /accept/.test(l)), 'with the code and syscall');
assert(logged.some((l) => /"stillListening":true/.test(l)), 'saying whether the listener is still up');

console.log('\n=== the listener still serves ===');
const accepted = await new Promise((resolve) => {
  const s = net.connect(node.port, '127.0.0.1');
  const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
  s.on('error', () => { clearTimeout(t); resolve(false); });
});
assert(accepted, 'a new connection is accepted');

await wait(50);
node.close();
console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
