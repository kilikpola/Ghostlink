/**
 * The dead Ghost Mesh TCP listener (port 49600) is gone (G0).
 *
 * Task C showed the ghostMesh server forwarded unparsed, unauthenticated
 * lines to the renderer, nothing read them, and its only sender was the
 * never-loaded src/p2p/p2p-connector.js. Every negative here goes through
 * assertAbsent, whose control plants a copy of the removed code and must find
 * it with the same matcher.
 *
 * The real Ghost Mesh (GMP) is mandatory and stays: "[GMP] Ghost Mesh ..."
 * strings are not matched; only the removed API, channels and UI are.
 *
 * Run: node test/ghostmesh-absent.test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { absenceAsserter } from '../gmp-core/test/helpers/assert-absent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const { assertAbsent } = absenceAsserter(ok);

// What the removed code looked like, planted for each control.
const PLANTED = [
  "ipcMain.handle('ghostmesh-start-server', async (_e, bindAddress) => {",
  "const GHOSTMESH_PORT = 49600;",
  "ghostMesh: { startServer: (bindAddress) => secureInvoke('ghostmesh-start-server', bindAddress) },",
  "const res = await window.ghostlink.ghostMesh.startServer(localStorage.getItem('gl_yggdrasil_address') || '');",
  "addToast('Ghost Mesh server started', 'success');",
].join('\n');

const matchers = {
  '"ghostmesh-" IPC channel': /['"`]ghostmesh-[a-z-]+['"`]/i,
  'ghostMesh preload API': /\bghostMesh\s*[:.]/,
  '49600 listener': /GHOSTMESH_PORT|\b49600\b/,
  '"Ghost Mesh server" UI text': /Ghost Mesh server/i,
};
const files = ['electron/src/main.js', 'electron/src/preload.js', 'index.html', 'app.bundle.js'];

console.log('\n=== removed API, channels, port and UI text ===');
for (const [what, re] of Object.entries(matchers)) {
  for (const f of files) {
    const src = read(f);
    assertAbsent({
      channel: `${what} in ${f}`,
      controlMessage: `the matcher finds ${what} in a planted copy`,
      control: () => (re.test(PLANTED + '\n' + src) ? 1 : 0),
      absent: () => !re.test(src),
      message: `${f}: no ${what}`,
    });
  }
}

console.log('\n=== the unloaded connector and its own tests are gone ===');
for (const f of ['src/p2p/p2p-connector.js', 'test/peer-lifecycle.test.js', 'test/mesh-handshake.test.js']) {
  assertAbsent({
    channel: `${f} on disk`,
    controlMessage: 'the same existence check sees a file that is there (index.html)',
    control: () => (fs.existsSync(path.join(root, 'index.html')) ? 1 : 0),
    absent: () => !fs.existsSync(path.join(root, f)),
    message: `${f} is removed`,
  });
}

console.log('\n=== no UI implies the mesh (GMP) can be switched off ===');
{
  const html = read('index.html');
  const offSwitch = /Mesh disabled|Mesh enabled|Enable Mesh|Disable Mesh|gl_yggdrasil_enabled|setYggdrasilEnabled/;
  assertAbsent({
    channel: 'a mesh on/off switch in index.html',
    controlMessage: 'the matcher finds the removed toggle in a planted copy',
    control: () => (offSwitch.test("localStorage.setItem('gl_yggdrasil_enabled', String(newVal)); addToast(newVal ? 'Mesh enabled (Web Client mode)' : 'Mesh disabled', 'info');") ? 1 : 0),
    absent: () => !offSwitch.test(html),
    message: 'no mesh enable/disable control or text remains',
  });
  // Positive: the GMP mesh is still wired in (the bridge connector stays).
  ok(/class GMPBridgeConnector/.test(html) && /new GMPBridgeConnector\(/.test(html), 'GMPBridgeConnector is still defined and constructed');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
