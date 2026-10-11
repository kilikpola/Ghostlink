/**
 * The recovery wordlist must be one list (shared/wordlist.js): every client
 * uses it, gmp-core's generated copy has not drifted, generation is BIP-39
 * only and validation accepts the union.
 *
 * Run with: node test/wordlist-parity.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = await import(path.join(root, 'shared/wordlist.js'));
const web = await import(path.join(root, 'src/utils/bip39.js'));
const mobile = await import(path.join(root, 'mobile/src/utils/wordlist.js'));
const phraseEntry = await import(path.join(root, 'mobile/src/utils/phrase-entry.js'));

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the shared list is the canonical BIP-39 list', () => {
  assert.strictEqual(shared.BIP39_WORDS.length, 2048);
  assert.strictEqual(shared.BIP39_WORDS[0], 'abandon');
  assert.strictEqual(shared.BIP39_WORDS[2047], 'zoo');
  assert.strictEqual(new Set(shared.BIP39_WORDS).size, 2048, 'no duplicates');
});

test('web and mobile import the shared list rather than copying it', () => {
  // Identity, not deep equality: a copy would fail this.
  assert.strictEqual(web.BIP39_WORDS, shared.BIP39_WORDS);
  assert.strictEqual(mobile.WORDLIST, shared.BIP39_WORDS);
  assert.strictEqual(mobile.BIP39_WORDS, shared.BIP39_WORDS);
  assert.strictEqual(mobile.ACCEPTED_WORDS, shared.ACCEPTED_WORDS);
});

test('no client keeps its own wordlist array', () => {
  // A long inline array of quoted words is what the old copies looked like.
  for (const rel of ['src/utils/bip39.js', 'mobile/src/utils/wordlist.js',
                     'mobile/src/utils/phrase-entry.js']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const quoted = (text.match(/'[a-z]{3,}'|"[a-z]{3,}"/g) || []).length;
    assert.ok(quoted < 40, `${rel} looks like it carries its own wordlist (${quoted} quoted words)`);
  }
});

test("gmp-core's generated copy has not drifted from the shared source", () => {
  const ts = fs.readFileSync(path.join(root, 'gmp-core/src/bip39-english.ts'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`export const ${name}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(ts);
    assert.ok(m, `${name} not found in generated file`);
    return m[1].split(',').map(w => w.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  assert.deepStrictEqual(grab('BIP39_WORDS'), [...shared.BIP39_WORDS],
    'run: node scripts-gen-wordlist.mjs');
  assert.deepStrictEqual(grab('LEGACY_ONLY_WORDS'), [...shared.LEGACY_ONLY_WORDS],
    'run: node scripts-gen-wordlist.mjs');
});

test('the CLI draws from the shared list and keeps no excerpt', () => {
  // The generator moved to seed-phrase.ts so operator tooling
  // can use it without running the CLI; cli.ts must use that one generator.
  const cli = fs.readFileSync(path.join(root, 'gmp-core/src/cli.ts'), 'utf8');
  const gen = fs.readFileSync(path.join(root, 'gmp-core/src/seed-phrase.ts'), 'utf8');
  assert.ok(/from '\.\/seed-phrase\.js'/.test(cli), 'cli.ts must import the one generator (seed-phrase.ts)');
  assert.ok(/from '\.\/bip39-english\.js'/.test(gen), 'seed-phrase.ts must import the generated list');
  for (const [name, src] of [['cli.ts', cli], ['seed-phrase.ts', gen]]) {
    assert.ok(!/const BIP39_WORDS[^=]*=\s*\[/.test(src), `${name} must not declare its own wordlist`);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may name the old bug
    assert.ok(!/Math\.random/.test(code), `${name} must not use Math.random`);
  }
});

test('legacy-only words are exactly the 15 non-BIP-39 words from the old mobile list', () => {
  assert.strictEqual(shared.LEGACY_ONLY_WORDS.length, 15);
  const bip = new Set(shared.BIP39_WORDS);
  for (const w of shared.LEGACY_ONLY_WORDS) {
    assert.ok(!bip.has(w), `${w} is a BIP-39 word and should not be listed as legacy-only`);
    assert.ok(shared.isAcceptedWord(w), `${w} must still be accepted on entry`);
    assert.ok(shared.isLegacyOnlyWord(w), `${w} must be flagged legacy-only`);
  }
  assert.strictEqual(shared.ACCEPTED_WORDS.size, 2048 + 15);
});

test('legacy-only words are never generated or suggested', () => {
  for (const w of shared.LEGACY_ONLY_WORDS) {
    assert.ok(!shared.BIP39_WORDS.includes(w), `${w} must not be generatable`);
    const suggestions = phraseEntry.suggestWords(w.slice(0, 4), 20);
    assert.ok(!suggestions.includes(w), `${w} must not be autocompleted`);
  }
});

test('a phrase of legacy-only words still validates, and is flagged as legacy', () => {
  const words = shared.LEGACY_ONLY_WORDS.slice(0, 12);
  const res = phraseEntry.validatePhrase(words);
  assert.strictEqual(res.ok, true, 'an old phrase must still restore');
  assert.deepStrictEqual(res.unknown, []);
  assert.strictEqual(res.legacy.length, 12, 'the screen must be able to say these are legacy words');
});

test('a plain BIP-39 phrase validates with nothing flagged', () => {
  const res = phraseEntry.validatePhrase(shared.BIP39_WORDS.slice(0, 12));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.unknown, []);
  assert.deepStrictEqual(res.legacy, []);
});

test('a word in neither list is still rejected', () => {
  const words = [...shared.BIP39_WORDS.slice(0, 11), 'zzzznotaword'];
  const res = phraseEntry.validatePhrase(words);
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.unknown, [11]);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} wordlist-parity test(s) failed`); process.exit(1); }
console.log('\nAll wordlist-parity tests passed');
