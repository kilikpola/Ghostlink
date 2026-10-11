/**
 * What crosses the wire on the direct WebRTC path, driving the real
 * _setupDataChannel / sendMessage code with fake data channels.
 * react-native-webrtc is stubbed from the real source at run time.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = path.join(here, '..', 'src', 'services', 'WebRTCService.js');

const stubbed = fs.readFileSync(real, 'utf8')
  .replace(/import \{\n(?:  \w+,\n)+\} from 'react-native-webrtc';/,
           'const RTCPeerConnection=class{}, RTCSessionDescription=class{}, RTCIceCandidate=class{}, mediaDevices={};')
  .replace("from '../utils/session-crypto'",
           `from '${path.join(here, '..', 'src', 'utils', 'session-crypto.js')}'`);

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-wire-')), 'WebRTCService.mjs');
fs.writeFileSync(tmp, stubbed);
const {WebRTCService} = await import(tmp);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WIRE = [];
function makePair() {
  const mk = () => ({
    readyState: 'open', _peer: null, onmessage: null, onopen: null, onclose: null, onerror: null,
    send(d) { WIRE.push(d); setTimeout(() => this._peer.onmessage && this._peer.onmessage({data: d}), 0); },
  });
  const a = mk(), b = mk();
  a._peer = b; b._peer = a;
  return [a, b];
}

const ALICE = 'alice-fingerprint-1', BOB = 'bob-fingerprint-2';
const alice = new WebRTCService(); alice.setLocalPeerId(ALICE);
const bob = new WebRTCService(); bob.setLocalPeerId(BOB);

const [dcA, dcB] = makePair();
const sessA = {peerId: BOB}, sessB = {peerId: ALICE};
alice._peers.set(BOB, sessA); bob._peers.set(ALICE, sessB);
alice._setupDataChannel(sessA, dcA); bob._setupDataChannel(sessB, dcB);

ok(alice.sendMessage(BOB, {__gl: 'chat', text: 'too soon'}) === false,
   'sendMessage refuses before a session exists (no plaintext fallback)');
ok(!WIRE.some(f => String(f).includes('too soon')), 'The refused message never reached the wire');

dcA.onopen(); dcB.onopen();
await sleep(400);
ok(alice._sessionKeys.has(BOB), 'Alice derived a session key for Bob');
ok(bob._sessionKeys.has(ALICE), 'Bob derived a session key for Alice');

const received = [];
bob.on('message', ev => received.push(ev));

WIRE.length = 0;
const SECRET = 'meet me at the observatory at midnight';
ok(alice.sendMessage(BOB, {__gl: 'chat', id: 'm1', text: SECRET}) === true,
   'sendMessage succeeds once the session is up');
await sleep(200);

const frames = WIRE.map(String);
ok(!frames.some(f => f.includes(SECRET)), 'The plaintext never appears on the wire');
ok(!frames.some(f => f.includes('__gl')), 'Even the message envelope is opaque on the wire');
ok(frames.some(f => { try { const p = JSON.parse(f); return p.v === 2 && p.iv && p.ct; } catch { return false; } }),
   'What crossed the wire is a v2 AES-GCM envelope');

ok(received.length === 1, 'Bob received exactly one message');
ok(received[0]?.data?.text === SECRET, 'Bob decrypted it to the original text');
ok(received[0]?.transport === 'webrtc-e2e', "It is tagged 'webrtc-e2e'");
ok(received[0]?.encrypted === true, 'It is tagged encrypted');

const errs = [];
bob.on('message-error', e => errs.push(e));
const good = JSON.parse(frames.find(f => { try { return JSON.parse(f).ct; } catch { return false; } }));
const before = received.length;
dcB.onmessage({data: JSON.stringify({...good, ct: (good.ct[0] === 'a' ? 'b' : 'a') + good.ct.slice(1)})});
await sleep(100);
ok(received.length === before, 'A tampered frame is not delivered as a message');
ok(errs.length === 1, 'It is reported as a message-error instead');

received.length = 0;
dcB.onmessage({data: JSON.stringify({__gl: 'chat', id: 'x', text: 'cleartext'})});
await sleep(100);
ok(received[0]?.transport === 'webrtc-plain', "Unencrypted traffic is tagged 'webrtc-plain'");
ok(received[0]?.encrypted === false, 'and explicitly marked not encrypted');

const sec = alice.getPeerSecurity(BOB);
ok(sec.encrypted === true && sec.ready === true, 'getPeerSecurity reports the peer as end-to-end ready');

// A frame from a peer on an older envelope version must be rejected, never
// delivered as chat. This is the rolling-upgrade case.
{
  received.length = 0;
  errs.length = 0;
  const v1Frame = JSON.stringify({v: 1, iv: 'aa'.repeat(12), ct: 'bb'.repeat(40)});
  dcB.onmessage({data: v1Frame});
  await sleep(100);
  ok(received.length === 0, 'A v1 envelope is NOT delivered as a message');
  ok(errs.length === 1, 'It is reported as a message-error');
  ok(!received.some(r => r.transport === 'webrtc-plain'),
     'and is never mistaken for unencrypted traffic');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
