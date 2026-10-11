/**
 * Controls gated in utils/capabilities.js (calls, Ghost Mesh setup) must be
 * unreachable at their entry points. Checked by source inspection, since the
 * screens need the React Native runtime.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  CALLS_AVAILABLE,
  CALLS_UNAVAILABLE_REASON,
  MESH_SETUP_AVAILABLE,
  GUARDIAN_RECOVERY_AVAILABLE,
} from '../src/utils/capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

const chat = read('src/screens/ChatScreen.js');
const settings = read('src/screens/SettingsScreen.js');

// ── Calls ──────────────────────────────────────────────────────────────────
ok(CALLS_AVAILABLE === false,
   'Calls are marked unavailable in this build');

const callButtons = chat.match(/navigation\.navigate\('Call'/g) || [];
ok(callButtons.length === 2, `Both call entry points are accounted for (found ${callButtons.length})`);

ok((chat.match(/disabled=\{!CALLS_AVAILABLE\}/g) || []).length === callButtons.length,
   'Every call button is disabled while calls are unavailable');

ok((chat.match(/if \(!CALLS_AVAILABLE\) return;/g) || []).length === callButtons.length,
   'Every call handler refuses to navigate while calls are unavailable');

ok(chat.includes('accessibilityLabel={CALLS_AVAILABLE ?'),
   'A disabled call button announces why it is disabled');

ok(CALLS_UNAVAILABLE_REASON === 'Calls unavailable until direct connection is supported',
   'The reason given to screen readers is the agreed wording');

// A URL from any web page must not be a way round the gate.
const app = read('App.js');
const linkScreens = app.slice(app.indexOf('const DEEP_LINK_CONFIG'), app.indexOf('};', app.indexOf('const DEEP_LINK_CONFIG')));
ok(!/\bCall\s*:/.test(linkScreens), 'No ghostlink:// URL maps to the Call screen');

const call = read('src/screens/CallScreen.js');
ok(/if \(!CALLS_AVAILABLE\) \{\s*setCallState\(CALL_STATES\.FAILED\);/.test(call),
   'The Call screen itself refuses to start while calls are unavailable');
ok(!call.includes('Fallback: transition through states'),
   'A call with no peer fails instead of pretending to connect');

// ── Ghost Mesh setup ───────────────────────────────────────────────────────
ok(MESH_SETUP_AVAILABLE === false,
   'Ghost Mesh setup is marked unavailable in this build');

ok(settings.includes('disabled={!MESH_SETUP_AVAILABLE}'),
   'The Ghost Mesh setup row is disabled while mesh setup is unavailable');

ok(settings.includes('if (!MESH_SETUP_AVAILABLE) return;'),
   'The Ghost Mesh setup handler refuses to open the modal');

ok(settings.includes('visible={MESH_SETUP_AVAILABLE && showMeshSetup}'),
   'The modal cannot become visible even if its state flag is set some other way');

// ── Guardian recovery ──────────────────────────────────────────────────────
ok(GUARDIAN_RECOVERY_AVAILABLE === false,
   'Guardian recovery is marked unavailable in this build');

// Nobody may be told a fragment is held when no guardian can hold one: the
// gate has to cover sending, the status shown, and the service itself.
const recovery = read('src/screens/RecoveryScreen.js');
const giveFn = recovery.slice(recovery.indexOf('const handleGiveFragment'), recovery.indexOf('const handleSelectPeer'));
ok(/if \(!GUARDIAN_RECOVERY_AVAILABLE\) \{[\s\S]*?return;/.test(giveFn),
   'Sending a fragment to a peer is refused while guardian recovery is unavailable');
ok(recovery.includes('disabled={!GUARDIAN_RECOVERY_AVAILABLE || distributing}'),
   'The SEND P2P control is disabled while guardian recovery is unavailable');
ok(recovery.includes('{GUARDIAN_RECOVERY_AVAILABLE ? (\n                    <View style={[styles.distCounter'),
   'The "N/7 distributed · Adequate" status is not shown while nothing can be distributed');
const selectFn = recovery.slice(recovery.indexOf('const handleSelectPeer'), recovery.indexOf('const handleSelectPeer') + 4000);
ok((selectFn.match(/distributed: true/g) || []).length === 1,
   'Only a confirmed P2P store marks a fragment distributed — the clipboard fallbacks do not');
const recoverFn = recovery.slice(recovery.indexOf('const handleRecoverFromPeers'), recovery.indexOf('const handleRecoverFromPeers') + 300);
ok(recoverFn.includes('if (!GUARDIAN_RECOVERY_AVAILABLE)'),
   'Recover-from-peers is refused while guardian recovery is unavailable');
ok(recovery.includes('if (GUARDIAN_RECOVERY_AVAILABLE && connectedPeers.length > 0 && distributor)'),
   'The fragment restore does not fall through to asking peers');

const dist = read('src/services/MobileDistributor.js');
ok(/async distribute\([^)]*\) \{\s*if \(!GUARDIAN_RECOVERY_AVAILABLE\)/.test(dist),
   'MobileDistributor.distribute() refuses while guardian recovery is unavailable');
ok(/async recover\([^)]*\) \{\s*if \(!GUARDIAN_RECOVERY_AVAILABLE\)/.test(dist),
   'MobileDistributor.recover() refuses while guardian recovery is unavailable');
ok(/if \(!GUARDIAN_RECOVERY_AVAILABLE\) \{\s*return \{type: MSG\.STORE_ACK, id: msg\.id, payload: \{ok: false\}\}/.test(dist),
   'An inbound store is refused, not acknowledged as held');
ok(dist.includes("ack.payload?.ok !== true"),
   'distribute() counts only an explicit ok acknowledgement as stored');

// ── The gate must be honest about itself ───────────────────────────────────
const caps = read('src/utils/capabilities.js');
for (const flag of ['CALLS_AVAILABLE', 'MESH_SETUP_AVAILABLE', 'GUARDIAN_RECOVERY_AVAILABLE']) {
  const idx = caps.indexOf(`export const ${flag}`);
  ok(idx > 0 && caps.lastIndexOf('*/', idx) > caps.lastIndexOf('export const', idx - 1),
     `${flag} carries a documented reason, so it can be flipped deliberately`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
