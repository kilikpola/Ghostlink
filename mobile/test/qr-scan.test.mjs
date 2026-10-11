/**
 * classifyScan: Ghost Address, older GL- invite, or not ours at all.
 */
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}`)); };

// The screen imports React Native and a camera; lift the pure function out.
const src = fs.readFileSync(new URL('../src/screens/QRScannerScreen.js', import.meta.url), 'utf8');
const start = src.indexOf('const INVITE_CODE_REGEX');
const end = src.indexOf('export default function QRScannerScreen');
const body = src.slice(start, end)
  .replace('export function classifyScan', 'function classifyScan')
  .replace(/const \{width: SCREEN_WIDTH\}[\s\S]*?;\n/, '')
  .replace(/const QR_SIZE[\s\S]*?;\n/, '');
const modPath = new URL('./.qr-scan.mjs', import.meta.url);
fs.writeFileSync(modPath,
  `import {normalizeGhostAddress} from '../src/utils/ghost-address.js';\n` +
  `import {cleanDisplayName, cleanPublicKeyHex} from '../src/utils/untrusted.js';\n${body}\nexport {classifyScan};\n`);
const {classifyScan} = await import(modPath.href);

console.log('\n[1] Ghost Addresses');
{
  const addr = 'GHOST-7K2-M4Q-8ZB';
  for (const input of [addr, addr.toLowerCase(), '7K2M4Q8ZB', 'ghost7k2m4q8zb', `  ${addr}  `]) {
    const r = classifyScan(input);
    ok(`${JSON.stringify(input)} -> ${r.address}`, r.kind === 'ghost' && r.address === addr);
  }
  // Crockford folding: O->0, I/L->1, U->V.
  const folded = classifyScan('GHOST-OKI-M4Q-8ZB');
  ok('ambiguous characters fold (O->0, I->1)', folded.kind === 'ghost' && folded.address === 'GHOST-0K1-M4Q-8ZB');
}

console.log('\n[2] Legacy GL- invite codes');
{
  const code = 'GL-A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6';
  ok('uppercase code', classifyScan(code).kind === 'invite');
  ok('lowercase code is accepted', classifyScan(code.toLowerCase()).code === code);
  ok('a truncated code is not an invite', classifyScan('GL-A1B2C3D4').kind === 'unknown');
}

console.log('\n[3] JSON invite payloads');
{
  const withAddr = JSON.stringify({ghostAddress: 'GHOST-7K2-M4Q-8ZB', name: 'Ada'});
  const r1 = classifyScan(withAddr);
  ok('JSON carrying an address resolves to it', r1.kind === 'ghost' && r1.address === 'GHOST-7K2-M4Q-8ZB');
  ok('and keeps the name', r1.name === 'Ada');

  const withCode = JSON.stringify({code: 'GL-A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6', n: 'Bob'});
  const r2 = classifyScan(withCode);
  ok('JSON carrying a legacy code resolves to it', r2.kind === 'invite' && r2.name === 'Bob');

  ok('JSON with neither is unknown', classifyScan(JSON.stringify({hello: 'world'})).kind === 'unknown');
  ok('malformed JSON is unknown, not a crash', classifyScan('{not json').kind === 'unknown');
}

console.log('\n[4] Anything else is refused, never guessed at');
{
  for (const junk of ['', '   ', 'https://example.com', 'WIFI:S:net;P:pw;;', 'hello world', '12345']) {
    const r = classifyScan(junk);
    ok(`${JSON.stringify(junk)} -> ${r.kind}`, r.kind === 'unknown' || r.kind === 'empty');
  }
  for (const bad of [null, undefined, 0]) {
    ok(`${String(bad)} handled without throwing`, classifyScan(bad).kind === 'empty');
  }
  // A near-miss must not be coerced into a valid address.
  ok('8 characters is not an address', classifyScan('GHOST-7K2-M4Q-8Z').kind === 'unknown');
  ok('10 characters is not an address', classifyScan('GHOST-7K2-M4Q-8ZBB').kind === 'unknown');
}

fs.unlinkSync(modPath);

// ── Web interop ────────────────────────────────────────────────────────────
// The web client's invite QR, exactly as index.html genInvite() builds it.
{
  const webQr = JSON.stringify({
    c: 'GHOST-ABC-DEF-GHJ',
    n: 'Desktop User',
    p: '04' + 'ab'.repeat(32),
    t: Date.now(),
  });
  const r = classifyScan(webQr);
  ok('A web-generated invite QR is recognised as a Ghost Address', r.kind === 'ghost');
  ok("The address is read from the web's `c` field", r.address === 'GHOST-ABC-DEF-GHJ');
  ok("The peer's name comes across", r.name === 'Desktop User');
  ok('The public key comes across, so messages can be sealed to them', r.publicKeyHex === '04' + 'ab'.repeat(32));
}

// ── Hostile invites ────────────────────────────────────────────────────────
// A name or key that is not a string was saved with the peer and then crashed
// the chat list (Text child is an object; PeerAvatar calls name.charAt) on
// every launch. Whatever the QR says, only strings come out.
{
  const addr = 'GHOST-ABC-DEF-GHJ';
  for (const n of [{}, [], 42, true, {toString: 'x'}]) {
    const r = classifyScan(JSON.stringify({c: addr, n, p: {evil: 1}}));
    ok(`name ${JSON.stringify(n)} is dropped, not stored`, r.kind === 'ghost' && r.name === undefined);
    ok(`non-string key alongside it is dropped`, r.publicKeyHex === null);
  }
  const long = classifyScan(JSON.stringify({c: addr, n: 'x'.repeat(10000)}));
  ok('an oversized name is cut to a displayable length', long.name.length === 64);
  ok('a key that is not hex is dropped',
     classifyScan(JSON.stringify({c: addr, p: '<script>'})).publicKeyHex === null);
  const inv = classifyScan(JSON.stringify({code: 'GL-A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6', n: {}}));
  ok('a legacy invite with an object name keeps no name', inv.kind === 'invite' && inv.name === undefined);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
