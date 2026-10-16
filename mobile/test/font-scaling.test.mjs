/**
 * The text-size setting must move the whole app, not just the Settings screen.
 *
 * Sizes live as literals inside StyleSheet.create, so the scaling happens in
 * the Text/TextInput wrappers. These check the maths and that every screen
 * actually goes through them — a wrapper nothing imports scales nothing.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {scaleStyle} from '../src/utils/scale-style.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

// ── The maths ──────────────────────────────────────────────────────────────
ok(scaleStyle({fontSize: 16}, 1).fontSize === 16, 'At the default size, text is unchanged');
ok(scaleStyle({fontSize: 16}, 22 / 16).fontSize === 22, 'Extra large scales a 16pt design size to 22pt');
ok(scaleStyle({fontSize: 12}, 22 / 16).fontSize === 17, 'A smaller design size scales proportionally, not to the base');
ok(scaleStyle({fontSize: 16}, 14 / 16).fontSize === 14, 'Small scales down');

ok(scaleStyle({fontSize: 16, lineHeight: 24}, 22 / 16).lineHeight === 33,
   'lineHeight scales with the text, so larger text does not crowd its own rows');

ok(scaleStyle({color: 'red'}, 2).color === 'red',
   'A style with no fontSize passes through untouched');
ok(scaleStyle(undefined, 2) === undefined, 'No style at all is handled');

const arrayStyle = scaleStyle([{fontSize: 16}, {color: 'blue'}], 22 / 16);
ok(arrayStyle.fontSize === 22 && arrayStyle.color === 'blue',
   'An array of styles is flattened and scaled');

ok(scaleStyle({fontSize: 9}, 1).fontSize === 11,
   'A design size below 11pt is raised to the platform minimum');
ok(scaleStyle({fontSize: 12}, 14 / 16).fontSize === 11,
   'The Small setting never takes text below 11pt');

const identity = {fontSize: 16};
ok(scaleStyle(identity, 1) === identity, 'At ratio 1 the original object is returned, so nothing re-renders needlessly');

// ── Every screen must actually use the wrappers ────────────────────────────
const screens = [
  'src/screens/ChatScreen.js', 'src/screens/ChatListScreen.js', 'src/screens/SettingsScreen.js',
  'src/screens/SetupScreen.js', 'src/screens/QRScannerScreen.js', 'src/screens/RecoveryScreen.js',
  'src/screens/CallScreen.js', 'src/screens/RestoreIdentityScreen.js', 'src/components/GhostMeshSetupModal.js',
];
for (const f of screens) {
  const src = read(f);
  const usesRaw = /import \{[^}]*\bText\b[^}]*\} from 'react-native'/s.test(src);
  ok(!usesRaw, `${path.basename(f)} does not import Text straight from react-native`);
}

// Chat specifically, since that is the one the setting is judged by.
const chat = read('src/screens/ChatScreen.js');
ok(/from '\.\.\/components\/ScaledText'/.test(chat),
   'ChatScreen takes its Text from the scaled wrapper, so the setting reaches conversations');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
