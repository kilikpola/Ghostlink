/**
 * RecoveryTransport request/response matching.
 *
 * A recovery asks specific peers for its fragments. A reply must come from the
 * peer that was asked: matching on the message id alone let any other
 * connected peer answer in its place.
 */
import {EventEmitter} from 'events';
import RecoveryTransport from '../src/services/RecoveryTransport.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

class FakeWebRTC extends EventEmitter {
  constructor() { super(); this.sent = []; }
  getConnectedPeers() { return ['guardian', 'mallory']; }
  sendMessage(peerId, data) { this.sent.push({peerId, data}); return true; }
}

{
  const rtc = new FakeWebRTC();
  const t = new RecoveryTransport(rtc);
  const p = t.request('guardian', {type: 'gl:fetch', payload: {tag: 't'}}, 200);
  const {id} = rtc.sent[0].data;

  rtc.emit('message', {peerId: 'mallory', data: {type: 'gl:fetch:res', id, payload: {fragment: 'forged'}}});
  rtc.emit('message', {peerId: 'guardian', data: {type: 'gl:fetch:res', id, payload: {fragment: 'real'}}});
  const res = await p;
  ok(res.payload.fragment === 'real', 'a reply from a peer that was not asked is ignored');
  ok(t._pendingRequests.size === 0, 'the request is settled once answered');
}

{
  const rtc = new FakeWebRTC();
  const t = new RecoveryTransport(rtc);
  let handled = 0;
  t.onMessage(() => { handled++; return null; });
  const p = t.request('guardian', {type: 'gl:exists', payload: {tag: 't'}}, 50);
  const {id} = rtc.sent[0].data;
  rtc.emit('message', {peerId: 'mallory', data: {type: 'gl:exists:res', id}});
  ok(handled === 0, "someone else's reply is not passed to the request handler either");
  let rejected = false;
  await p.catch(() => { rejected = true; });
  ok(rejected, 'with no genuine reply the request times out rather than accepting the forgery');
}

{
  // The timer must be cleared once a reply settles the request.
  const rtc = new FakeWebRTC();
  const t = new RecoveryTransport(rtc);
  let cleared = 0;
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = h => { cleared++; realClear(h); };
  const p = t.request('guardian', {type: 'gl:fetch', payload: {}}, 1000);
  rtc.emit('message', {peerId: 'guardian', data: {type: 'gl:fetch:res', id: rtc.sent[0].data.id}});
  await p;
  globalThis.clearTimeout = realClear;
  ok(cleared === 1, 'answering a request clears its timeout');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
