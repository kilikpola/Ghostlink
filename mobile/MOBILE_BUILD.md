# GhostLink Android build

## Status of this build

The cryptography is real as of this build — see "Cryptography" below for what
was replaced and how it is verified. Ghost Mesh and QR scanning are still not
wired up, so this remains a **development build**, not a shippable messenger.

## The build that exists

Latest: `ghostlink-v0.0.3-vc8-arm64.apk`, 33 MB, arm64-v8a only, built
2026-09-27 with `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`.
SHA-256 `00b0a7b612dc5e78345d149754efdd7f5a67dae6841b186625183ffc16277705`.
Verified with `aapt` and `apksigner`: `versionCode='8' versionName='0.0.3'`,
signed `CN=GhostLink` with the certificate fingerprint recorded in
`android/KEYSTORE.md`.

The description below is of the earlier full five-ABI build
(`app-release.apk`, 98 MB, built 2026-09-10). Verified:

- `package: name='io.ghostlink.app' versionCode='5' versionName='2.0.0'`
- `application-label: 'GhostLink'`, launcher activity `io.ghostlink.app.MainActivity`
- `minSdkVersion 24`, `targetSdkVersion 34`
- Signed `CN=GhostLink` (SHA-256 `803469c2…`), APK Signature Scheme v2
- Hermes bytecode bundle present (1.8 MB)
- Adaptive launcher icon resolving to real PNGs at all five densities

It is **built but never installed or launched** — no Android device or emulator
was attached at build time, so nothing here says it runs.

98 MB is large because it ships five ABIs (arm64-v8a 22.7 MB, x86_64 26.0 MB,
x86 24.8 MB, armeabi-v7a 15.0 MB, armeabi 0.2 MB), most of it WebRTC. Adding
`splits { abi { enable true } }` to `app/build.gradle` would cut a real device's
download to roughly a quarter of that.

## Prerequisites

- JDK 17
- Android SDK with platform 34 and build-tools 35.0.0
- NDK 26.1.10909125 (**not** 27.x — see below)
- `ANDROID_HOME` pointing at the SDK

## Building

```bash
# From the repo root — mobile/ is an npm workspace, so install at the root.
npm install

cd mobile/android
./gradlew :app:assembleRelease
```

Output: `mobile/android/app/build/outputs/apk/release/app-release.apk`

Signing comes from `android/keystore.properties` — see `android/KEYSTORE.md`.
Without that file the release build **fails** ("Release build refused") — it
never falls back to the public Android debug key. Debug builds do not need it.

### Before every release build: bump versionCode

`versionCode` in `android/app/build.gradle` is the only number Android compares
when deciding whether one build may replace another — Play Store uploads and
plain sideload upgrades both key off it. `versionName` ("0.0.3") is a label and
has no effect on upgrades.

The rule is: **increment `versionCode` on every release build that leaves this
machine, and never reuse a value.** It moves independently of `versionName`, so
several builds of 0.0.3 each get their own code. Reusing a value means the new
APK cannot install over the old, and Play rejects the upload.

`versionName` follows the GitHub release tag (no `v` prefix). Builds 2–7 were
labelled 2.0.0.

Current value: `8` (0.0.3). The next release build must use `9` or higher.
The full history is in the comment above `versionCode` in
`android/app/build.gradle`. (`1` belonged to the two APKs built on 2026-09-13,
which were never shipped.)

## Installing (sideload)

1. On the phone: Settings → Security → enable **Install unknown apps** for
   whichever app will open the file (Files, Chrome, adb).
2. Transfer `app-release.apk` to the device, or install over USB:

```bash
adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
```

`-r` reinstalls over an existing GhostLink. Because this is a fresh signing key,
any previously installed GhostLink signed with a *different* key must be
uninstalled first — Android will refuse the upgrade otherwise.

To check the signature before installing:

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  mobile/android/app/build/outputs/apk/release/app-release.apk
```

## Configuration

| Setting | Value |
|---|---|
| Package name | `io.ghostlink.app` |
| App name | GhostLink |
| Version | 0.0.3 (versionCode 8) |
| Min SDK | 24 (Android 7.0) |
| Target / compile SDK | 34 |
| Architectures | armeabi-v7a, arm64-v8a, x86, x86_64 |
| Icon | solid ghost mark, adaptive + legacy densities |
| Splash | ghost mark on obsidian (`PALETTE.obsidian`, #0B0F17) |

Permissions requested: `INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA` (QR invites),
`RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` (voice), `POST_NOTIFICATIONS`, `VIBRATE`.

`BIND_VPN_SERVICE` is deliberately **not** requested — it is only needed for the
embedded GMP mesh, which is not in this build.

## Transport, and what the padlock means

A message leaves the phone one of two ways, and the UI labels each message by
the path it actually took rather than making a blanket claim about the app.

| Path | Protection | Shown as |
|---|---|---|
| Ghost Mesh bridge | GMP end-to-end | 🔒 |
| Direct WebRTC | AES-256-GCM applied before the data channel (`src/utils/session-crypto.js`) | 🔒 |
| Anything else | DTLS only — protects the hop, not the conversation | `transport-encrypted`, no padlock |

WebRTC's own DTLS is not end-to-end: whatever relays the connection, including
a TURN server, handles plaintext. So the direct path seals the payload itself
before it goes. `sendMessage()` **refuses to send** rather than fall back to
plaintext if a session key has not been established yet.

The session key comes from an X25519 exchange over the data channel, expanded
with **HKDF-SHA256** — extract once, then expand per direction with the two peer
ids sorted in the info field, so both ends compute the same mirrored pair
without either needing to know who dialled whom. (It was PBKDF2 at 100k
iterations initially, copied from the web's `KeyManager`. That is the primitive
for stretching a low-entropy password; an X25519 shared secret is already
uniformly random, so the iterations bought latency and nothing else.) The
envelope carries a version, currently 2, so a peer on the old derivation is
refused at the version check rather than failing authentication on every frame.

**There is no ratchet and no forward secrecy** — one key pair per session,
derived once. Compromise of a session key exposes that whole session. It is the
floor that makes the padlock honest on the direct path, not a replacement for
GMP, and a ratchet is a later milestone.

## There is no signaling server, and no SDP paste

`SignalingService` is gone. It dialled `ws://localhost:3001` — a server that no
longer exists anywhere in the project, and on a handset `localhost` is the
handset. Nothing in `mobile/` now contains a live `ws://` except the mesh
bridge URL, which comes from settings rather than a hardcoded default.

The obvious replacement — a serverless QR/paste SDP exchange — is **not
available to copy from the web client, because the web deliberately removed
it**. From `index.html`:

> There is no SDP-paste fallback: if the mesh is not up yet we say so and keep
> waiting, because handing the user a wall of base64 to copy was never an
> answer.

> This used to be a ladder: GMP bridge, else a Python relay, else a "WebRTC
> serverless" connector whose only usable feature was the manual SDP paste.
> Each rung silently changed what an invite code looked like […] The ladder is
> gone.

So the web's connection model is: **a Ghost Address, exchanged by QR or paste,
resolved through the mesh.** The QR is serverless; the *rendezvous* is the mesh.

The consequence for mobile is worth stating plainly: with no signaling server
and no SDP paste, a direct WebRTC connection has no way to exchange an offer
and an answer. `attachSignaling()` now throws with that explanation rather than
letting a connection hang. **The mesh bridge is the only working transport on
mobile today**, and it is a test harness (below). Until an embedded mesh node
lands, the shipping app cannot establish a peer connection on its own.

Two things follow that are tracked, not solved:

- **Guardian recovery is affected.** `RecoveryScreen` used the same signaling
  dial, so guardian rendezvous has been broken since those servers were
  removed. The dial is gone rather than left looking functional.
- **Message bodies are not wire-compatible with the web.** The web seals each
  chat payload with ECIES to the recipient's P-256 key (`sealPayload`,
  index.html:1139). Mobile's direct path uses a session layer applied by the
  transport (`src/utils/session-crypto.js`). Both are end-to-end; neither reads
  the other. Closing that means mobile adopting the ECIES seal.

## Ghost Mesh on mobile: a test harness, not the product

`meshBridgeUrl` in settings points the app at a Ghost Mesh bridge, and this is
**for interop testing only**.

A bridge process serves exactly one identity — `manager` in `gmp-bridge.ts` is
per-process and the first `start` wins — so a phone must not share the
desktop's bridge. Two clients on one bridge are the *same node*, not two peers
that can talk to each other. Testing mobile↔desktop therefore needs a second
bridge, started with the phone's own seed:

```bash
# On the desktop, a second bridge for the phone's identity.
GMP_BRIDGE_PORT=3003 GMP_PORT=49501 node gmp-core/dist/gmp-bridge.js
# Then in the app: Settings → Mesh bridge → ws://<desktop-lan-ip>:3003
```

**This is not a shipping architecture.** A real phone user has no desktop
running their seed. For the shipping app the phone's transport is
self-contained: direct WebRTC with QR/paste invites, carrying the app-layer
AES-256-GCM above. Putting a real mesh node on the handset — an embedded
runtime via nodejs-mobile — is a later milestone, and until it lands the mesh
path on mobile should be treated as a developer facility.

## Cryptography

`src/utils/crypto.js` previously contained placeholder code that looked like
cryptography and was not. It has been replaced with audited primitives from
`@noble/hashes`, `@noble/ciphers` and `@noble/curves`, with randomness from the
platform CSPRNG via `react-native-get-random-values`.

| Was | Now |
|---|---|
| `Math.random()` for all key material | `crypto.getRandomValues` (Android SecureRandom); **throws** rather than falling back |
| `sha256()` — an FNV-1a variant | real SHA-256 |
| `hmacSha256()` — called async `sha256` synchronously | real HMAC-SHA256 |
| `generateKeyPair()` — 32 random bytes and a *separate, unrelated* 65 random bytes | real ECDH P-256; the public key derives from the private key |
| `encrypt`/`decrypt` — AES-CTR returning an all-zero "tag", never checked | real AES-256-GCM; decrypt throws on a bad tag |
| `encryptLegacy`/`decryptLegacy` — XOR with a random unverified tag | removed (nothing called them) |
| `deriveKeyFromSeed()` — one unsalted pass of the fake hash | PBKDF2-HMAC-SHA256, 100k iterations |
| recovery phrase built with `Math.random()` | CSPRNG with rejection sampling |
| two different wordlists (575 / 183 words) | one shared 575-word list, 110 bits per phrase |
| Shamir GF(2⁸) tables built with generator `0x02` | generator `0x03`; multiplication now matches the reference for all 65,536 inputs |

The `0x02` bug deserves its own note: `0x02` is not a primitive element of AES's
field, so the log/exp tables covered only 51 of 255 values and multiplication
was wrong for most inputs. **Every recovery fragment the app produced was
unusable** — shares could not reconstruct the secret. It is fixed and tested.

### Verification

`npm test` in `mobile/` runs `test/crypto.test.mjs` — 56 assertions. Anything
that has to interoperate is checked for **byte equality against Node's
WebCrypto**, the same implementation the web app uses, rather than merely for
self-consistency:

- SHA-256 and HMAC outputs match WebCrypto
- generated public keys import into WebCrypto as P-256 points
- AES-GCM payloads produced here decrypt under WebCrypto, and vice versa
- `deriveKeyFromSeed` and `deriveStorageKey` match WebCrypto's PBKDF2 byte for byte
- tampered ciphertext, IV, tag and key are all rejected
- ECDH agrees between two parties and differs for a third
- Shamir round-trips at 3-of-7 in any order, and 2 shares fail

## Recovery

Both restore paths go through `src/utils/recovery.js` and share one bundle
shape, so they cannot drift apart again. The private key is stored only as an
AES-256-GCM envelope under a PBKDF2 key derived from the recovery phrase.

| Path | Needs | How it works |
|---|---|---|
| Same device | the phrase | unwrap the stored bundle |
| New device | the phrase **and** 3 of 7 fragments | fragments rebuild the bundle, the phrase unlocks it |

The GCM tag is the phrase check: a wrong phrase derives a different key, the tag
fails, and decrypt throws. That costs an attacker a full 100,000-iteration
PBKDF2 run per guess. The unwrapped private key is then re-derived to a public
key and compared with the one in the bundle, so a tampered or mixed-up bundle is
rejected rather than restoring a broken identity.

### What was wrong

- **Phrase restore replaced the identity.** It derived a key, discarded it, and
  called `generateKeyPair()` — returning a brand-new random identity with a
  different public key, while reporting success. Nobody who knew the user could
  have reached them afterwards.
- **Fragment restore read the wrong field names.** Setup wrote `publicKeyHex`;
  restore read `blob.pubKeyHex`, so it restored an identity with an empty public
  key and no private key at all.
- **Neither path ever unwrapped the stored key.** `gl_wrapped_privkey` was
  written at setup and read by nothing.
- **Fragments leaked the phrase.** `handleGenerateFragments` put the 12 words
  into the fragments in plaintext, so any three fragment-holders could collude
  to recover the phrase itself — collapsing the two factors into one. Fragments
  now carry only the wrapped key.
- **A bare SHA-256 of the phrase was stored** beside the wrapped key, letting
  anyone with the device test guesses at one cheap hash each and bypassing
  PBKDF2 entirely. Removed.

`npm test` covers this with 27 assertions, including that restore returns the
*same* public and private key rather than merely succeeding, that a wrong phrase
and a reversed phrase are both rejected, that fragments from two identities
cannot be mixed, and that a blank device cannot be restored from the phrase
alone.

### Still to do

- `CryptoService.js` (Ghost Mesh identity derivation) still has no backend and
  throws if called — it is only reachable from the Ghost Mesh setup modal, which
  is not functional in this build.
- The wordlist is a curated 575-word subset with no BIP-39 checksum, so phrases
  are not interchangeable with other wallets. 110 bits is strong; it is just not
  BIP-39.

## NDK version

Pinned to **26.1.10909125** in `android/build.gradle`. Reanimated 3.6 compiles
its C++ with `-Werror`, and NDK 27 ships Clang 18, which added
`-Wdeprecated-this-capture` and `-Wvla-cxx-extension`. Both fire inside
Reanimated's own sources, so the native build stops with
`ninja: build stopped: subcommand failed`. Raising the NDK requires bumping
Reanimated too — which in turn requires bumping React Native.

## Dependency drift that had to be pinned

`package.json` used caret ranges on packages that track React Native's version
closely, and they had resolved far past what RN 0.73.4 supports:

| Package | Declared | Resolved to | Pinned to |
|---|---|---|---|
| react-native-reanimated | ^3.6.2 | 3.19.5 (needs RN ≥ 0.78) | 3.6.2 |
| react-native-screens | ^3.29.0 | 3.37.0 | 3.29.0 |
| react-native-safe-area-context | ^4.8.2 | 4.8.2+ | 4.8.2 |
| react-native-svg | ^15.0.0 | 15.15.4 | 15.1.0 |
| react-native-gesture-handler | ^2.14.1 | 2.31.0 | 2.14.1 |

Reanimated fails the build outright with *"Unsupported React Native version.
Please use 78. or newer"*. react-native-svg 15.15 fails `javac` with 27 errors —
it compiles against RN internals (`MatrixDecompositionContext.translation`,
`rotationDegrees`) that are package-private in 0.73. Keep these pinned exactly,
or bump React Native.

Because these are pinned to exact versions, npm nests them in
`mobile/node_modules` rather than hoisting, while react-native stays hoisted at
the repo root. Reanimated and gesture-handler both locate react-native by walking
up from their own directory, which then fails. `android/build.gradle` sets
`REACT_NATIVE_NODE_MODULES_DIR` in the root `ext` block — gesture-handler reads
it off `rootProject.ext`, so setting it only on the app project is not enough.
Leave that in place. `app/build.gradle` sets `hermesCommand` for the same
reason — the default path is relative to the React root and misses the hoisted
`node_modules`.

Also added, because they were imported or required but never declared:
`@react-native-clipboard/clipboard`, `@react-native-community/slider`,
`@react-native/metro-config`, `@react-native/babel-preset` (replacing the
deprecated `metro-react-native-babel-preset`), and
`@babel/plugin-transform-template-literals` (needed by Reanimated 3.6's Babel
plugin).

## Not in this build

**Embedded Ghost Mesh (GMP).** `nodejs-mobile-react-native` is not a dependency,
`mobile/gmp-mobile-bridge.js` is imported by nothing, and
`nodejs-assets/nodejs-project/main.js` points at `gmp-core/gmp-bridge.js` and
`gmp-core/gmp-node-manager.js` — paths that moved to `gmp-core/dist/` and that
would not resolve inside an APK regardless, since gmp-core is not bundled into
the nodejs-mobile project.

Consequently `CryptoService.js` (used only by the Ghost Mesh setup modal) has no
crypto backend in this build and throws a clear error if called, rather than
silently returning wrong bytes.

**Peer connections do not work in this build.** The QR / pasted invite carries a
Ghost Address, and resolving one needs the mesh; the direct WebRTC path has no
rendezvous since the signaling servers were removed, so it cannot exchange an
offer and an answer. The mesh bridge (see above) is a test harness, not a
shipping transport. This is the open item that gates the app being usable —
see "There is no signaling server, and no SDP paste".
