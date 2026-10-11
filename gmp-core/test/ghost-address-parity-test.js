/**
 * index.html inlines a copy of gmp-core/src/ghost-address.js. This extracts
 * those functions and checks them against the module over random NodeIDs and
 * mangled user input.
 */

import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import crypto from 'crypto';
import {
  ghostAddressFromNodeId,
  normalizeGhostAddress,
  isGhostAddress,
  isNodeIdHex,
  GHOST_ADDRESS_ALPHABET
} from '../dist/ghost-address.js';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(resolve(projectRoot, 'index.html'), 'utf8');

/** Pull one top-level `const NAME = ...;` or `function NAME(...) {...}` out of index.html. */
function extractDeclaration(source, header) {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer contains: ${header}`);

  // Constants are single-line; functions run to the first closing brace at
  // column 0, which is how every top-level function in that file is formatted.
  if (header.startsWith('const')) {
    const end = source.indexOf('\n', start);
    return source.slice(start, end);
  }
  const end = source.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`Could not find the end of: ${header}`);
  return source.slice(start, end + 3);
}

const inlinedSource = [
  extractDeclaration(html, 'const GHOST_ADDRESS_ALPHABET ='),
  extractDeclaration(html, 'const GHOST_ADDRESS_LENGTH ='),
  extractDeclaration(html, 'const GHOST_ADDRESS_PATTERN ='),
  extractDeclaration(html, 'const NODE_ID_PATTERN ='),
  extractDeclaration(html, 'function ghostAddressFromNodeId('),
  extractDeclaration(html, 'function normalizeGhostAddress('),
  extractDeclaration(html, 'function isGhostAddress('),
  extractDeclaration(html, 'function isNodeIdHex(')
].join('\n\n');

// eslint-disable-next-line no-new-func
const inlined = new Function(`
  ${inlinedSource}
  return {
    GHOST_ADDRESS_ALPHABET,
    ghostAddressFromNodeId,
    normalizeGhostAddress,
    isGhostAddress,
    isNodeIdHex
  };
`)();

const randomNodeId = () => crypto.randomBytes(64).toString('hex');

console.log('=== Ghost Address Parity (index.html ↔ gmp-core) ===\n');

console.log('[1] The inlined copy was found and is loadable');
assert(inlinedSource.length > 500, 'all eight declarations extracted from index.html');
assert(inlined.GHOST_ADDRESS_ALPHABET === GHOST_ADDRESS_ALPHABET, 'alphabets are identical');

console.log('\n[2] Derivation agrees over 5000 random NodeIDs');
let derivationMismatch = null;
for (let i = 0; i < 5000 && !derivationMismatch; i++) {
  const nodeId = randomNodeId();
  const a = ghostAddressFromNodeId(nodeId);
  const b = inlined.ghostAddressFromNodeId(nodeId);
  if (a !== b) derivationMismatch = { nodeId, module: a, inline: b };
}
assert(!derivationMismatch, derivationMismatch
  ? `derivation diverged: ${derivationMismatch.nodeId.slice(0, 16)}… module=${derivationMismatch.module} inline=${derivationMismatch.inline}`
  : 'every derived address matches');

console.log('\n[3] Normalisation agrees over mangled user input');
const manglers = [
  (s) => s,
  (s) => s.toLowerCase(),
  (s) => s.replace(/-/g, ''),
  (s) => s.replace('GHOST-', ''),
  (s) => `  ${s}  `,
  (s) => s.replace(/0/g, 'O').replace(/1/g, 'I'),
  (s) => s.replace(/0/g, 'o').replace(/1/g, 'l'),
  (s) => s.split('').join(' '),
  (s) => s.slice(0, -1),
  (s) => `${s}X`,
  (s) => s.replace('GHOST', 'ghost_'),
];
let normalizeMismatch = null;
for (let i = 0; i < 800 && !normalizeMismatch; i++) {
  const address = ghostAddressFromNodeId(randomNodeId());
  for (const mangle of manglers) {
    const input = mangle(address);
    const a = normalizeGhostAddress(input);
    const b = inlined.normalizeGhostAddress(input);
    if (a !== b) { normalizeMismatch = { input, module: a, inline: b }; break; }
  }
}
assert(!normalizeMismatch, normalizeMismatch
  ? `normalisation diverged on "${normalizeMismatch.input}": module=${normalizeMismatch.module} inline=${normalizeMismatch.inline}`
  : 'every normalised input matches');

console.log('\n[4] Predicates agree on non-address input');
const junk = ['', 'GL-ABC123', 'GLWS-xyz', 'null', '0'.repeat(128), 'GHOST-', 'GHOST-AAA-BBB-CCC',
  'not an address', '{"c":"GHOST-AAA-BBB-CCC"}', randomNodeId(), randomNodeId().slice(0, 64)];
let predicateMismatch = null;
for (const value of junk) {
  if (isGhostAddress(value) !== inlined.isGhostAddress(value)) predicateMismatch = `isGhostAddress("${value}")`;
  if (isNodeIdHex(value) !== inlined.isNodeIdHex(value)) predicateMismatch = `isNodeIdHex("${value}")`;
  if (normalizeGhostAddress(value) !== inlined.normalizeGhostAddress(value)) predicateMismatch = `normalizeGhostAddress("${value}")`;
}
assert(!predicateMismatch, predicateMismatch ? `diverged on ${predicateMismatch}` : 'predicates agree on junk input');

console.log(`\n=== ${testsPassed}/${testsRun} passed, ${testsFailed} failed ===`);
process.exit(testsFailed === 0 ? 0 : 1);
