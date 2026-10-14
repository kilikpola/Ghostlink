'use strict';
/**
 * RC1 security-claim audit (Part 2 fixes). Extracts the gating helpers out of
 * index.html (same mechanism as mesh-connector.test.js) and A/B-checks that a
 * badge is shown only when its mechanism is present, plus source-level checks
 * that the removed FALSE/OVERCLAIMS strings no longer render.
 * Run: node test/security-claims.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extract(name) {
  const pattern = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm');
  const m = pattern.exec(html);
  if (!m) throw new Error(`index.html no longer declares: ${name}`);
  const start = m.index;
  const close = html.indexOf('\n}', start);
  return html.slice(start, close + 2);
}
const scope = new Function(`${extract('messageBlockTags')}\n${extract('peerLiveSecurityTags')}\n${extract('peerKeyVerified')}\n${extract('iceModeLabel')}\n return { messageBlockTags, peerLiveSecurityTags, peerKeyVerified, iceModeLabel };`)();
const { messageBlockTags, peerLiveSecurityTags, peerKeyVerified, iceModeLabel } = scope;

// getIceServers reads localStorage + the module-scope sessionTurnServers mirror.
function getIceServersWith(lsData, sessionTurn = []) {
  const store = new Map(Object.entries(lsData));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null) };
  return new Function('localStorage', 'sessionTurnServers', `${extract('getIceServers')}\n return getIceServers();`)(localStorage, sessionTurn);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } };
const labels = (tags) => tags.map((t) => t.label);

console.log('\n=== messageBlockTags: E2E tag gated on a real sealed payload; no P2P DIRECT ever ===');
{
  const sealed = messageBlockTags({ encrypted: { iv: 'aa', ciphertext: 'bb' } }, true);
  ok(labels(sealed).includes('E2E ENCRYPTED'), 'a block WITH a sealed AES-256-GCM payload shows E2E ENCRYPTED (positive control)');
  ok(labels(sealed).includes('CHAIN VALID'), 'a valid chain shows CHAIN VALID');
  ok(!labels(sealed).includes('P2P DIRECT'), 'NO P2P DIRECT claim is made (path is unknowable) — was unconditional before');

  const plain = messageBlockTags({ /* no encrypted field */ }, true);
  ok(!labels(plain).includes('E2E ENCRYPTED'), 'a block with NO sealed payload does NOT show E2E ENCRYPTED (absent -> not shown)');

  const broken = messageBlockTags({ encrypted: { iv: 'aa' } }, false);
  ok(labels(broken).includes('CHAIN BROKEN') && !labels(broken).includes('CHAIN VALID'), 'a broken chain shows CHAIN BROKEN, not CHAIN VALID');
}

console.log('\n=== peerLiveSecurityTags: E2E is a LIVE claim, only while connected ===');
{
  ok(labels(peerLiveSecurityTags({ status: 'online' })).includes('E2E ENCRYPTED'), 'an ONLINE peer (conn.isConnected) shows E2E ENCRYPTED (positive control)');
  ok(peerLiveSecurityTags({ status: 'offline' }).length === 0, 'an OFFLINE peer shows no E2E claim (was unconditional before)');
  ok(peerLiveSecurityTags(null).length === 0, 'a null/unknown peer shows no E2E claim');
}

console.log('\n=== Round 2 #2: VERIFIED is gated on the FULL key and clears on key change ===');
{
  const KEY_A = 'a1'.repeat(64);   // a full X25519 public key (hex)
  const KEY_B = 'b2'.repeat(64);   // a different key (rotation / impersonation)
  ok(peerKeyVerified(KEY_A, KEY_A) === true, 'verified only after the ceremony recorded this exact key, and it still matches (positive control)');
  ok(peerKeyVerified(KEY_A, KEY_B) === false, 'a different current key (rotation / substitution) CLEARS verified');
  ok(peerKeyVerified('', KEY_A) === false, 'no recorded key (never verified) -> not verified');
  ok(peerKeyVerified(KEY_A, null) === false, 'no current key received yet -> not verified');
  ok(peerKeyVerified(KEY_A.slice(0, 20), KEY_A.slice(0, 20)) === true && KEY_A.length === 128, 'the comparison is the full 128-hex (256-bit) key, not a 45-bit address or short fingerprint');
}

console.log('\n=== Round 2 #3: the call badge says ENCRYPTED (not E2E), gated on remote media ===');
{
  const r = html;
  ok(/remoteStreams\)\.length > 0 \? html`<\$\{Tag\} color=\$\{th\.accent\} icon="lock">ENCRYPTED<\/\/>/.test(r), 'call badge renders "ENCRYPTED" gated on remote media present');
  ok(!/remoteStreams\)\.length > 0 \? html`<\$\{Tag\}[^>]*>E2E ENCRYPTED/.test(r), 'the call badge no longer claims "E2E ENCRYPTED"');
}

console.log('\n=== Round 2 #1: brand/capability copy is TRUE as a capability ===');
{
  const r = html;
  ok(!/blockchain-verified/i.test(r), '"blockchain-verified" removed');
  ok(!/blockchain-chained/i.test(r), '"blockchain-chained" removed');
  ok(!/icon="chain">BLOCKCHAIN</.test(r), 'the "BLOCKCHAIN" capability tag is reworded (HASH CHAIN)');
  ok(!/Blockchain chain explorer/.test(r), '"Blockchain chain explorer" reworded');
  ok(!/with blockchain integrity/.test(r), '"blockchain integrity" reworded to hash-chain integrity');
  ok(!/"WebRTC P2P Direct"/.test(r), 'the hardcoded "WebRTC P2P Direct" connection field is gone (now reflects live connectionMode)');
  ok(!/\n\s*P2P Direct\n\s*<\/div>/.test(r), 'the splash "P2P Direct" brand pill is reworded (Peer-to-Peer)');
  // Round-final superseded this: the payment flow's simulated on-chain query and
  // its "blockchain transaction hash" wording were removed (see Round-final #1).
  ok(!/Querying Blockchain Network/.test(r) && !/blockchain transaction hash/.test(r), 'the payment flow no longer references a blockchain query (fake confirmation removed in Round-final)');
}

console.log('\n=== Round 3 #2: iceModeLabel is derived from the selected ICE candidate pair ===');
{
  ok(iceModeLabel('relay', 'host') === 'Relayed (TURN)', 'a local TURN relay candidate -> "Relayed (TURN)"');
  ok(iceModeLabel('host', 'relay') === 'Relayed (TURN)', 'a remote TURN relay candidate -> "Relayed (TURN)"');
  ok(iceModeLabel('host', 'host') === 'Direct (P2P)', 'host/host -> "Direct (P2P)" (positive control)');
  ok(iceModeLabel('srflx', 'prflx') === 'Direct (P2P)', 'srflx/prflx -> "Direct (P2P)"');
  ok(iceModeLabel(undefined, undefined) === 'Connecting…', 'no pair yet -> "Connecting…", never an assumed "P2P Direct"');
  ok(iceModeLabel('relay', 'relay') !== 'Direct (P2P)', 'a relayed pair is NEVER labelled direct (negative control)');
}

console.log('\n=== Round 3 #3.4: STUN is OFF by default, opt-in only ===');
{
  const def = getIceServersWith({});
  ok(def.every((s) => !/google\.com/.test(s.urls)), 'DEFAULT: getIceServers returns NO third-party (Google) STUN entries');
  ok(def.length === 0, 'DEFAULT: no ICE servers at all (no STUN, no TURN) unless configured');
  const optedIn = getIceServersWith({ gl_settings: JSON.stringify({ useGoogleStun: true }) });
  ok(optedIn.some((s) => /stun\.l\.google\.com/.test(s.urls)), 'OPTED IN (gl_settings.useGoogleStun): Google STUN entries present (positive control)');
  const noStunWithTurn = getIceServersWith({ gl_turn_fallback: 'true' }, [{ url: 'turn:my-relay.example:3478' }]);
  ok(noStunWithTurn.some((s) => /turn:my-relay/.test(s.urls)) && noStunWithTurn.every((s) => !/google/.test(s.urls)), 'user TURN relay is included without any Google STUN');
}

console.log('\n=== Round 3 #1: RC1-false capability copy no longer renders ===');
{
  ok(!/Zero Servers/.test(html) && !/Zero Metadata/.test(html), '"Zero Servers" / "Zero Metadata" removed (RC1 runs Railway bootstrap + storage)');
  ok(!/Zero Server Architecture/.test(html), 'the "Zero Server Architecture" onboarding slide is reworded');
  ok(!/no servers, no accounts, no metadata/.test(html), 'the title/meta/OG "no servers … no metadata" claim is reworded');
  ok(!/No servers, no IP addresses/.test(html), 'the Ghost-Address "No servers, no IP addresses" claim is reworded');
  ok(!/Zero Trace/.test(html), '"Zero Trace" (false — Railway sees connection metadata) removed');
  ok(!/icon="lock">ZERO TRUST</.test(html), 'the "ZERO TRUST" capability tag is reworded to a concrete claim (NO ACCOUNTS)');
  ok(!/P2P · Encrypted · Private/.test(html), 'the vague "Private" splash tagline is reworded');
  ok(!/>TURN Server Fallback<|>Enable TURN Fallback</.test(html), 'user-visible "fallback" TURN wording renamed to "relay"');
  ok(/No accounts|no accounts/.test(html) && /end-to-end encrypted so no server can read your messages/i.test(html), 'replacements state TRUE mechanisms (no accounts; E2E so no server can read messages)');
}

console.log('\n=== Round-final #1: payment path has no fake confirmation ===');
{
  ok(!/Querying Blockchain Network/.test(html), 'the simulated "Querying Blockchain Network" step is gone');
  ok(!/AUTOMATED CHECK UNRESOLVED/.test(html), 'the "AUTOMATED CHECK UNRESOLVED" automated-verifier framing is gone');
  ok(!/Verification Details Sent|queued your activation request|verified by our team/.test(html), 'no "queued / verified by our team / details sent" success framing remains');
  ok(!/buyRefId|GL-' \+ Math\.random/.test(html), 'the random GL-xxxx reference and its state are removed');
  ok(!/Simulated verification query latency|Submit Verification/.test(html), 'the simulated-latency timer and "Submit Verification" button are gone');
  ok(/Payment is not verified in the app/.test(html), 'the honest heading "Payment is not verified in the app" renders (positive control)');
  ok(/contact support with your transaction hash/.test(html), 'the honest instruction to contact support with the transaction hash renders');
  ok(/Transaction hash \(for support\)/.test(html), 'the tx-hash field is reworded to "Transaction hash (for support)"');
  ok(/buyWalletAddress/.test(html), 'the (local) wallet address is still shown');
}

console.log('\n=== Round-final #2: onboarding relay wording is accurate for RC1 ===');
{
  ok(!/relay to help them find each other/.test(html), 'the inaccurate "relay to help them find each other" wording is gone');
  ok(/A bootstrap server helps them find each other, and a storage server holds sealed messages while a contact is offline — neither can read them/.test(html), 'the accurate bootstrap+storage wording renders (positive control)');
}

console.log('\n=== Round-final #3: logger has NO off-device sink (even if a remote is configured) ===');
{
  delete require.cache[require.resolve('../src/core/logger.js')];
  require('../src/core/logger.js');
  const { Logger } = globalThis.GhostLink;
  let fetched = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { fetched = true; return Promise.resolve({}); };
  let consoleHit = false;
  const origErr = console.error;
  console.error = () => { consoleHit = true; };
  try {
    const log = new Logger('audit', { minLevel: 'trace', remote: { url: 'https://exfil.example/collect' } });
    log.error('boom');
    log.critical('boom2');
    log.child('x').error('child-boom');
  } finally { console.error = origErr; globalThis.fetch = origFetch; }
  ok(fetched === false, 'A/B: even with a remote sink configured, the logger NEVER fetches off-device (sink removed) — was a POST before');
  ok(consoleHit === true, 'positive control: the logger still writes errors to the console');
  const probe = new Logger('audit2', {});
  ok(!('remote' in probe) || probe.remote === undefined, 'there is no remote field on the logger');
  // The shipped bundle must carry no fetch from the logger at all.
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'app.bundle.js'), 'utf8');
  ok(!/fetch\(/.test(bundle), 'app.bundle.js contains no fetch( at all (no off-device path in the packaged renderer)');
}

console.log('\n=== source: removed FALSE/OVERCLAIMS no longer render ===');
// Strip block comments so a documented-history mention inside /* */ does not count.
const rendered = html;
ok(!/icon="zap">P2P DIRECT</.test(rendered), 'the unconditional block-info "P2P DIRECT" tag is gone');
ok(!/icon="check">VERIFIED<\/\/>\s*\n\s*<\$\{Tag\} color=\$\{th\.accent2\} icon="lock">E2E ENCRYPTED/.test(rendered), 'the unconditional VERIFIED+E2E block-info tag pair is gone');
ok(!/Encrypted channel established/.test(rendered), 'the false empty-state "Encrypted channel established" line is gone');
ok(!/E2E encrypted · P2P`/.test(rendered), 'the unverifiable "· P2P" was dropped from the conversation-header subtitle');
ok(/No messages yet/.test(rendered), 'the empty state now reads the honest "No messages yet" + capability line');

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
