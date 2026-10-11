/**
 * Markdown escaping: escapeHTML escapes markup characters, and the parser's
 * sanitizer resolves in the browser so javascript: links are blocked.
 *
 * Run with: node test/markdown-escaping.test.js
 */
'use strict';

const assert = require('assert');

global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
require('../src/markdown/sanitize.js');
require('../src/markdown/parser.js');

const { escapeHTML, unescapeHTML, isSafeURL } = globalThis;
const parser = new globalThis.MarkdownParser();

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('escapeHTML neutralises every markup character', () => {
  // Note: globalThis.escapeHTML is the parser's (loaded last); it escapes the
  // markup characters but not '/', which is enough to neutralise a tag.
  assert.strictEqual(escapeHTML('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(escapeHTML('a & b'), 'a &amp; b');
  assert.strictEqual(escapeHTML('say "hi"'), 'say &quot;hi&quot;');
  assert.strictEqual(escapeHTML("it's"), 'it&#x27;s');
  for (const ch of ['&', '<', '>', '"']) {
    assert.notStrictEqual(escapeHTML(ch), ch, `${ch} must not survive escaping`);
  }
});

test('escape/unescape round-trips without double-decoding', () => {
  for (const s of ['a & <b> "c"', '&amp;', '&lt;script&gt;', 'plain text', '1 < 2 && 3 > 2']) {
    assert.strictEqual(unescapeHTML(escapeHTML(s)), s, `round-trip failed for: ${s}`);
  }
});

test('markdown renders peer markup as text, not as tags', () => {
  assert.strictEqual(parser.parseInline('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(parser.parseInline('**bold** <b>raw</b>'),
    '<strong>bold</strong> &lt;b&gt;raw&lt;/b&gt;');
});

test('dangerous link schemes never become an href', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>',
                     'vbscript:msgbox', '//evil.example.com']) {
    const out = parser.parseInline(`[click](${url})`);
    assert.ok(!/href=/.test(out), `${url} must not produce an href, got: ${out}`);
  }
});

test('ordinary links still render', () => {
  const out = parser.parseInline('[ok](https://example.com)');
  assert.ok(out.includes('href="https://example.com"'), `expected a link, got: ${out}`);
  assert.ok(out.includes('rel="noopener noreferrer"'), 'links must carry rel=noopener');
});

test('the sanitizer is actually reachable from the parser', () => {
  // If this is false the parser silently stops checking URLs at all.
  assert.strictEqual(typeof isSafeURL, 'function');
  assert.strictEqual(isSafeURL('javascript:alert(1)'), false);
  assert.strictEqual(isSafeURL('https://example.com'), true);
});

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}
if (failures) {
  console.error(`\n${failures} markdown-escaping test(s) failed`);
  process.exit(1);
}
console.log('\nAll markdown-escaping tests passed');
