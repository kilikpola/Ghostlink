/**
 * GMP_STRICT_STATE and state files that will not authenticate: by default an
 * ERROR and continue; strict mode refuses. Also checks the refusal is not
 * swallowed by load(), and that a missing or healthy file is not escalated.
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import os from 'os';
import path from 'path';

const GMP = new URL('../dist/', import.meta.url).href;
const { NonceStore } = await import(`${GMP}nonce-store.js`);
const { PeerCache }  = await import(`${GMP}peer-cache.js`);

const SEED = 'strict mode probe seed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-strict-'));
let n = 0;
let pass = 0, fail = 0;
const ok = (name, c) => { c ? (pass++, console.log(`  ok   ${name}`)) : (fail++, console.log(`  FAIL ${name}`)); };

const corrupt = file => {
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  o.ciphertext = (o.ciphertext.slice(0, 2) === 'ff' ? '00' : 'ff') + o.ciphertext.slice(2);
  fs.writeFileSync(file, JSON.stringify(o));
};

// A freshly corrupted file each time: a non-strict load rewrites the file as a
// valid empty one, so reusing a fixture would hand the next case a healthy file.
const freshNonce = () => {
  const f = path.join(dir, `nonce-${n++}.json`);
  const s = new NonceStore({ stateFile: f, seedPhrase: SEED });
  const peer = new Uint8Array(64); peer.fill(0xAA);
  s.checkNonce(peer, 'fp', 5);
  s.close();
  corrupt(f);
  return f;
};
const freshCache = () => {
  const f = path.join(dir, `cache-${n++}.json`);
  const c = new PeerCache({ filePath: f, seedPhrase: SEED });
  c.recordSuccess('a'.repeat(64), '10.0.0.1', 49500);
  c.close?.();
  corrupt(f);
  return f;
};

console.log('\n[1] Default (strictState off): logs and continues');
let threw = false;
try { new NonceStore({ stateFile: freshNonce(), seedPhrase: SEED, strictState: false }).load(); } catch { threw = true; }
ok('nonce store starts fresh instead of throwing', !threw);
threw = false;
try { new PeerCache({ filePath: freshCache(), seedPhrase: SEED, strictState: false }); } catch { threw = true; }
ok('peer cache starts fresh instead of throwing', !threw);

console.log('\n[2] strictState on: refuses');
let msg = '';
threw = false;
try { new NonceStore({ stateFile: freshNonce(), seedPhrase: SEED, strictState: true }).load(); } catch (e) { threw = true; msg = e.message; }
ok('nonce store refuses a state file it cannot authenticate', threw);
ok('and explains the consequence', /could not be authenticated/.test(msg) && /replay protection/.test(msg));

threw = false; msg = '';
try { new PeerCache({ filePath: freshCache(), seedPhrase: SEED, strictState: true }); } catch (e) { threw = true; msg = e.message; }
ok('peer cache refuses a cache it cannot authenticate', threw);
ok('and explains why', /could not be authenticated/.test(msg));

console.log('\n[3] A healthy file is unaffected by strict mode');
const good = path.join(dir, 'good.json');
const gs = new NonceStore({ stateFile: good, seedPhrase: SEED });
const peer = new Uint8Array(64); peer.fill(0xBB);
gs.checkNonce(peer, 'fp', 7);
gs.close();
threw = false;
try { new NonceStore({ stateFile: good, seedPhrase: SEED, strictState: true }).load(); } catch { threw = true; }
ok('strict mode loads a valid state file normally', !threw);

console.log('\n[4] No file at all is not an error');
threw = false;
try { new NonceStore({ stateFile: path.join(dir, 'absent.json'), seedPhrase: SEED, strictState: true }).load(); } catch { threw = true; }
ok('a missing state file still starts fresh under strict mode', !threw);

console.log(`\n  Results: ${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
