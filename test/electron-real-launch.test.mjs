/**
 * The desktop app launched EXACTLY as `cd electron && npm start` launches it:
 * the Electron binary, cwd electron/, entry `.` (package.json "main"), so the
 * window loads whatever INDEX_PATH main.js resolves — not a test copy.
 * Isolation is environment-only; see helpers/electron-app.mjs.
 *
 * It walks the first-run flow through the real DOM and asserts:
 *   - the window loaded the file `npm start` ships (checkout index.html; with
 *     --packaged, resources/webapp/index.html of electron/dist/linux-unpacked);
 *   - the renderer reached the node: the setup socket got 'started' and the
 *     main view's connector holds an open bridge socket;
 *   - no `client-rejected-token` line was logged from launch to connected;
 *   - positive control: a raw WebSocket WITHOUT the token IS refused (401) and
 *     DOES log that line, so its absence above is not a silent logger.
 *
 * Skipped when the Electron binary (or, with --packaged, the unpacked build)
 * is missing.
 *
 * Run: node test/electron-real-launch.test.mjs [--packaged]
 */
import fs from 'fs';
import path from 'path';
import { repo, unpackedDir, electronBinary, portsBusy, shortTmp, privateBus, launchApp, firstRun, untokenedProbe, sleep } from './helpers/electron-app.mjs';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } };

const packaged = process.argv.includes('--packaged');
if (!electronBinary({ packaged })) {
  console.log(`  ~ ${packaged ? 'no packaged build at ' + unpackedDir : 'Electron binary not installed'} — skipped`);
  process.exit(0);
}
const busy = await portsBusy();
if (busy.length) { console.error(`  ✗ port(s) ${busy.join(', ')} in use (a GhostLink instance is running?) — close it first`); process.exit(1); }

const tmp = shortTmp('gl-launch-');
const peersFile = path.join(tmp, 'public-peers.json');
fs.writeFileSync(peersFile, '[]');
const bus = privateBus(tmp);
const app = launchApp({ packaged, env: bus.env, configHome: path.join(tmp, 'config'), dataDir: path.join(tmp, 'gmp-data'), peersFile });
console.log(`=== launch: ${app.describe} ===`);
const rejected = /client-rejected-token/;

try {
  const cdp = await app.attach();
  ok(!!cdp, 'the app window came up');
  if (cdp) {
    const expectedIndex = packaged ? path.join(unpackedDir, 'resources', 'webapp', 'index.html') : path.join(repo, 'index.html');
    ok(decodeURIComponent(new URL(cdp.url).pathname) === expectedIndex, `window loaded ${path.relative(repo, expectedIndex)} (got ${cdp.url})`);

    console.log('\n=== first-run flow through the real DOM ===');
    const s = await firstRun(cdp);
    ok(s.onboarding, 'onboarding appeared and advanced');
    ok(s.alias, `alias screen reached (buttons: ${JSON.stringify(s.aliasButtons)})`);
    ok(s.aliasSubmitted, 'alias submitted');
    ok(s.seed, `seed screen reached (buttons: ${JSON.stringify(s.seedButtons)})`);
    await sleep(3000); // let any reconnect loop show itself

    console.log('\n=== renderer -> bridge ===');
    ok(/Node Manager started on port \d+, Bridge on 3002/.test(app.log()), 'node and bridge started (main process)');
    ok(app.count(rejected) === 0, `no client-rejected-token line from launch to connected (saw ${app.count(rejected)})`);
    ok(s.reachedMain, 'setup socket accepted: the node answered started and the app left the setup screen');
    ok(s.connectorOpen, 'main-view connector holds an open bridge socket');

    console.log('\n=== the renderer loads the safety-number module (importmap, CSP, packaging) ===');
    {
      // Two public test NodeIDs (any 128-hex values); the expected value comes
      // from gmp-core's dist in this process, so this checks the shipped copy.
      const X = 'a1'.repeat(64), Y = 'b2'.repeat(64);
      const { safetyNumber } = await import(path.join(repo, 'gmp-core', 'dist', 'safety-number.js'));
      const inPage = await cdp.evaluate(`import('@ghostlink/safety-number').then((m) => m.safetyNumber('${X}', '${Y}'), (e) => 'error: ' + e.message)`);
      ok(inPage === safetyNumber(X, Y), `import('@ghostlink/safety-number') in the window gives gmp-core's number (${String(inPage).slice(0, 15)}…)`);
    }

    console.log('\n=== positive control: an untokened client is rejected and logged ===');
    const before = app.count(rejected);
    const status = await untokenedProbe();
    await sleep(500);
    ok(status === 401, `untokened WebSocket refused with 401 (got ${status})`);
    ok(app.count(rejected) === before + 1, 'and exactly one client-rejected-token line was logged for it');
    cdp.close();
  }
} catch (e) {
  failed++;
  console.error('  ✗ harness error:', (e && e.stack) || e);
}

if (failed) console.error(`\n--- main-process log tail ---\n${app.log().split('\n').filter((l) => /GMP|bridge|rejected|Electron|GhostLink|error/i.test(l)).slice(-25).join('\n')}`);
await app.stop();
bus.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
