/**
 * A message that did not leave the device must say so. Drives the real
 * sendMessage body, lifted out of index.html, with a fake connector.
 *
 * Run with: node test/send-failure.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ── Lift the tail of sendMessage: everything from resolving the peer to the
//    end of the transmit logic. That is the region the bug lived in.
function loadSendTail() {
  const start = html.indexOf('      // Resolve the recipient once, up front');
  assert.ok(start !== -1, 'index.html no longer has the recipient-resolution comment');
  const endMarker = "    } catch (e) {console.error('sendMessage error:'";
  const end = html.indexOf(endMarker, start);
  assert.ok(end !== -1, 'could not find the end of sendMessage');
  const body = html.slice(start, end);

  // Everything the body touches is injected, so nothing real is required.
  return new Function(
    'ctx',
    `return (async () => {
       const {content, type, meta, target, activeConvo, peers, chain, identity,
              CryptoEngine, LocalVault, bumpChain, setMessages, setMsgInput,
              setReplyTo, setChainValid, scheduleSelfDestruct, p2pConnectorRef,
              addToast, getPeerPublicKey, sealPayload} = ctx;
       ${body}
     })();`
  );
}

const sendTail = loadSendTail();

/** A harness that records what the UI was told and what the messages look like. */
function harness({connected, sendThrows = false, pubKey = 'BEEF'} = {}) {
  const toasts = [];
  let messages = {conv1: []};
  const block = {hash: 'h1', index: 7, ts: Date.now(), content: 'hi'};

  const ctx = {
    content: 'hi', type: 'text', meta: {}, target: null,
    activeConvo: 'conv1',
    peers: [{id: 'conv1', fingerprint: 'PEER1'}],
    identity: {name: 'me', fingerprint: 'ME'},
    chain: {add: async () => block, verify: async () => true},
    CryptoEngine: {encrypt: async () => ({v: 2, iv: '', ciphertext: ''})},
    LocalVault: {key: () => 'k'.repeat(64)},
    bumpChain: () => {},
    setMessages: (fn) => { messages = typeof fn === 'function' ? fn(messages) : fn; },
    setMsgInput: () => {}, setReplyTo: () => {}, setChainValid: () => {},
    scheduleSelfDestruct: () => {},
    addToast: (m, kind) => toasts.push({m, kind}),
    getPeerPublicKey: () => pubKey,
    sealPayload: async () => 'SEALED',
    p2pConnectorRef: {
      current: {
        isConnected: () => connected,
        sendMessage: () => { if (sendThrows) throw new Error('channel closed'); },
        sendPresence: () => {},
      },
    },
  };
  return {ctx, toasts, block, get messages() { return messages; }};
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const sent = (h) => (h.messages.conv1 || []).find(m => m.hash === 'h1');

test('sending to a DISCONNECTED peer marks the message failed and says so', async () => {
  const h = harness({connected: false});
  await sendTail(h.ctx);

  const msg = sent(h);
  assert.ok(msg, 'the message should still be on the local chain');
  assert.strictEqual(msg.sendFailed, true,
    'a message that never left the device must be marked failed');
  assert.ok(/offline/i.test(msg.sendFailedReason || ''),
    `the reason should name the cause, got: ${msg.sendFailedReason}`);

  const errors = h.toasts.filter(t => t.kind === 'error');
  assert.strictEqual(errors.length, 1, 'the user must be told exactly once');
  assert.ok(/not sent/i.test(errors[0].m), `toast should say it was not sent: ${errors[0].m}`);

  // And nothing may imply it went out.
  assert.ok(!h.toasts.some(t => /queued|sent to|delivered/i.test(t.m)),
    'no toast may imply delivery');
});

test('sending to a CONNECTED peer succeeds and is not marked failed', async () => {
  const h = harness({connected: true});
  await sendTail(h.ctx);

  const msg = sent(h);
  assert.ok(msg, 'the message should be on the chain');
  assert.ok(!msg.sendFailed, 'a delivered message must not be marked failed');
  assert.strictEqual(h.toasts.filter(t => t.kind === 'error').length, 0,
    'no error toast on the happy path');
});

test('a data channel that throws mid-send is a failed send, not a silent log', async () => {
  const h = harness({connected: true, sendThrows: true});
  await sendTail(h.ctx);

  const msg = sent(h);
  assert.strictEqual(msg.sendFailed, true,
    'a throw from sendMessage means nothing was transmitted');
  assert.ok(/dropped|connection/i.test(msg.sendFailedReason || ''),
    `the reason should name the cause, got: ${msg.sendFailedReason}`);
});

test('an unusable peer key is still reported', async () => {
  const h = harness({connected: true, pubKey: null});
  await sendTail(h.ctx);

  const msg = sent(h);
  assert.strictEqual(msg.sendFailed, true);
  assert.ok(/public key/i.test(msg.sendFailedReason || ''),
    `the reason should name the cause, got: ${msg.sendFailedReason}`);
});

test('there is no path that neither transmits nor marks the message failed', async () => {
  for (const scenario of [
    {connected: false},
    {connected: true, sendThrows: true},
    {connected: true, pubKey: null},
  ]) {
    const h = harness(scenario);
    await sendTail(h.ctx);
    assert.strictEqual(sent(h).sendFailed, true,
      `silent drop for scenario ${JSON.stringify(scenario)}`);
  }
});

test('the dead offline-queue branch and its state are gone', () => {
  // Everything after the GhostLinkPlatform class is the live React app. The
  // platform's own offlineQueue manager is out of scope here and is left in
  // place deliberately. Comments are stripped because the removal is
  // explained in one — prose is not code.
  const app = html
    .slice(html.indexOf('window.GhostLinkPlatform = GhostLinkPlatform'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/else if \(offlineQueue\)/.test(app),
    'the dead `else if (offlineQueue)` branch must not come back');
  assert.ok(!/setOfflineQueue|const \[offlineQueue/.test(app),
    'offlineQueue state was never set and must not be reintroduced');
  assert.ok(!/pendingMessages/.test(app),
    'pendingMessages was written only inside the dead branch and never read');
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} send-failure test(s) failed`); process.exit(1); }
console.log('\nAll send-failure tests passed');
