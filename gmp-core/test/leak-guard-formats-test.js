import './helpers/isolate-data.mjs'; // must stay first
import { createGMPNode } from '../dist/node-factory.js';
import logger from '../dist/logger.js';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function tmp(t) { return fs.mkdtempSync(path.join(os.tmpdir(), `gl-leak-${t}-`)); }

// Every representation of 32 bytes that can land in a log line.
function forms(buf) {
  const b = Array.from(buf);
  return {
    hex: buf.toString('hex'),                                      // contiguous hex (string in msg)
    'buffer-inspect': b.map((x) => x.toString(16).padStart(2, '0')).join(' '), // "<Buffer 1a 2b ..>" body
    base64: buf.toString('base64'),
    base64url: buf.toString('base64url'),
    'json-array': b.join(','),                                     // JSON/Buffer data array: "26,43,.."
    'inspect-decimal': b.join(', '),                               // util.inspect / toString body: "26, 43, .."
  };
}

const orig = { log: console.log, warn: console.warn, error: console.error };
function capture() { const lines = []; console.log = console.warn = console.error = (s) => lines.push(String(s)); return lines; }
function release() { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }

function run() {
  // A derivedSeed node registers its raw seed's byte formats with the leak guard.
  const seed = new Uint8Array(crypto.randomBytes(32));
  const node = createGMPNode({ derivedSeed: seed, port: 0, disableBootstrap: true, dataDir: tmp('n') });
  node.loadIdentityFromDerivedSeed();
  logger.configure({ toConsole: true });

  const seedForms = forms(Buffer.from(seed));
  const otherForms = forms(crypto.randomBytes(32)); // an UNRELATED array, same formats

  console.log('\n=== item 4: the registered seed is withheld in every byte format ===');
  for (const [name, val] of Object.entries(seedForms)) {
    const lines = capture();
    logger.warn('leak', `probe-${name}`, `before ${val} after`);
    release();
    const withheld = lines.some((l) => /"event":"log-withheld"/.test(l));
    assert(withheld, `the seed in ${name} form is withheld from the log`);
  }

  console.log('\n--- negative control: an unrelated byte array in the same formats is NOT withheld ---');
  for (const [name, val] of Object.entries(otherForms)) {
    const lines = capture();
    logger.warn('leak', `probe-ctl-${name}`, `before ${val} after`);
    release();
    const withheld = lines.some((l) => /"event":"log-withheld"/.test(l));
    const emitted = lines.some((l) => new RegExp(`"event":"probe-ctl-${name}"`).test(l)); // positive control: the channel did emit
    assert(emitted && !withheld, `an unrelated array in ${name} form passes through (guard is specific, not blanket)`);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
