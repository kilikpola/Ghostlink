/**
 * The page's console capture (window.errs, index.html head script) is bounded,
 * renders the error overlay without rescanning everything captured, records
 * warnings too, and never keeps message content (task B5).
 *
 * The script is extracted from index.html and run against a minimal DOM.
 * Run: node test/error-buffer.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const out = (s) => process.stdout.write(s + '\n');
const ok = (c, m) => { if (c) { pass++; out(`  ✓ ${m}`); } else { fail++; out(`  ✗ ${m}`); } };

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const at = html.indexOf('window.errs');
const src = html.slice(html.lastIndexOf('<script>', at) + '<script>'.length, html.indexOf('</script>', at));
if (at < 0 || !src.includes('window.onerror')) { out('index.html no longer has the console-capture script'); process.exit(1); }

/** Run the capture script in a fresh page; count overlay rows rendered. */
function page() {
  const stats = { renders: 0, rows: 0, lookups: 0 };
  let mounted = false;
  const el = () => ({ style: {}, textContent: '', appendChild() {}, remove() {} });
  const div = Object.assign(el(), { replaceChildren: (...rows) => { stats.renders++; stats.rows += rows.length; } });
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: {
      getElementById: () => { stats.lookups++; return mounted ? div : null; },
      createElement: (tag) => (tag === 'div' && !mounted ? div : el()),
      body: { appendChild: () => { mounted = true; } },
    },
    addEventListener() {},
    PALETTE: { slate: '#000', crimson: '#f00' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return { w: sandbox, stats };
}

out('\n=== bounded ===');
{
  const { w } = page();
  for (let i = 0; i < 5000; i++) w.console.log(`[Tag] line ${i}`);
  ok(w.errs.length > 0, `control: console.log is captured (${w.errs.length} entries)`);
  ok(w.errs.length <= 500, `5000 console.log calls leave at most 500 entries (${w.errs.length})`);
  ok(/line 4999/.test(JSON.stringify(w.errs[w.errs.length - 1])), 'the newest entry is kept (a ring, not a stop)');
}

out('\n=== no quadratic rescans ===');
{
  const { w, stats } = page();
  for (let i = 0; i < 2000; i++) w.console.error(`[Tag] failure ${i}`);
  ok(stats.renders > 0, `control: errors render the overlay (${stats.renders} renders)`);
  ok(stats.rows <= 2000 * 50, `2000 errors render ${stats.rows} overlay rows in total (each render is bounded, not all errors so far)`);
  const { w: w2, stats: s2 } = page();
  for (let i = 0; i < 2000; i++) w2.console.log(`[Tag] info ${i}`);
  ok(s2.renders === 0 && s2.lookups === 0, `plain logs never reach the overlay code, which used to rescan every entry on each call (${s2.lookups} overlay calls)`);
}

out('\n=== warnings are captured ===');
{
  const { w } = page();
  w.console.warn('[Tag] a warning');
  const last = w.errs[w.errs.length - 1];
  ok(!!last && last.type === 'warn' && /a warning/.test(last.text || ''), `console.warn is recorded (${JSON.stringify(last)})`);
}

out('\n=== never message content ===');
{
  const { w } = page();
  const SECRET = 'SECRET-BODY-7f3a';
  w.console.log('[Chat] received', SECRET, { text: SECRET });
  w.console.error('[Chat] parse failed', new SyntaxError(`Unexpected token in JSON at position 3: "${SECRET}"`));
  w.onerror(`Uncaught SyntaxError: "${SECRET}" is not valid JSON`, 'app.js', 1, 2, Object.assign(new SyntaxError(`"${SECRET}" is not valid JSON`), { stack: `SyntaxError: "${SECRET}" is not valid JSON\n    at parse (app.js:1:2)` }));
  w.onunhandledrejection({ reason: new Error(`decrypt failed for '${SECRET}'`) });
  const all = JSON.stringify(w.errs);
  ok(/\[Chat\] received/.test(all) && /\[Chat\] parse failed/.test(all) && /SyntaxError/.test(all) && /app\.js:1:2/.test(all),
    'control: the code\'s own tags, error names and stack frames are kept');
  ok(!all.includes(SECRET), `no argument, error message, uncaught message or stack keeps the message body (${all.length} bytes captured)`);
}

out(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
