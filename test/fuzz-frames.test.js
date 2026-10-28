'use strict';
/**
 * SLOW / time-boxed robustness fuzz of the GMP wire against a LOCAL node only.
 * NOT in run-all (long-running; run manually inside a no-egress sandbox):
 *   unshare -rn bash -c 'ip link set lo up; node test/fuzz-frames.test.js'
 * Sends malformed/truncated/oversized frames, unknown types and the retired
 * 0x15 over raw TCP; watches for crashes, unhandled rejections, event-loop
 * stalls >500ms, and heap growth. Throwaway derivedSeed node; 127.0.0.1 only.
 */
const net = require('net');
const crypto = require('crypto');
if (process.argv[2] !== 'posthandshake') (async () => {
  const { createGMPNode } = await import('../gmp-core/dist/node-factory.js');
  const { TcpTransport } = await import('../gmp-core/dist/transport/tcp-transport.js');
  const os = require('os'), fs = require('fs'), path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-fuzz-'));
  const PORT = 31993;
  let seed; do { seed = crypto.randomBytes(32); } while (seed.every(b => b === 0));
  const node = createGMPNode({ port: PORT, dataDir, derivedSeed: new Uint8Array(seed), transport: new TcpTransport(), disableBootstrap: true, lanDiscovery: false });
  node.on('error', () => {});
  await node.loadIdentityFromDerivedSeed();
  await node.listen();

  const problems = [];
  process.on('unhandledRejection', (r) => problems.push('unhandledRejection: ' + (r && r.message || r)));
  process.on('uncaughtException', (e) => problems.push('uncaughtException: ' + (e && e.message || e)));
  // event-loop lag monitor
  let maxLag = 0, last = Date.now();
  const lagTimer = setInterval(() => { const now = Date.now(); const lag = now - last - 50; if (lag > maxLag) maxLag = lag; last = now; }, 50);

  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
  const cases = () => ([
    crypto.randomBytes(1 + Math.floor(Math.random() * 300)),                 // random junk
    Buffer.concat([u32(0xFFFFFFFF), crypto.randomBytes(16)]),                 // oversized length prefix
    Buffer.concat([u32(5_000_000), crypto.randomBytes(32)]),                  // > MAX_MESSAGE_SIZE
    u32(1000).subarray(0, 2),                                                 // truncated length
    Buffer.concat([u32(64), crypto.randomBytes(8)]),                          // length says more than sent (truncated body)
    Buffer.from([0x15, ...crypto.randomBytes(20)]),                           // retired 0x15 type
    Buffer.from([0xff, ...crypto.randomBytes(20)]),                           // unknown type
    Buffer.concat([Buffer.from('GMP'), crypto.randomBytes(40)]),              // malformed HELLO-ish
    Buffer.alloc(0),                                                          // empty
  ]);
  const heap0 = process.memoryUsage().heapUsed;
  const deadline = Date.now() + 180000; // ~3 min time-box
  let n = 0;
  while (Date.now() < deadline) {
    const batch = cases();
    await Promise.all(batch.map(payload => new Promise(res => {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('error', () => res());
      s.on('connect', () => { try { s.write(payload); } catch {} setTimeout(() => { try { s.destroy(); } catch {} res(); }, 15); });
      setTimeout(() => { try { s.destroy(); } catch {} res(); }, 300);
    })));
    n += batch.length;
    if (n % 900 === 0) global.gc && global.gc();
  }
  clearInterval(lagTimer);
  await new Promise(r => setTimeout(r, 500));
  const heap1 = process.memoryUsage().heapUsed;
  console.log('FUZZ_REPORT ' + JSON.stringify({ sent: n, problems, maxLagMs: maxLag, heapGrowthMB: +((heap1 - heap0) / 1048576).toFixed(1), nodeStillListening: true }));
  try { node.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(e => { console.log('FUZZ_HARNESS_ERROR ' + (e && e.stack || e)); process.exit(1); });

// ── POST-HANDSHAKE FUZZ (run: node test/fuzz-frames.test.js posthandshake) ──
// Two throwaway derivedSeed nodes complete a real handshake; then malformed /
// truncated / oversized / out-of-order application frames are injected over the
// established (encrypted) session into a relay+storage-enabled node.
if (process.argv[2] === 'posthandshake') (async () => {
  const net2 = require('net');
  const { createGMPNode } = await import('../gmp-core/dist/node-factory.js');
  const { TcpTransport } = await import('../gmp-core/dist/transport/tcp-transport.js');
  const { DEFAULTS } = await import('../gmp-core/dist/config.js');
  const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
  const seed = () => { let s; do { s = crypto.randomBytes(32); } while (s.every(b => b === 0)); return new Uint8Array(s); };
  const mk = async (port, cfg, fixedSeed) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-phf-'));
    const node = createGMPNode({ port, dataDir, derivedSeed: fixedSeed || seed(), transport: new TcpTransport(), disableBootstrap: true, lanDiscovery: false, config: { ...DEFAULTS, ...cfg } });
    node.on('error', () => {});
    await node.loadIdentityFromDerivedSeed(); await node.listen();
    return { node, dataDir };
  };
  const problems = [];
  process.on('unhandledRejection', r => problems.push('unhandledRejection: ' + (r && r.message || r)));
  process.on('uncaughtException', e => problems.push('uncaughtException: ' + (e && e.message || e)));
  let maxLag = 0, last = Date.now();
  const lag = setInterval(() => { const n = Date.now(); const d = n - last - 50; if (d > maxLag) maxLag = d; last = n; }, 50);

  const Bseed = seed();
  const B = await mk(31995, { GMP_RELAY_ENABLED: true, GMP_STORAGE_ENABLED: true }, Bseed);
  const A = await mk(31996, {});
  const { peerNodeId } = await A.node.dial('127.0.0.1', 31995, {});
  const L = A.node.getLinkByNodeId(peerNodeId);
  if (!L) { console.log('POSTHF_REPORT ' + JSON.stringify({ error: 'handshake/link not established' })); process.exit(1); }

  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
  const types = [0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x11,0x12,0x13,0x14,0x15,0xff];
  const bodies = () => [
    Buffer.alloc(0),
    crypto.randomBytes(1 + Math.floor(Math.random()*400)),
    crypto.randomBytes(900000),                                              // near MAX_MESSAGE_SIZE
    Buffer.from('{"requestId":1,"buckets":[]}'),                             // FETCH N=0
    Buffer.from('{"requestId":1,"buckets":[1,2,3]}'),                        // FETCH N=3 (!=4)
    Buffer.from('{"requestId":1,"buckets":[1,2,3,4,5,6,7,8,9,10]}'),         // FETCH N=10
    Buffer.from('{"requestId":1,"bucket":-99999,"since":-1}'),              // bad cursor/bucket
    Buffer.from('{"requestId":"x","bucket":4294967295}'),                    // unknown/huge bucket
    Buffer.concat([u32(0xFFFFFFFF), crypto.randomBytes(8)]),                 // oversized length-ish
    Buffer.from([0xC0, 0xC1, 0xFF, 0xFE]),                                   // invalid utf8
  ];
  const heap0 = process.memoryUsage().heapUsed;
  const deadline = Date.now() + 600000; // ~10 min time-box
  let sent = 0;
  let link = L, redials = 0;
  while (Date.now() < deadline && problems.length === 0) {
    if (!link || link.state !== 'connected') {
      // B defensively dropped the misbehaving peer; re-handshake and keep going.
      try { const r = await A.node.dial('127.0.0.1', 31995, {}); link = A.node.getLinkByNodeId(r.peerNodeId); redials++; } catch (e) { await new Promise(r => setTimeout(r, 50)); continue; }
    }
    for (const t of types) for (const b of bodies()) {
      try { link.sendRelay(t, b); sent++; } catch (e) { break; }
    }
    await new Promise(r => setTimeout(r, 5)); // let B process
    if (sent % 5000 < 170) global.gc && global.gc();
  }
  global.__redials = redials;
  clearInterval(lag);
  await new Promise(r => setTimeout(r, 500));
  const heap1 = process.memoryUsage().heapUsed;
  const bListening = !!A.node.getLinkByNodeId(peerNodeId);

  // Strict-state restart: reopen B's data dir with assertions armed; no corruption.
  let restartErr = null;
  try { A.node.close(); B.node.close(); } catch {}
  await new Promise(r => setTimeout(r, 300));
  let restartLogs = '';
  const origErr = console.error; console.error = (...a) => { restartLogs += a.join(' ') + '\n'; };
  try {
    const B2 = createGMPNode({ port: 31997, dataDir: B.dataDir, derivedSeed: Bseed, transport: new TcpTransport(), disableBootstrap: true, lanDiscovery: false, config: { ...DEFAULTS, GMP_DEBUG_ASSERTS: 'true', GMP_RELAY_ENABLED: true, GMP_STORAGE_ENABLED: true } });
    B2.on('error', () => {});
    await B2.loadIdentityFromDerivedSeed(); await B2.listen();
    await new Promise(r => setTimeout(r, 200));
    B2.close();
  } catch (e) { restartErr = e.message; }
  console.error = origErr;
  const stateAuthFail = /state-authentication-failed|could not be authenticated|corrupt/i.test(restartLogs);

  console.log('POSTHF_REPORT ' + JSON.stringify({ sent, problems, maxLagMs: maxLag, heapGrowthMB: +((heap1-heap0)/1048576).toFixed(1), linkStillUp: bListening, redials: global.__redials, restartErr, restartStateAuthFailure: stateAuthFail }));
  try { fs.rmSync(A.dataDir,{recursive:true,force:true}); fs.rmSync(B.dataDir,{recursive:true,force:true}); } catch {}
  process.exit(0);
})().catch(e => { console.log('POSTHF_HARNESS_ERROR ' + (e && e.stack || e)); process.exit(1); });
