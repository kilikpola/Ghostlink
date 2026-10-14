import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { createGMPNode } from '../dist/node-factory.js';
import { bytesToHex } from '../dist/identity.js';
import { x25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

// A4: the `derivedSeed` factory option. A supported way to build a node from an
// already-KDF'd 32-byte seed (mobile derives it natively; tests use it for
// deterministic identities). Raw bytes only; option-object only; validated.

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function assertThrows(fn, rx, msg) {
  try { fn(); assert(false, `${msg} (did not throw)`); }
  catch (e) { assert(rx.test(e.message), `${msg} (threw: ${e.message})`); }
}
function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-ds-${tag}-`)); }

// Independent recompute of the NodeID from a seed: NodeID = SHA-512(X25519 pub).
// Deliberately does NOT call identityFromDerivedSeed — it checks it.
function expectedNodeIdHex(seed) { return bytesToHex(sha512(x25519.getPublicKey(seed))); }

function run() {
  // 1) The option takes effect: identity derives from the raw seed.
  const seed = new Uint8Array(crypto.randomBytes(32)); // non-zero w.h.p.
  const node = createGMPNode({ derivedSeed: seed, port: 0, disableBootstrap: true, dataDir: tmp('opt') });
  node.loadIdentityFromDerivedSeed();
  assert(node.identity.nodeIdHex === expectedNodeIdHex(seed),
    'NodeID equals SHA-512 of the X25519 pubkey derived from derivedSeed (independent recompute)');

  // 2) It cannot be set via `config` (the file/env channel): placing it in config
  //    is ignored; only the option takes effect.
  const seed2 = new Uint8Array(crypto.randomBytes(32));
  const phrase = 'derived seed must not come from a config file v1';
  // createGMPNode strips derivedSeed before config resolution, and config only
  // carries GMP_* keys anyway, so a seed in `config` never reaches identity.
  const viaConfig = createGMPNode({
    config: { derivedSeed: seed2 }, seedPhrase: phrase, port: 0, disableBootstrap: true, dataDir: tmp('cfg'),
  });
  // Would throw if the config path were (wrongly) treated as a real derivedSeed
  // alongside the seed phrase — it must not, proving config is not that channel.
  return viaConfig.loadIdentity(phrase).then(() => {
    // Positive control first (the channel that WOULD show it working): the option
    // path above demonstrably produced the seed's identity.
    assert(node.identity.nodeIdHex === expectedNodeIdHex(seed),
      'positive control: the derivedSeed OPTION does set the identity');
    assert(viaConfig.identity.nodeIdHex !== expectedNodeIdHex(seed2),
      'a derivedSeed placed in `config` does NOT set the identity (not an env/config channel)');
    assert(viaConfig.identity.nodeIdHex !== expectedNodeIdHex(seed),
      'the config node uses its seed phrase, not any derivedSeed');

    // 3) Each refusal fires its named error.
    const nonZero = new Uint8Array(crypto.randomBytes(32));
    assertThrows(() => createGMPNode({ derivedSeed: nonZero, seedPhrase: 'x', port: 0 }),
      /not both/, 'refuses seedPhrase AND derivedSeed together');
    assertThrows(() => createGMPNode({ derivedSeed: new Uint8Array(16), port: 0 }),
      /exactly 32 bytes/, 'refuses a seed whose length is not 32');
    assertThrows(() => createGMPNode({ derivedSeed: new Uint8Array(32), port: 0 }),
      /all-zero/, 'refuses an all-zero seed (0 must not look valid)');
    assertThrows(() => createGMPNode({ derivedSeed: { nodeId: 'deadbeef' }, port: 0 }),
      /Uint8Array/, 'refuses an identity object (raw bytes only)');

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}

run();
