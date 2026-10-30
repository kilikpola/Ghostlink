/**
 * Child process for ratchet-init-test.js (task R6): real SIGKILL crashes while
 * initiating a session (kind 0x02) and while accepting one. Driven by one JSON
 * argument:
 *
 *   { action: 'initiate-send' | 'accept', dir, anchorFile, sealKey, self: { priv, pub, nodeId },
 *     peer, peerStaticPub, crashAt?: { point, index }, keysOut, releasedOut, messagesIn? }
 *
 * Every root key, every message key and every released ciphertext / plaintext
 * is appended durably before anything else happens, so the record survives.
 */
import crypto from 'crypto';
import fs from 'fs';
import { openRatchetStore } from '../../dist/ratchet/ratchet-store.js';
import { fileAnchor, appendDurable, readLines } from './ratchet-store-helpers.mjs';

const job = JSON.parse(process.argv[2]);
const out = (o) => fs.writeSync(1, JSON.stringify(o) + '\n');
const deps = { rng: (n) => new Uint8Array(crypto.randomBytes(n)), now: () => job.now ?? Date.now() };
let index = 0;
const checkpoint = (point) => {
  if (job.crashAt && job.crashAt.point === point && job.crashAt.index === index) process.kill(process.pid, 'SIGKILL');
};
const observe = {
  onMessageKey: (op, k) => appendDurable(job.keysOut, `${op} ${k}`),
  onRootKey: (role, k) => appendDurable(job.keysOut, `root-${role} ${k}`),
};
const identity = { staticPrivKey: Buffer.from(job.self.priv, 'hex'), staticPubKey: Buffer.from(job.self.pub, 'hex'), nodeIdHex: job.self.nodeId };
const store = openRatchetStore({ dir: job.dir, sealKey: Buffer.from(job.sealKey, 'hex'), anchor: fileAnchor(job.anchorFile).provider, identity, checkpoint });
out({ opened: true, startup: store.startup, info: store.sessionInfo(job.peer) });
const peerStaticPub = Buffer.from(job.peerStaticPub, 'hex');

if (job.action === 'initiate-send') {
  if (!store.sessionInfo(job.peer).sending) store.initiate(job.peer, { peerStaticPub }, deps, { observe });
  index = 1;
  for (let i = 0; i < job.count; i++, index++) {
    const msg = store.send(job.peer, new TextEncoder().encode(`${job.tag}-${i}`), deps, { observe });
    appendDurable(job.releasedOut, Buffer.from(msg).toString('hex'));
  }
  out({ info: store.sessionInfo(job.peer) });
} else if (job.action === 'accept') {
  const results = [];
  for (const hex of readLines(job.messagesIn)) {
    const r = store.receive(job.peer, Buffer.from(hex, 'hex'), deps, { peerStaticPub, observe });
    if (r.ok) appendDurable(job.releasedOut, Buffer.from(r.plaintext).toString('utf8'));
    results.push(r.ok ? 'ok' : r.reason);
    index++;
  }
  out({ results, info: store.sessionInfo(job.peer) });
}
store.close();
process.exit(0);
