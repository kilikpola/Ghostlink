/**
 * A seed phrase must not be in the repository, next to a revoked identity in
 * a shipped peer list, or in anything a node prints:
 *
 *   1. the detector (src/seed-guard.ts) finds phrases, not ordinary prose;
 *   2. no repository file (tracked, or untracked and not ignored) holds one;
 *   3. no peer list in the tree names a revoked NodeID;
 *   4. the logger withholds a line that would carry a seed phrase;
 *   5. a real `gmp public-peer` at TRACE, through a handshake and shutdown,
 *      prints neither its seed nor any phrase-shaped run.
 *
 * Failures name the file and line, never the phrase.
 *
 * Run: node test/seed-leak-test.js
 */
import './helpers/isolate-data.mjs'; // must stay first: keeps state out of gmp-core/data
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findSeedPhrase, containsSeedPhrase, seedRuns } from '../dist/seed-guard.js';
import { generateSeedPhrase } from '../dist/seed-phrase.js';
import { deriveIdentityFromSeedPhrase, bytesToHex } from '../dist/identity.js';
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };
const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const repo = path.join(core, '..');

/** NodeIDs that must never appear in a peer list again: the list the loader enforces. */
const { REVOKED_NODE_IDS: REVOKED } = await import('../dist/public-peer-list.js');
const REVOKED_NODE_IDS = [...REVOKED];

/**
 * Seed phrases the repository may hold on purpose: NONE. Test fixtures are
 * built at run time from word-list indices (test/helpers/fixture-phrases.mjs),
 * so a phrase-shaped string anywhere in the tree is a leak, never a fixture.
 */
const FIXTURE_NODE_ID_PREFIXES = new Map();

/** The word list itself: runs of list words by construction. */
const WORD_LIST_FILES = new Set(['gmp-core/src/bip39-english.ts']);
/**
 * Third-party minified bundles: 37-58 KB single lines whose short identifiers
 * happen to form runs of list words. Not where this project's secrets live.
 */
const SKIP_DIRS = ['vendor/'];

console.log('\n=== 1. the detector ===');
{
  const phrase = generateSeedPhrase();
  const words = phrase.split(' ');
  assert(findSeedPhrase(`xyzzy: ${phrase}`) === 7, 'finds a space-separated phrase, at its offset');
  assert(findSeedPhrase(JSON.stringify(words)) >= 0, 'finds a JSON array of the words');
  assert(findSeedPhrase(JSON.stringify({ ...words })) >= 0, 'finds the array after an object spread ({"0":"w1",...})');
  assert(findSeedPhrase(words.join('\n')) >= 0, 'finds one word per line');
  assert(findSeedPhrase(phrase.toUpperCase()) >= 0, 'case-insensitive');
  assert(findSeedPhrase(words.slice(0, 11).join(' ')) === -1, '11 words are not a phrase');
  assert(findSeedPhrase(words.slice(0, 6).join(' ') + '. ' + words.slice(6).join(' ')) === -1, 'a sentence break splits the run');
  assert(findSeedPhrase('The node is listening on port 49500 and the bootstrap of the mesh failed to reach a peer.') === -1, 'ordinary log prose is not flagged');
  assert(containsSeedPhrase('x strict role original seed y', ['strict role original seed']), 'a known secret is found verbatim even if not list words');
}

console.log('\n=== 2. no seed phrase in the repository ===');
{
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo, maxBuffer: 1 << 28 })
    .toString().split('\0').filter(Boolean);
  let scanned = 0;
  const found = [];
  for (const f of files) {
    if (WORD_LIST_FILES.has(f) || SKIP_DIRS.some((d) => f.startsWith(d))) continue;
    const abs = path.join(repo, f);
    let text;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 5_000_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue;
    scanned++;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const r of seedRuns(lines[i])) found.push({ where: `${f}:${i + 1}`, words: r.words });
    }
  }
  // A run longer than 12 words (a list word next to a fixture) is accepted if
  // one of its 12-word windows is a named fixture; any revoked window fails.
  const unknown = [];
  const byPhrase = new Map();
  const idOf = async (p) => {
    if (!byPhrase.has(p)) byPhrase.set(p, bytesToHex((await deriveIdentityFromSeedPhrase(p)).nodeId));
    return byPhrase.get(p);
  };
  let fixtures = 0;
  for (const h of found) {
    const ids = [];
    for (let k = 0; k + 12 <= h.words.length; k++) ids.push(await idOf(h.words.slice(k, k + 12).join(' ')));
    if (ids.some((id) => REVOKED_NODE_IDS.includes(id))) unknown.push(`${h.where} holds the REVOKED seed`);
    else if (ids.some((id) => FIXTURE_NODE_ID_PREFIXES.has(id.slice(0, 8)))) fixtures++;
    else unknown.push(`${h.where} (${h.words.length}-word run; derives ${ids[0].slice(0, 16)}…)`);
  }
  console.log(`  scanned ${scanned} files; ${fixtures} fixture run(s)`);
  assert(scanned > 100, `the scan saw the repository (${scanned} files)`);
  assert(unknown.length === 0, `no seed phrase outside the named fixtures${unknown.length ? ':\n      ' + unknown.join('\n      ') : ''}`);
}

console.log('\n=== 3. no revoked NodeID in any peer list ===');
{
  const lists = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/public-peers.*\.jsonc?$/.test(e.name)) lists.push(p);
    }
  };
  walk(repo);
  const hits = lists.filter((p) => REVOKED_NODE_IDS.some((id) => fs.readFileSync(p, 'utf8').toLowerCase().includes(id)));
  assert(lists.length >= 1, `found the peer lists (${lists.map((p) => path.relative(repo, p)).join(', ')})`);
  assertAbsent({
    channel: 'peer list contents',
    control: () => lists.filter((p) => fs.readFileSync(p, 'utf8').includes('562c487c1a10a649')),
    controlMessage: 'the same read finds the NodeID the lists DO carry',
    absent: () => hits.length === 0,
    message: `none names a revoked NodeID${hits.length ? ': ' + hits.map((p) => path.relative(repo, p)).join(', ') : ''}`,
  });
}

console.log('\n=== 4. the logger withholds a line carrying a seed phrase ===');
{
  const { default: logger } = await import('../dist/logger.js');
  const phrase = generateSeedPhrase();
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (s) => lines.push(String(s));
  try {
    logger.error('test', 'leak-msg', `oops ${phrase}`);
    logger.info('test', 'leak-meta', 'meta carries it', { detail: phrase });
    logger.warn('test', 'leak-array', 'array form', { words: phrase.split(' ') });
    logger.info('test', 'clean', 'nothing secret here');
  } finally {
    Object.assign(console, orig);
  }
  assert(lines.length === 4, `every call still produced a line (${lines.length})`);
  assert(lines.every((l) => !containsSeedPhrase(l, [phrase])), 'no emitted line carries the phrase');
  assert(lines.slice(0, 3).every((l) => /"event":"log-withheld"/.test(l)), 'the three leaking lines were replaced by log-withheld');
  assert(/"event":"clean"/.test(lines[3]), 'a clean line is untouched');
}

console.log('\n=== 5. a real public peer prints no seed phrase ===');
{
  const phrase = generateSeedPhrase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-seedleak-'));
  const freePort = async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
  };
  const port = await freePort();
  const env = {
    ...process.env, GMP_SEED_PHRASE: phrase, GMP_DATA_DIR: dataDir, PORT: String(port),
    GMP_METRICS_PORT: String(await freePort()), GMP_BRIDGE_PORT: String(await freePort()),
    GMP_LAN_DISCOVERY: 'false', GMP_LOG_LEVEL: 'TRACE',
  };
  const child = spawn(process.execPath, [path.join(core, 'dist', 'cli.js'), 'public-peer'], { env, cwd: core });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const started = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30_000);
    const check = () => { if (/successfully started/.test(out)) { clearTimeout(t); resolve(true); } else setTimeout(check, 100); };
    check();
  });
  assert(started, 'the public peer started');
  if (started) {
    // A real handshake, so the per-connection paths log too.
    const { createGMPNode } = await import('../dist/node-factory.js');
    const client = createGMPNode({ port: 0, disableBootstrap: true, lanDiscovery: false });
    await client.loadIdentity(generateSeedPhrase());
    let shook = false;
    try { await client.dial('127.0.0.1', port); shook = true; } catch { /* reported below */ }
    assert(shook, 'a client completed a handshake with it');
    await new Promise((r) => setTimeout(r, 500));
    client.close();
  }
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const lines = out.split('\n').length;
  assert(lines > 10, `captured its output (${lines} lines at TRACE)`);
  assert(!out.includes(phrase), 'its own seed phrase is not in the output');
  assert(findSeedPhrase(out) === -1, 'no phrase-shaped run is in the output');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
