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
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extract(name) {
  const pattern = new RegExp(`^(?:const|function|class) ${name}\\b`, 'm');
  const m = pattern.exec(html);
  if (!m) throw new Error(`index.html no longer declares: ${name}`);
  const start = m.index;
  const close = html.indexOf('\n}', start);
  return html.slice(start, close + 2);
}
// NODE_ID_FULL and VERIFICATION_RECORD_VERSION are one-line consts.
const oneLine = (name) => { const m = new RegExp(`^const ${name}\\b.*$`, 'm').exec(html); if (!m) throw new Error(`index.html no longer declares: ${name}`); return m[0]; };
const scope = new Function(`${extract('messageBlockTags')}\n${extract('peerLiveSecurityTags')}\n${oneLine('NODE_ID_FULL')}\n${oneLine('VERIFICATION_RECORD_VERSION')}\n${extract('contactVerificationState')}\n${extract('iceModeLabel')}\n return { messageBlockTags, peerLiveSecurityTags, contactVerificationState, iceModeLabel };`)();
const { messageBlockTags, peerLiveSecurityTags, contactVerificationState, iceModeLabel } = scope;

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

console.log('\n=== Round 2 #2 (R3): VERIFIED is gated on the FULL NodeID and clears when it changes ===');
{
  // Verification is of the contact's full 64-byte NodeID (identity-v2.md D9),
  // backed by a chat key proven over a GMP link to that NodeID. The full test
  // matrix is in test/contact-verification.test.mjs.
  const NODE_A = 'a1'.repeat(64);  // a full NodeID (128 hex)
  const NODE_B = 'b2'.repeat(64);  // a different NodeID (rotation / substitution)
  const KEY = '04' + 'cd'.repeat(64);
  const rec = (nodeId) => ({ v: 2, nodeId });
  const pin = (nodeId) => ({ key: KEY, via: 'gmp-pop', nodeId });
  const st = (o) => contactVerificationState({ currentKey: KEY, ...o });
  ok(st({ peerId: NODE_A, record: rec(NODE_A), keyPin: pin(NODE_A) }) === 'verified', 'verified only after the ceremony recorded this exact NodeID, and the key is mesh-proven to it (positive control)');
  ok(st({ peerId: NODE_A, record: rec(NODE_B), keyPin: pin(NODE_A) }) === 'nodeid-changed', 'a different current NodeID (rotation / substitution) CLEARS verified');
  ok(st({ peerId: NODE_A, record: null, keyPin: pin(NODE_A) }) === 'unverified', 'no record (never verified) -> not verified');
  ok(st({ peerId: NODE_A, record: rec(NODE_A), keyPin: pin(NODE_A), currentKey: null }) !== 'verified', 'no current key received yet -> not verified');
  ok(st({ peerId: NODE_A.slice(0, 16), record: rec(NODE_A.slice(0, 16)), keyPin: pin(NODE_A.slice(0, 16)) }) === 'not-verifiable' && NODE_A.length === 128,
    'the comparison is the full 128-hex NodeID, not a 45-bit address or short fingerprint');
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

(async () => {
  const { absenceAsserter } = await import(pathToFileURL(path.join(__dirname, '..', 'gmp-core', 'test', 'helpers', 'assert-absent.mjs')).href);
  const { assertAbsent } = absenceAsserter(ok);

  console.log('\n=== B1: removed security claims are absent from every shipped surface ===');
  // electron/dist is a stale packaged copy (rebuilt in Task C) and is not scanned.
  const SCANNED = [
    'README.md', 'landing.html', 'index.html', 'package.json',
    'electron/package.json', 'electron/src/main.js', 'SECURITY.md',
    'gmp-core/SECURITY.md', 'docs/GHOST_MESH.md',
    'src/license/workspace-manager.js', 'src/license/workspace-components.js',
  ];
  // [what the control plants, the matcher the scan uses]
  const REMOVED = [
    ['Signal Protocol', /Signal Protocol/i],
    ['X3DH', /X3DH/i],
    ['Double Ratchet', /Double Ratchet/i],
    ['Zero Servers', /zero[\s-]*servers?\b/i],
    ['serverless', /serverless/i],
    ['No server exists to breach', /No server exists to breach/i],
    ['Perfect Forward Secrecy', /Perfect Forward Secrecy/i],
    ['for forward secrecy', /for forward secrecy|forward secrecy key rotations?/i],
    // B3: hosts see IP addresses and connection times; mailboxes hold sealed blobs.
    ['Zero Trace', /zero[\s-]*trace/i],
    ['leaves no trace', /\bno trace\b/i],
    ['No metadata', /\bno metadata\b/i],
    ['never leave your device', /never leave your device/i],
    ['no central logs', /no central logs/i],
    // B4: nothing here is a zero-knowledge proof; the identity is a key the user holds.
    ['Zero-knowledge', /zero[\s-]*knowledge/i],
    ['derives all keys', /derives all keys/i],
  ];
  const repoRoot = path.join(__dirname, '..');
  // The one file-reading channel both the control and the absence go through.
  const readScanned = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const hits = (text) => {
    const found = [];
    text.split('\n').forEach((line, i) => {
      for (const [label, re] of REMOVED) if (re.test(line)) found.push(`${label}@${i + 1}`);
    });
    return found;
  };
  // landing.html is gitignored (.gitignore:75): scanned where it exists, and
  // reported as skipped (never as passing) in a checkout that lacks it.
  const LOCAL_ONLY = new Set(['landing.html']);
  const plantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-claims-'));
  try {
    for (const rel of SCANNED) {
      if (LOCAL_ONLY.has(rel) && !fs.existsSync(path.join(repoRoot, rel))) {
        console.log(`  - skipped: ${rel} is not in this checkout (gitignored) — not scanned`);
        continue;
      }
      const real = hits(readScanned(repoRoot, rel));
      fs.mkdirSync(path.dirname(path.join(plantRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(plantRoot, rel),
        readScanned(repoRoot, rel) + '\n' + REMOVED.map(([plant]) => plant).join('\n') + '\n');
      assertAbsent({
        channel: `scan of ${rel}`,
        controlMessage: `every removed phrase planted in a temp copy of ${rel} is found`,
        control: () => {
          const labels = new Set(hits(readScanned(plantRoot, rel)).map((h) => h.split('@')[0]));
          return REMOVED.every(([label]) => labels.has(label)) ? [...labels] : [];
        },
        absent: () => hits(readScanned(repoRoot, rel)).length === 0,
        message: `${rel}: no removed security claim${real.length ? ` (found: ${real.join(', ')})` : ''}`,
      });
    }
  } finally {
    fs.rmSync(plantRoot, { recursive: true, force: true });
  }

  console.log('\n=== B1: roadmap COMPLETED lists only reachable, implemented features ===');
  const completedList = () => {
    const start = html.indexOf('/> COMPLETED');
    const end = html.indexOf('IN PROGRESS', start);
    return start < 0 || end < 0 ? '' : html.slice(start, end);
  };
  const NOT_COMPLETED = [
    'Voice messages with waveform',      // startRecording is never called
    'Group key agreement',               // createGroup agrees no key
    'Offline message queue (IndexedDB',  // no IndexedDB queue exists
    "Shamir's Secret Sharing backup",    // fragments cannot be sent (GUARDIAN_RECOVERY_AVAILABLE = false)
    'Push notifications (web)',          // local Notification API only, no push service
  ];
  for (const item of NOT_COMPLETED) {
    assertAbsent({
      channel: 'roadmap COMPLETED list',
      controlMessage: 'the slice holds a known completed item ("Hash-chain explorer")',
      control: () => completedList().includes('"Hash-chain explorer"'),
      absent: () => !completedList().includes(item),
      message: `"${item}" is not listed as COMPLETED`,
    });
  }

  console.log('\n=== B3: no biometric AVAILABLE indicator without a biometric unlock ===');
  // A rendered "AVAILABLE"/"ENABLED"/"ON" within reach of "Biometric".
  const biometricClaims = (src) =>
    [...src.matchAll(/Biometric[\s\S]{0,600}?['"`>](AVAILABLE|ENABLED|ACTIVE|ON)['"`<]/g)].map((m) => m[1]);
  // An unlock implementation would have to ask the platform authenticator for an assertion.
  const hasBiometricUnlock = (src) => /navigator\.credentials\.get\(\s*\{[\s\S]{0,200}publicKey/.test(src);
  assertAbsent({
    channel: 'biometric indicator scan of index.html',
    controlMessage: 'the scan finds the indicator as it was rendered before B3',
    control: () => biometricClaims(
      '<span>Biometric Unlock</span>\n<${Tag} color=${c}>\n${biometricStatus === \'available\' ? \'AVAILABLE\' : \'NOT SUPPORTED\'}'),
    absent: () => biometricClaims(html).length === 0 || hasBiometricUnlock(html),
    message: `index.html shows no biometric AVAILABLE indicator unless an unlock exists (found: ${JSON.stringify(biometricClaims(html))}, unlock implemented: ${hasBiometricUnlock(html)})`,
  });

  console.log('\n=== B3: a created group claims no presence and no E2E ===');
  {
    // Run the real createGroup (a component-scope const) with stubbed setters.
    const start = html.indexOf('const createGroup = () => {');
    const src = start < 0 ? '' : html.slice(start, html.indexOf('\n  };', start) + 5);
    let added = [];
    const run = new Function('groupName', 'selectedGroupPeers', 'setActiveGroups', 'setPeers', 'setShowGroupCreator',
      'setGroupName', 'setSelectedGroupPeers', 'addToast', 'th', `${src}\n createGroup();`);
    run('Team', ['p1', 'p2'], () => {}, (fn) => { added = fn([]); }, () => {}, () => {}, () => {}, () => {}, { accent3: '#0f0' });
    const group = added.find((p) => p.type === 'group');
    ok(!!group, 'createGroup ran and added a group entry to the peer list (channel is live)');
    ok(group && group.status !== 'online', `the group entry does not claim to be online (status: ${JSON.stringify(group && group.status)})`);
    ok(group && peerLiveSecurityTags(group).length === 0, 'the group entry gets no E2E ENCRYPTED tag (no group key agreement exists)');
  }

  console.log('\n=== B5: every tracked document and UI surface ===');
  {
    // Every tracked Markdown file, the static pages, and the strings mobile/src
    // renders (string literals and JSX text; comments and identifiers are not UI).
    const { execFileSync } = require('child_process');
    const tracked = (spec) => execFileSync('git', ['ls-files', '-z', '--', spec], { cwd: repoRoot }).toString('utf8').split('\0').filter(Boolean);
    const DOCS = [...tracked('*.md'), 'setup.html', '404.html', 'index.html', 'landing.html', 'src/license/workspace-manager.js', 'src/license/workspace-components.js'];
    const MOBILE_UI = tracked('mobile/src').filter((f) => /\.(js|jsx|ts|tsx)$/.test(f));
    const CLAIMS = [
      ...REMOVED,
      // B5: the message history is a per-conversation SHA-256 hash chain, not a blockchain.
      ['blockchain', /block[\s-]*chain/i],
    ];
    // A BIP-39 claim about the mobile app must say what is true: the shared BIP-39
    // word list, or the checksum (new phrases checksummed; old ones accepted without).
    const MOBILE_BIP39 = ['BIP-39 claim about mobile', /BIP-?\s?39/i];
    const qualifiedBip39 = /word ?list|checksum/i;
    // History lines that describe a removal, by exact text.
    const ALLOWED = new Set([
      'CHANGELOG.md\t- Removed misleading UI: a false "Double Ratchet ACTIVE" panel and false',
    ]);
    /** Strings a mobile screen can render: literals and JSX text, with comments removed. */
    const uiStrings = (src) => {
      const out = [];
      const re = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)/g;
      let code = '', last = 0, m;
      while ((m = re.exec(src)) !== null) {
        code += src.slice(last, m.index);
        last = re.lastIndex;
        if (m[3] || m[4] || m[5]) { out.push(m[0].slice(1, -1)); code += '""'; }
      }
      code += src.slice(last);
      for (const t of code.matchAll(/>([^<>{}]+)</g)) if (t[1].trim()) out.push(t[1].trim());
      return out.join('\n');
    };
    const findIn = (rel, text, mobile) => {
      const found = [];
      text.split('\n').forEach((line, i) => {
        if (ALLOWED.has(`${rel}\t${line}`)) return;
        for (const [label, re] of CLAIMS) if (re.test(line)) found.push(`${label}@${i + 1}`);
        const aboutMobile = mobile || rel.startsWith('mobile/') || /mobile/i.test(line);
        if (aboutMobile && MOBILE_BIP39[1].test(line) && !qualifiedBip39.test(line)) found.push(`${MOBILE_BIP39[0]}@${i + 1}`);
      });
      return found;
    };
    const surfaces = [
      ...DOCS.map((rel) => ({ rel, read: (r) => readScanned(r, rel), mobile: false })),
      ...MOBILE_UI.map((rel) => ({ rel, read: (r) => uiStrings(readScanned(r, rel)), mobile: true })),
    ];
    const plantB5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-claims-b5-'));
    const PLANT = [...CLAIMS.map(([p]) => p), 'Your BIP-39 phrase'];
    const expectLabels = [...CLAIMS.map(([l]) => l), MOBILE_BIP39[0]];
    let scanned = 0;
    try {
      for (const s of surfaces) {
        if (!fs.existsSync(path.join(repoRoot, s.rel))) {
          console.log(`  - skipped: ${s.rel} is not in this checkout — not scanned`);
          continue;
        }
        scanned++;
        const raw = readScanned(repoRoot, s.rel);
        const planted = s.mobile
          ? raw + '\n' + PLANT.map((p) => `const planted = <Text>${p} on mobile</Text>;`).join('\n') + '\n'
          : raw + '\n' + PLANT.map((p) => `${p} on mobile`).join('\n') + '\n';
        fs.mkdirSync(path.dirname(path.join(plantB5, s.rel)), { recursive: true });
        fs.writeFileSync(path.join(plantB5, s.rel), planted);
        const real = findIn(s.rel, s.read(repoRoot), s.mobile);
        assertAbsent({
          channel: `B5 scan of ${s.rel}`,
          controlMessage: `every claim planted in a temp copy of ${s.rel} is found`,
          control: () => {
            const labels = new Set(findIn(s.rel, s.read(plantB5), s.mobile).map((h) => h.split('@')[0]));
            return expectLabels.every((l) => labels.has(l)) ? [...labels] : [];
          },
          absent: () => real.length === 0,
          message: `${s.rel}: no removed claim, no "blockchain", no unqualified BIP-39 claim about mobile${real.length ? ` (found: ${real.join(', ')})` : ''}`,
        });
      }
    } finally {
      fs.rmSync(plantB5, { recursive: true, force: true });
    }
    ok(scanned >= 40, `B5 scanned ${scanned} surfaces (every tracked .md, the static pages, ${MOBILE_UI.length} mobile/src files)`);
    // The whitelist is exact: an allowed history line with a claim appended is still found.
    ok(findIn('CHANGELOG.md', '- Removed misleading UI: a false "Double Ratchet ACTIVE" panel and false', false).length === 0
      && findIn('CHANGELOG.md', '- Removed misleading UI: a false "Double Ratchet ACTIVE" panel and false; now with Double Ratchet', false).length > 0,
      'the CHANGELOG allowance matches one exact line and nothing else');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
