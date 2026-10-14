import './helpers/isolate-data.mjs'; // must stay first
import { BlobStore } from '../dist/storage/blob-store.js';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gl-evict-')); }

function run() {
  console.log('\n=== Part 1: eviction is by deposit time; re-fetching cannot protect a blob ===');
  // Advancing clock so reads carry a later timestamp than deposits — under the
  // OLD lastAccess policy that would move a re-read blob to the back of the
  // eviction line. Count cap small (4) so bytes never bind.
  let t = 1000;
  const store = new BlobStore({
    dir: tmp(), ttlMs: 30 * 24 * 3600 * 1000, maxBlobsPerBucket: 4, maxBytesPerBucket: 16 * 1024 * 1024,
    clock: () => ++t,
  });
  store.load();

  // A flooder fills the bucket to its cap, in deposit order [A,B,C,D].
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(store.put(0, Buffer.alloc(4096)).blobId);

  // It then re-fetches its OLDEST blob (A) many times to try to keep it alive.
  for (let k = 0; k < 20; k++) store.read(ids[0]);

  // An honest blob arrives; the full bucket must evict exactly one.
  const res = store.put(0, Buffer.alloc(4096));

  assert(res.evicted.length === 1, 'positive control: the full bucket evicted exactly one blob'); // channel alive
  assert(res.evicted.includes(ids[0]), 're-fetched OLDEST-deposited blob is the one evicted (deposit-time order)');
  assert(store.read(ids[0]) === null, 'the re-fetched oldest blob is gone — re-fetching did not protect it');
  assert(store.read(ids[1]) !== null, 'the next-oldest, never-re-read blob survived');
  const present = store.list(0).map((m) => m.blobId);
  assert(present.includes(res.blobId) && present.length === 4, 'the honest blob is stored');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
