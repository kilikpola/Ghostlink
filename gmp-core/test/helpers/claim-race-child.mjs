/**
 * One contender in claim-lock-race-test. Opens the shared NonceStore, waits for
 * the common start time, then claims the same fingerprints every other
 * contender claims, in the same order, and prints the ones it was told it won.
 *
 *   node claim-race-child.mjs <distDir> <stateFile> <seed> <startAtMs> <count>
 */
import path from 'path';
import { pathToFileURL } from 'url';

const [distDir, stateFile, seed, startAt, count] = process.argv.slice(2);
const { NonceStore } = await import(pathToFileURL(path.join(distDir, 'nonce-store.js')).href);

const store = new NonceStore({ stateFile, seedPhrase: seed, lockTimeoutMs: 20000 });
const peer = Buffer.alloc(64, 7);
const fps = Array.from({ length: Number(count) }, (_, i) => i.toString(16).padStart(32, '0'));

while (Date.now() < Number(startAt)) { /* spin to the common start */ }

const won = [];
for (const fp of fps) {
  // The fast path (has()) is skipped by nothing: this is claimSessionKey as a
  // handshake calls it.
  if (store.claimSessionKey(peer, fp).valid) won.push(fp);
}
console.log(`WON ${won.join(',')}`);
process.exit(0);
