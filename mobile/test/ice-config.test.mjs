/**
 * Third-party STUN is opt-in on mobile, as on the web client (B2-2).
 *
 * A STUN server learns the user's public IP address. WebRTCService used to
 * default to Google STUN, and the app's shared instance took no override. This
 * loads the REAL service (react-native-webrtc stubbed, recording what each
 * RTCPeerConnection is constructed with) and checks the config it would use.
 */
import {register} from 'node:module';

// Resolve hook: stub react-native-webrtc, and let the service's extensionless
// relative imports ('../utils/session-crypto') resolve as they do under Metro.
const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === 'react-native-webrtc') return {url: 'gl-stub:rnwebrtc', shortCircuit: true};
  try { return await next(spec, ctx); } catch (e) {
    if (spec.startsWith('.') && !/\\.m?js$/.test(spec)) return next(spec + '.js', ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url === 'gl-stub:rnwebrtc') return {format: 'module', shortCircuit: true, source:
    'export class RTCPeerConnection { constructor(c) { (globalThis.__pcConfigs ||= []).push(c); } }\\n' +
    'export const mediaDevices = {};'};
  return next(url, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const {default: shared, WebRTCService} = await import('../src/services/WebRTCService.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };
const urlsOf = cfg => (cfg?.iceServers || []).flatMap(s => [].concat(s.urls || s.url || []));
const thirdParty = urls => urls.filter(u => /^(stun|stuns|turn|turns):/i.test(u));

console.log('\n=== the app-wide instance: no STUN/TURN by default ===');
ok(Array.isArray(shared._iceConfig?.iceServers), 'the shared instance has an ICE config the test can read (channel is live)');
ok(thirdParty(urlsOf(shared._iceConfig)).length === 0,
  `the shared instance's default config has no STUN/TURN URLs (got ${JSON.stringify(urlsOf(shared._iceConfig))})`);
ok(thirdParty(urlsOf(new WebRTCService()._iceConfig)).length === 0, 'a new WebRTCService() defaults to no STUN/TURN URLs');

console.log('\n=== positive control: the opt-in setting adds STUN ===');
ok(typeof shared.setIceSettings === 'function', 'the shared instance accepts the user\'s settings (setIceSettings)');
if (typeof shared.setIceSettings === 'function') {
  shared.setIceSettings({useGoogleStun: true});
  const on = thirdParty(urlsOf(shared._iceConfig));
  ok(on.length > 0 && on.every(u => /^stun:stun[0-9]?\.l\.google\.com:19302$/.test(u)),
    `with useGoogleStun on, the config carries Google STUN (got ${JSON.stringify(on)})`);
  shared.setIceSettings({useGoogleStun: false});
  ok(thirdParty(urlsOf(shared._iceConfig)).length === 0, 'turning the setting off removes them again');
  shared.setIceSettings({});
  ok(thirdParty(urlsOf(shared._iceConfig)).length === 0, 'settings without the key (an existing install) mean off');
}

console.log('\n=== what a real connection is constructed with ===');
globalThis.__pcConfigs = [];
const svc = new WebRTCService();
try { await svc.createConnection('peer-a'); } catch { /* the stub has no data channels; the constructor already ran */ }
const seen = globalThis.__pcConfigs[0];
ok(seen !== undefined, 'RTCPeerConnection was constructed (the stub records its config)');
ok(thirdParty(urlsOf(seen)).length === 0, `that connection was given no STUN/TURN URLs (got ${JSON.stringify(urlsOf(seen))})`);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
