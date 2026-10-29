/**
 * Child process for ratchet-store-test.js (task R5): a real process that owns
 * the store, so crashes are real SIGKILLs and the two-writer race is two
 * processes. Driven by one JSON argument:
 *
 *   { action: 'send' | 'receive' | 'hold', dir, anchorFile, sealKey (hex), peer,
 *     crashAt?: { point, index }, keysOut?, releasedOut?, statusOut?, ... }
 *
 * Every (key ‖ nonce) the ratchet derives and every ciphertext / plaintext the
 * store releases is appended durably BEFORE anything else can happen, so the
 * record survives the kill.
 */
import crypto from 'crypto';
import fs from 'fs';
import { openRatchetStore } from '../../dist/ratchet/ratchet-store.js';
import { serializeState } from '../../dist/ratchet/ratchet.js';
import { fileAnchor, appendDurable, readLines } from './ratchet-store-helpers.mjs';

const job = JSON.parse(process.argv[2]);
const out = (o) => fs.writeSync(1, JSON.stringify(o) + '\n');
const deps = { rng: (n) => new Uint8Array(crypto.randomBytes(n)), now: () => Date.now() };
let index = -1;
const checkpoint = (point) => {
  if (job.crashAt && job.crashAt.point === point && job.crashAt.index === index) process.kill(process.pid, 'SIGKILL');
};
const observe = { onMessageKey: (op, k) => { if (job.keysOut) appendDurable(job.keysOut, `${op} ${k}`); } };

let store;
try {
  store = openRatchetStore({ dir: job.dir, sealKey: Buffer.from(job.sealKey, 'hex'), anchor: fileAnchor(job.anchorFile).provider, checkpoint });
} catch (e) {
  if (job.statusOut) appendDurable(job.statusOut, `REFUSED ${e.name}`);
  out({ opened: false, error: e.name, message: e.message });
  process.exit(3);
}
out({ opened: true, startup: store.startup });

if (job.action === 'send') {
  if (!store.has(job.peer)) { out({ sent: 0, noSession: true }); store.close(); process.exit(0); }
  for (index = 0; index < job.count; index++) {
    const msg = store.send(job.peer, new TextEncoder().encode(`${job.tag}-${index}`), deps, { observe });
    appendDurable(job.releasedOut, Buffer.from(msg).toString('hex'));
  }
  out({ sent: job.count });
} else if (job.action === 'receive') {
  if (!store.has(job.peer)) { out({ received: 0, noSession: true }); store.close(); process.exit(0); }
  const msgs = readLines(job.messagesIn);
  const results = [];
  for (index = 0; index < msgs.length; index++) {
    const r = store.receive(job.peer, Buffer.from(msgs[index], 'hex'), deps, { observe });
    if (r.ok) appendDurable(job.releasedOut, Buffer.from(r.plaintext).toString('utf8'));
    results.push(r.ok ? 'ok' : r.reason);
  }
  out({ results });
} else if (job.action === 'hold') {
  // The two-writer race: report WON, wait for the parent's go, write once, close.
  appendDurable(job.statusOut, 'WON');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(job.goFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  store.send(job.peer, new TextEncoder().encode(`winner ${process.pid}`), deps);
  appendDurable(job.statusOut, `FINAL ${crypto.createHash('sha256').update(serializeState(store.get(job.peer))).digest('hex')}`);
} else if (job.action === 'die-holding') {
  appendDurable(job.statusOut, 'WON');
  process.kill(process.pid, 'SIGKILL');
}
store.close();
process.exit(0);
