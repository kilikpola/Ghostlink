/**
 * Chain, the per-conversation hash chain (inline in index.html):
 *
 *   - verify() covers every block, genesis and received ones included
 *   - inbound blocks are chained by a locally computed hash; the sender's is
 *     kept as remoteHash
 *   - self-destruct removes the body from the chain, not just the view
 *
 * Run with: node test/message-chain.test.js
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── Extract Chain and its helpers out of index.html ────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const pattern = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm');
  const match = pattern.exec(html);
  if (!match) throw new Error(`index.html no longer declares: ${name}`);
  const start = match.index;

  const firstLineEnd = html.indexOf('\n', start);
  const firstLine = html.slice(start, firstLineEnd);
  if (firstLine.startsWith('const') && firstLine.trimEnd().endsWith(';')) {
    return firstLine;
  }
  const close = html.indexOf('\n}', start);
  if (close === -1) throw new Error(`Could not find the end of: ${name}`);
  const semicolon = html[close + 2] === ';' ? 3 : 2;
  return html.slice(start, close + semicolon);
}

const SOURCE = ['GENESIS_PREV_HASH', 'Chain'].map(extract).join('\n\n');

// Chain only needs the digest from CryptoEngine.
const CryptoEngine = {
  async sha256(d) { return crypto.createHash('sha256').update(String(d)).digest('hex'); }
};

const { Chain, GENESIS_PREV_HASH } = new Function('CryptoEngine', `
  ${SOURCE}
  return { Chain, GENESIS_PREV_HASH };
`)(CryptoEngine);

/** A chain of `n` locally authored blocks. */
async function makeChain(n = 3) {
  const chain = new Chain();
  for (let i = 0; i < n; i++) await chain.add('Alice', `message ${i}`, 'text', {});
  return chain;
}

/** Append a block the way the receive handler does. */
async function receive(chain, sender, content, senderHash, meta = {}) {
  const block = await chain.add(sender, content, 'text', meta);
  block.remoteHash = senderHash;
  block.isReceived = true;
  return block;
}

// ── verify() covers every block ────────────────────────────────────────────

test('a freshly built chain verifies', async () => {
  assert.strictEqual(await (await makeChain(4)).verify(), true);
});

test('an empty chain verifies', async () => {
  assert.strictEqual(await new Chain().verify(), true);
});

test('the genesis block is verified, not skipped', async () => {
  const chain = await makeChain(3);
  chain.blocks[0].content = 'rewritten after the fact';
  assert.strictEqual(await chain.verify(), false);
});

test('a genesis block with a forged prevHash is rejected', async () => {
  const chain = await makeChain(2);
  chain.blocks[0].prevHash = 'f'.repeat(64);
  assert.strictEqual(await chain.verify(), false);
});

test('a received block is verified, not skipped', async () => {
  const chain = await makeChain(2);
  await receive(chain, 'Bob', 'hello from Bob', 'b'.repeat(64));
  assert.strictEqual(await chain.verify(), true);

  chain.blocks[2].content = 'something Bob never said';
  assert.strictEqual(await chain.verify(), false);
});

test('a received block cannot hide an edit behind its isReceived flag', async () => {
  const chain = await makeChain(1);
  await receive(chain, 'Bob', 'original', 'b'.repeat(64));
  // The old verify() skipped every isReceived block outright.
  chain.blocks[1].content = 'tampered';
  chain.blocks[1].isReceived = true;
  assert.strictEqual(await chain.verify(), false);
});

test('a broken predecessor link is rejected', async () => {
  const chain = await makeChain(3);
  chain.blocks[2].prevHash = '0'.repeat(64);
  assert.strictEqual(await chain.verify(), false);
});

test('a deleted middle block is rejected', async () => {
  const chain = await makeChain(4);
  chain.blocks.splice(2, 1);
  assert.strictEqual(await chain.verify(), false);
});

test('editing meta is caught too', async () => {
  const chain = await makeChain(2);
  chain.blocks[1].meta = { selfDestruct: 999 };
  assert.strictEqual(await chain.verify(), false);
});

// ── inbound blocks keep a local hash ───────────────────────────────────────

test('the sender hash is recorded separately and never becomes ours', async () => {
  const chain = await makeChain(1);
  const senderHash = 'ab'.repeat(32);
  const block = await receive(chain, 'Bob', 'hi', senderHash);

  assert.strictEqual(block.remoteHash, senderHash);
  assert.notStrictEqual(block.hash, senderHash, 'local hash must not be the sender\'s');
  assert.strictEqual(block.prevHash, chain.blocks[0].hash, 'must chain to our predecessor');
});

// ── the legacy migration ───────────────────────────────────────────────────

test('legacy inbound blocks are re-linked and become verifiable', async () => {
  const chain = await makeChain(1);

  // Legacy storage of a received block: the sender's hash in `hash`.
  const legacy = await chain.add('Bob', 'from before the fix', 'text', {});
  const senderHash = 'cd'.repeat(32);
  legacy.hash = senderHash;
  legacy.isReceived = true;
  delete legacy.remoteHash;
  await chain.add('Alice', 'after it', 'text', {});

  assert.strictEqual(await chain.verify(), false, 'legacy chain should not verify as-is');

  assert.strictEqual(await chain.relinkLegacyBlocks(), true);
  assert.strictEqual(chain.blocks[1].remoteHash, senderHash, 'sender hash is preserved');
  assert.notStrictEqual(chain.blocks[1].hash, senderHash);
  assert.strictEqual(await chain.verify(), true, 'and verifies afterwards');
});

test('re-linking is a no-op on a chain that has none', async () => {
  const chain = await makeChain(3);
  await receive(chain, 'Bob', 'hi', 'ef'.repeat(32));
  const before = chain.blocks.map((b) => b.hash);

  assert.strictEqual(await chain.relinkLegacyBlocks(), false);
  assert.deepStrictEqual(chain.blocks.map((b) => b.hash), before);
});

// ── self-destruct erases ───────────────────────────────────────────────────

test('destroying a block removes the body from the chain', async () => {
  const chain = await makeChain(3);
  const victim = chain.blocks[1];
  victim.encrypted = { iv: 'aa', ciphertext: 'bb' };
  const secret = victim.content;

  await chain.destroyBlock(victim.hash);

  assert.strictEqual(victim.content, '');
  assert.strictEqual(victim.destroyed, true);
  assert.ok(victim.destroyedAt > 0);
  assert.strictEqual(victim.encrypted, undefined, 'ciphertext must go too');
  assert.ok(!chain.export().includes(secret), 'and must not survive in the export');
});

test('the chain still verifies after a destruction', async () => {
  const chain = await makeChain(5);
  await chain.destroyBlock(chain.blocks[2].hash);
  assert.strictEqual(await chain.verify(), true);
});

test('destroying re-links successors and reports the moved hashes', async () => {
  const chain = await makeChain(4);
  const target = chain.blocks[1];
  const followerBefore = chain.blocks[2].hash;

  const remap = await chain.destroyBlock(target.hash);

  assert.ok(remap instanceof Map);
  assert.strictEqual(remap.get(followerBefore), chain.blocks[2].hash);
  assert.strictEqual(chain.blocks[2].prevHash, chain.blocks[1].hash);
  assert.strictEqual(chain.blocks[0].hash, chain.blocks[1].prevHash, 'earlier blocks are untouched');
});

test('destroying the genesis block keeps the zero prevHash', async () => {
  const chain = await makeChain(3);
  await chain.destroyBlock(chain.blocks[0].hash);

  assert.strictEqual(chain.blocks[0].prevHash, GENESIS_PREV_HASH);
  assert.strictEqual(await chain.verify(), true);
});

test('destroying a received block works the same way', async () => {
  const chain = await makeChain(1);
  const block = await receive(chain, 'Bob', 'burn after reading', 'aa'.repeat(32), { selfDestruct: 30 });

  await chain.destroyBlock(block.hash);

  assert.strictEqual(block.content, '');
  assert.strictEqual(block.remoteHash, 'aa'.repeat(32), 'de-duplication still works');
  assert.strictEqual(await chain.verify(), true);
});

test('destroying an unknown hash is a no-op', async () => {
  const chain = await makeChain(2);
  const before = chain.blocks.map((b) => b.hash);

  assert.strictEqual(await chain.destroyBlock('nope'), null);
  assert.deepStrictEqual(chain.blocks.map((b) => b.hash), before);
});

// ── run ────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${name}\n        ${e.message}`);
    }
  }
  if (failures) {
    console.error(`\n${failures} message-chain test(s) failed`);
    process.exit(1);
  }
  console.log('All message-chain tests passed');
})();
