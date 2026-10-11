/**
 * Peer chat frames as the conversation screen accepts them: malformed fields
 * must not be stored or rendered, and a peer using our display name must not
 * be drawn as us.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  parseInboundChat, parseInboundAck, cleanDisplayName, cleanPublicKeyHex,
  MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH,
} from '../src/utils/untrusted.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

// ── Well-formed frames survive intact ──────────────────────────────────────
{
  const c = parseInboundChat({__gl: 'chat', id: 'msg_1', text: 'hi', timestamp: 1700000000000, replyTo: 'msg_0'});
  ok(c && c.id === 'msg_1' && c.text === 'hi' && c.timestamp === 1700000000000 && c.replyTo === 'msg_0',
     'a normal chat frame is accepted unchanged');
  ok(parseInboundAck({__gl: 'ack', id: 'msg_1'}) === 'msg_1', 'a normal ack is accepted');
}

// ── Anything that would be stored as a non-string is refused ───────────────
{
  for (const text of [{}, [], ['a'], 5, true, '', null]) {
    ok(parseInboundChat({__gl: 'chat', id: 'x', text}) === null, `text ${JSON.stringify(text)} is refused`);
  }
  ok(parseInboundChat({__gl: 'chat', text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1)}) === null,
     'an oversized message is refused rather than persisted');
  const c = parseInboundChat({__gl: 'chat', id: {}, text: 'ok', timestamp: 'soon', replyTo: {x: 1}});
  ok(c && c.id === null && c.replyTo === null, 'non-string id and replyTo are dropped');
  ok(c && Number.isFinite(c.timestamp), 'a non-numeric timestamp is replaced with a real one');
  ok(parseInboundAck({__gl: 'ack', id: {}}) === null, 'an ack with a non-string id is ignored');
  ok(parseInboundChat('{"__gl":"chat"}') === null && parseInboundChat(null) === null,
     'non-objects are ignored');
  ok(parseInboundChat({__gl: 'ack', text: 'x'}) === null, 'an ack is not a chat');
}

// ── Names and keys from invites ────────────────────────────────────────────
{
  ok(cleanDisplayName({}) === undefined && cleanDisplayName(7) === undefined, 'non-string names are dropped');
  ok(cleanDisplayName('   ') === undefined, 'a blank name is no name');
  ok(cleanDisplayName('n'.repeat(500)).length === MAX_NAME_LENGTH, 'long names are cut');
  ok(cleanPublicKeyHex('04' + 'ab'.repeat(64)) === '04' + 'ab'.repeat(64), 'a hex key is kept');
  ok(cleanPublicKeyHex('abc') === null && cleanPublicKeyHex({}) === null, 'odd-length or non-string keys are dropped');
}

// ── ChatScreen actually uses these, and records direction ──────────────────
{
  const chat = read('src/screens/ChatScreen.js');
  const handler = chat.slice(chat.indexOf('const onMessage = '), chat.indexOf("WebRTCService.on('message', onMessage)"));
  ok(handler.includes('parseInboundChat(data)') && handler.includes('parseInboundAck(data)'),
     'the inbound handler goes through the validators');
  ok(!/data\.text|data\.id|data\.timestamp|data\.replyTo/.test(handler),
     'no raw peer field reaches the stored message');
  ok(handler.includes('outgoing: false'), 'received messages are marked as not ours');
  ok((chat.match(/outgoing: true/g) || []).length === 2, 'both kinds of sent message are marked as ours');
  ok(/typeof item\.outgoing === 'boolean'\s*\?\s*item\.outgoing/.test(chat),
     "which side a bubble is drawn on comes from the flag, not the sender's name");

  const list = read('src/screens/ChatListScreen.js');
  ok(list.includes('state.messages?.get?.(peer.id)'),
     'the chat list reads each conversation where ChatScreen writes it (the peer id)');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
