#!/usr/bin/env node
/**
 * Generate a seed phrase for an unattended host without printing it:
 *
 *   node gmp-core/scripts/new-public-peer-seed.mjs <out-file>
 *
 * Writes <out-file> fresh with mode 0600 (refuses existing files and paths
 * inside the repository) and prints only the NodeID and Ghost Address. Copy
 * the contents into the host's GMP_SEED_PHRASE, then delete the file.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dist = (f) => import(pathToFileURL(path.join(here, '..', 'dist', f)).href);

const out = process.argv[2];
if (!out) {
  console.error('usage: new-public-peer-seed.mjs <out-file>   (outside the repository)');
  process.exit(2);
}
const outPath = path.resolve(out);
const rel = path.relative(repoRoot, outPath);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error(`refusing to write a seed phrase inside the repository (${outPath})`);
  process.exit(2);
}

const { generateSeedPhrase } = await dist('seed-phrase.js');
const { deriveIdentityFromSeedPhrase, bytesToHex } = await dist('identity.js');
const { ghostAddressFromNodeId } = await dist('ghost-address.js');

const phrase = generateSeedPhrase();
const identity = await deriveIdentityFromSeedPhrase(phrase);
// 'wx': fail if the file exists, so an old phrase is never overwritten unseen.
fs.writeFileSync(outPath, phrase + '\n', { mode: 0o600, flag: 'wx' });

const nodeId = bytesToHex(identity.nodeId);
console.log(`seed phrase written to ${outPath} (mode 0600; not printed)`);
console.log(`NodeID: ${nodeId}`);
console.log(`ghost address: ${ghostAddressFromNodeId(nodeId)}`);
