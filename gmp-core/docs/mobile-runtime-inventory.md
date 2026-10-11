# Mobile runtime inventory (M0, 2026-09-29)

Reported, not decided. No device was used; nothing here was run on a phone.
Counts are `command grep` over `gmp-core/src` (tests excluded) and `mobile/`.

## M0-1 — desktop runtime floor

Electron 44.4.5 bundles **Node 24.21.0**; `engines` in both package.json files
is `>=22.12.0`. The desktop builds are above the floor and above the
require()-of-ESM threshold link.js's lazy loads need. `createRequire` stays.
`test/electron-runtime-test.js` now constructs nodes under the Electron binary
(ELECTRON_RUN_AS_NODE=1) and runs in both CI packaging jobs. See
ARCHITECTURE_BASELINE.md §15.

## M0-2 — what mobile/ has

| Feature | State | Evidence |
|---|---|---|
| Identity (BIP-39, PBKDF2, keys) | **present** | `src/utils/crypto.js` (@noble), `SetupScreen.js`, `RestoreIdentityScreen.js`; Kotlin `Pbkdf2Module.kt`, registered via `SecureScreenPackage.kt` (native path wired; hang fix **not verified on hardware**) |
| Mesh transport (GMP) | **absent on device**; developer facility only | `AppContext.js:282` + `WebRTCService.setMeshBridge`: a WebSocket to a *desktop* bridge, and it stops at `needs-unlock` because no unlock supplies the phrase. No GMP code runs on the phone |
| Direct transport (WebRTC) | **stubbed / cannot complete** | `WebRTCService.js:406`: "There is no rendezvous to carry this offer" — offer created, never delivered |
| Bootstrap | **absent** | no reference to public peers or bootstrap anywhere in `mobile/src` |
| Relay | **absent** | only TURN mentioned in comments (`session-crypto.js`); no GMP relay |
| Store-and-forward | **absent** | no mailbox, sf-send or queued-message code |
| Calls | **stubbed, gated off** | `utils/capabilities.js`: `CALLS_AVAILABLE = false` (no rendezvous; placeholder media views) |
| File transfer | **absent** | no file-meta / chunk / picker code |
| Invite links | **partial** | QR scan adds a contact (`QRScannerScreen.js` `addPeer`); no deep links (`Linking` used only for `openSettings`) |
| Ghost Mesh setup modal | **gated off** | `MESH_SETUP_AVAILABLE = false` (react-native-quick-crypto absent; CryptoService is a throwing Proxy) |
| Guardian recovery | **gated off** | `GUARDIAN_RECOVERY_AVAILABLE = false` |

In short: mobile today can make and restore an identity and hold contacts;
it cannot exchange a message with anyone.

**Dead files:** none. All 32 source files under `mobile/` are reachable from
`index.js`; no unresolved imports. `gmp-mobile-bridge.js` and
`nodejs-assets/nodejs-project/main.js` were already deleted (commit 1cd5d43).
**Stale doc:** `mobile/MOBILE_BUILD.md` "Not in this build" still describes
both as present. Not edited (report first).

**Shims:**

| Package | Declared | Installed | Imported by |
|---|---|---|---|
| react-native-tcp-socket | no | — | nothing |
| react-native-udp | no | — | nothing |
| nodejs-mobile-react-native | no | — | nothing |
| @noble/curves | ^1.4.0 | 1.9.7 | CryptoService, utils/crypto, utils/session-crypto |
| @noble/hashes | ^1.4.0 | 1.8.0 | same three |
| @noble/ciphers | ^1.2.1 | 1.3.0 | utils/crypto, utils/session-crypto |
| react-native-fs | ^2.20.0 | 2.20.0 | **nothing** |
| react-native-encrypted-storage | ^4.0.3 | 4.0.3 | **nothing** |
| react-native-get-random-values | ^1.11.0 | 1.11.0 | `index.js:8`, a bare side-effect import: the platform CSPRNG for all mobile crypto. (M0 wrongly said "nothing": its grep matched only `from` imports. Corrected in M2.) |
| react-native-quick-crypto | no | — | nothing (CryptoService expects it; Proxy throws) |
| @react-native-async-storage/async-storage | ^1.21.0 | 1.24.0 | AppContext, SetupScreen, RecoveryScreen, recovery, MobileDistributor |
| react-native-keychain | ^8.2.0 | 8.2.0 | utils/crypto |
| buffer | no (transitive via ora) | 5.7.1 | nothing |
| Kotlin Pbkdf2Module | — | in app | utils/crypto via `NativeModules.Pbkdf2` |

## M0-3 — the four boundaries (path B: gmp-core on React Native's runtime)

### 1. net → react-native-tcp-socket

- **Exists:** S1's `GMPTransport`/`GMPConnection`, derived from call sites
  (ARCHITECTURE_BASELINE.md §14); `NullTransport` proves the stack runs with
  `net` blocked; hole punching already goes through the transport.
- **Missing:** the dependency itself; an `RnTcpTransport` mirroring
  `tcp-transport.ts` (137 lines: `connect`, `createServer`, TLS option, abort).
  LAN discovery needs `dgram` → react-native-udp (absent) or off on mobile.
  `link.js` uses `createRequire` for its lazy TCP/LAN loads, which does not
  exist under React Native's module system — that load must become an
  injected default.
- **Weaker than Node?** No for TCP. Background sockets are subject to
  Android's process policy (untested).
- **Effort:** small — one transport file, one load-path change, plus device time.

### 2. fs → a Storage interface

- **Call sites:** 77 `fs.*` calls in 15 files. Heaviest: claim-log 23,
  atomic-file 14, logger 7, file-lock 7, blob-store 4, peer-cache 4,
  metrics 4. All synchronous (`readFileSync` 13, `existsSync` 12,
  `openSync` 7, `fsyncSync` 3, `readSync` 3, `renameSync` 2, ...).
- **Missing:** a Storage interface and an RN backend. The only fs library in
  mobile/ (react-native-fs) is declared but imported by nothing, and is
  **asynchronous only**.
- **The structural problem:** the durability path is synchronous by design.
  `NonceStore.claimSessionKey()` is called synchronously inside the handshake
  (`GMPLink._checkSessionKeyUnique`, `_promoteNonceState`) and must not return
  success until the claim is on disk (I3). With an async-only store, claim
  becomes async and the handshake's claim points must await — a control-flow
  change in exactly the code the I0-I4 trace guards.
- **Weaker than Node — stated now:**
  - **fsync:** react-native-fs has none (Android `FileOutputStream` without
    `getFD().sync()`). **I3 ("a claim reported successful is durable")
    weakens to "handed to the OS"** unless a small Kotlin module provides
    write + fsync + rename + directory sync. With that module it can hold.
  - **O_EXCL (file-lock.ts:123, `'wx'`):** no exclusive create in
    react-native-fs. **Cross-process locking cannot be provided.** On a
    single-process app the multi-writer case I4 defends against does not
    arise, but the guarantee is gone rather than preserved; an in-process
    mutex is the honest replacement, and a second process (a separate
    Android `android:process` service) would break it silently.
  - **Directory fsync (atomic-file.ts:85):** none. A completed rename may not
    survive power loss.
  - **Atomic rename:** `moveFile` → `File.renameTo`, atomic on one
    filesystem, no durability.
  - I0 (record boundaries) and I2 (monotone marks) are logic, not OS — they
    carry over.
- **Effort:** large — the biggest and riskiest of the four; the storage layer
  plus the async ripple into the handshake, and a native durability module
  if I3 is to hold.

### 3. crypto → @noble + native

- **Call sites:** 51 across 19 files: `randomBytes` 14,
  `createCipheriv`/`createDecipheriv` (AES-256-GCM) 9 each, `pbkdf2Sync` 6,
  `randomInt` 4, `createHash` (SHA-256) 4, `getRandomValues` 3,
  `hkdfSync` 1, `timingSafeEqual` 1.
- **Exists:** @noble/curves (X25519, Ed25519 — gmp-core already uses them),
  @noble/ciphers (AES-GCM), @noble/hashes (HKDF, SHA-256, PBKDF2), all
  installed in mobile/. Randomness via `crypto.getRandomValues` needs
  react-native-get-random-values imported first (declared, imported by nothing).
- **Weaker / slower:** `pbkdf2Sync` at 100 000 iterations is used for the
  nonce-store, peer-cache, storage and store-and-forward keys at identity
  load — in JavaScript on a phone that is the same class of multi-minute
  hang Pbkdf2Module was written for. It must go native, and the native module
  is asynchronous, so identity load becomes async.
- **Effort:** medium.

### 4. Buffer → Uint8Array or a polyfill

- **Call sites:** 209 static `Buffer.*` calls in 39 files (`from` 128,
  `concat` 42, `alloc` 22, `isBuffer` 9, `allocUnsafe` 6), 195 `: Buffer`
  type annotations, and ~112 Buffer-only instance methods
  (`toString('hex')` 59, `toString('utf8')` 22, `readUInt32BE` 9,
  `writeUInt32BE` 6, `copy` 6, `writeBigUInt64BE` 5, `readBigUInt64BE` 3).
- **Polyfill:** the `buffer` package present in the tree is **5.7.1, which
  lacks `writeBigUInt64BE`/`readBigUInt64BE`** (checked) — the handshake
  timestamp and the AEAD counter IV would throw. A polyfill needs buffer@6.
- **Other Node modules the stack imports:** `events` (18 files) and `path`
  (12) need RN polyfills; `url` (2), `os` (1), `module` (1, link.js);
  `http`/`https`/`stream`/`readline` only in metrics, cli and bridge (not
  needed on a phone).
- **Effort:** small with buffer@6 + events/path polyfills; large (1-2 weeks
  of mechanical conversion) to go to plain Uint8Array.

## Summary of what is weaker on React Native

Only the fs boundary loses guarantees: **fsync (I3), O_EXCL cross-process
locking (I4's multi-writer defence) and directory fsync have no React Native
equivalent in any library in this repo.** I3 can be restored with a small
native module; cross-process locking cannot, and is replaced by the
assumption of a single process. The other three boundaries lose nothing
(TCP) or only speed (PBKDF2 must be native).

---

# M2 — mobile client profile (2026-09-29)

Scoped and proved on desktop. Nothing implemented; no dependencies added.

## M2-1 — does the session-key claim need to be persisted?

**Verdict: PERSISTENCE REQUIRED — against exactly one attack, and only when
the random number generator repeats.** With a working RNG, in-memory claims
are sufficient.

`test/nonce-persistence-necessity-test.js` records a real session
(HELLO, key-confirmation PING, DATA "pay 100 to carol") and replays it at a
responder in two modes side by side — **P** persisted strict NonceStore,
**M** in-memory claims for the life of the process:

| scenario | mode | replayed DATA dispatched | (key, nonce) reused | refused because |
|---|---|---|---|---|
| 1 healthy RNG | P | 0 | no | PING decryption failed |
| 1 healthy RNG | M | 0 | no | PING decryption failed |
| 2 RNG repeat, same process | P | 0 | yes* | session key already used |
| 2 RNG repeat, same process | M | 0 | yes* | session key already claimed (in memory) |
| 3 RNG repeat, after restart | P | 0 | yes* | session key already used (claim re-read from disk) |
| **3 RNG repeat, after restart** | **M** | **1** | **yes** | — **accepted: the replayed payment is dispatched again** |

**The attack persistence stops.** An on-path observer (a carrier, a hostile
Wi-Fi) records one session to the phone. Later the phone's RNG hands the
responder the same ephemeral it used then — and after the app restarts, so no
in-memory claim remembers the key. The observer replays the recording: the
responder derives the old session key, the recorded PING opens, the recorded
DATA is dispatched again (a replayed message the app treats as new), and
everything the responder now sends reuses (key, nonce) pairs from the old
session — AES-GCM nonce reuse, which leaks the XOR of plaintexts and the
authentication key. The initiator side is symmetric (a replayed HELLO_ACK
against an initiator whose ephemeral repeats).

- **Is it reachable on a single-process, sandboxed phone app?** The sandbox and
  the single process are irrelevant: the attacker needs no access to the
  device, only recorded traffic, which a carrier has. What makes it reachable
  or not is the RNG. With a sound CSPRNG an ephemeral repeat is ~2^-252 —
  unreachable. RNG repeats are not hypothetical on Android: the 2013
  SecureRandom seeding flaw (processes forked from Zygote) produced repeated
  values in shipped wallets. The phone's randomness here comes from
  `react-native-get-random-values` → Android SecureRandom.
- **Where the stored claim does real work:** only there — an RNG repeat that
  spans a restart. Within one process, in-memory claims catch it (scenario 2).
- **I1 without durability across restarts:** holds within a process, and
  across restarts only as long as the RNG does not repeat — i.e. it adds
  nothing beyond the RNG's own guarantee. It is not a meaningful guarantee
  across restarts on its own.
- \* **Found while proving this:** since GM-N1c-1 deferred the responder's
  persisted claim to the first non-infrastructure frame, a repeated key makes
  the responder send its HELLO_ACK proof (and PONG) under the reused
  (key, nonce) *before* the persisted claim is consulted — in P mode too. The
  plaintext is identical to the original's (the replayed initiator nonce;
  empty PONG), so this reveals equality only, not new plaintext. It is the
  N1c-1 residual already documented, now shown to apply to every session
  under RNG repeat, not only relay hops.

**If persistence is kept on React Native** (per-handshake, as today), without
fsync or O_EXCL:

| Invariant | Survives? |
|---|---|
| I0 record boundaries | **yes** — logic, not OS |
| I1 claimed at most once, ever | **weakened** — a claim written in the OS's flush window before a power cut can vanish; combined with an RNG repeat after that reboot, the replay succeeds |
| I2 marks never decrease | **yes** in memory; **weakened** across power loss, same window |
| I3 claim reported successful is durable | **no** — without fsync "successful" means "handed to the OS" |
| I4 merged, never replaced | **only while single-process** — no O_EXCL, so a second Android process would break it silently |

**A cheaper option (proposed, NOT implemented, NOT proved):** the stored
claim exists to catch an ephemeral that repeats across a restart. A durable
**boot counter** — read and incremented once at startup, awaited before the
first handshake, and mixed into every ephemeral key generation — makes
ephemerals differ across restarts even if the RNG output repeats; in-memory
claims cover the process lifetime. That moves the persistence off the
synchronous handshake path to one async write per app start. It needs its
own proof and A/B before anyone relies on it, and a boot counter lost to a
power cut (no fsync) reopens the same double-failure window.

## M2-2 — profile: a phone that establishes sessions, sends and receives DATA, reserves and uses a relay circuit, and deposits/fetches store-and-forward blobs with receipts

| Module | Mark | Why |
|---|---|---|
| identity.ts | REQUIRED | keys and session-key KDF |
| link/frame, session, handshake, keepalive, link.ts, ephemeral-nonce-state | REQUIRED | the session itself |
| transport/transport.ts | REQUIRED | interface (types only); a React Native transport is still to write |
| relay/relay-client, circuit-crypto, relay-protocol, role-separation | REQUIRED | reserve and dial circuits; separation rules |
| storage/store-forward, storage-client, sf-crypto, storage-protocol | REQUIRED | deposit, fetch, receipts |
| events.ts, types.ts, config-defaults.ts | REQUIRED | type-only / constants |
| logger.ts | REQUIRED by import | link.ts imports it; its fs use is file logging (off by default) — a console-only logger removes it |
| public-peer-list.ts | REQUIRED | finds relay/storage hosts; on a phone the list can be a bundled JSON import instead of `fs.readFileSync` |
| nonce-store, claim-log, file-lock, atomic-file | REQUIRED **per M2-1** | persisted claims; or replaced by the boot-counter design if that is proved |
| link.js (GMPNode) | REQUIRED as the coordinator **today** | it is a monolith that also wires every excluded subsystem below; a phone needs either it (with those loaded but idle, and their `fs`/`dgram` imports shimmed for the bundler) or a smaller client composition |
| sf-scheduler.ts | OPTIONAL | the app can drive polls from React Native AppState / background fetch instead |
| peer-cache.ts | OPTIONAL | last-known-good hosts for the ladder; useful, not essential |
| bootstrap.ts | OPTIONAL | only needed to join the mesh; the profile reaches contacts through relays |
| peer-reputation.ts | OPTIONAL | a client can live without bans |
| key-rotation.ts | OPTIONAL | rotation is rare; can stay desktop-only initially |
| ghost-address.js | OPTIONAL | mobile already has its own `utils/ghost-address.js` |
| lan-discovery.ts | OPTIONAL | needs react-native-udp; off on mobile at first |
| hole-punch.ts, nat-detector.ts | EXCLUDED | a phone usually takes a circuit rather than punching |
| relay/relay-server.ts, relay/token-bucket.ts | EXCLUDED | a phone does not relay |
| storage/storage-server.ts, storage/blob-store.ts | EXCLUDED | a phone does not store for others |
| routing-table.ts, forwarder.ts, topology-announce.ts | EXCLUDED | a phone does not route or forward |
| peer-exchange.ts | EXCLUDED | a phone does not serve a peer list |
| rate-limiter.ts, network-health.ts | EXCLUDED | inbound limiting and mesh health are public-peer concerns |
| metrics.ts, cli.ts, gmp-bridge.ts, gmp-node-manager.ts, node-registry.ts, config.ts, paths.ts | EXCLUDED | desktop application layer (HTTP server, CLI, WebSocket bridge, env/file config); the app passes explicit config and a data dir |
| transport/tcp-transport, memory-transport, null-transport | EXCLUDED | replaced on the phone by a React Native transport; the other two are test harnesses |
| bip39-english.ts | EXCLUDED | used only by the CLI; mobile has its own wordlist |

## M2-2 — the four boundaries recounted against the profile

Per module, `command grep` (static calls; "Buf-methods" = Buffer-only
instance methods such as `toString('hex')`, `readUInt32BE`, `writeBigUInt64BE`):

| Group | fs | crypto | Buffer.* | Buf-methods | net/tls/dgram |
|---|---|---|---|---|---|
| **Core REQUIRED** (22 modules: identity, link/*, relay client side, storage client side, events, types, config-defaults, logger, public-peer-list) | **11** (logger 7, public-peer-list 2, store-forward 2) | **23** | **128** | **54** | **0** (types.ts: type-only) |
| + link.js (coordinator) | 1 | 3 | 12 | 12 | 0 (lazy loads) |
| + nonce store group (per M2-1) | 47 | 14 | 28 | 18 | 0 |
| OPTIONAL peer-cache.ts | 4 | 4 | 5 | 3 | 0 |
| *whole gmp-core, for comparison (M0)* | *77* | *51* | *209* | *~112* | — |

Of the core's 11 fs calls, none is essential: logger's 7 are file logging,
public-peer-list's 2 read a file that can be a bundled import, and
store-forward's 2 read its own state file (async-tolerant, below).

## M2-3 — what the profile still stores

| State | Critical path? | Notes |
|---|---|---|
| Identity (seed) | no — read once at start, async | mobile already keeps it in `react-native-keychain` |
| Peer cache | no — loaded at start, saved batched | async-tolerant |
| Store-and-forward state (outbox, cursors, seen-set, contacts) | no | written after each operation; losing the last write costs a duplicate fetch (seen-set / cursor) or a missing "delivered" (outbox) — no security property depends on it. Async-tolerant |
| Public-peer health | no | async-tolerant |
| **Session-key claims (M2-1)** | **yes, if per-handshake**: the claim must be durable before the first non-infrastructure frame is sealed or dispatched | this is the only synchronous, durability-critical store left. The boot-counter design would reduce it to one async write per app start |

The real list is one item: the claim store, or its boot-counter replacement.

## M2-4 — Buffer and crypto, scoped

**Buffer.** Core REQUIRED: 128 static calls + 54 Buffer-only methods
(~182 sites); with link.js and the nonce group, ~258. Methods used across all
REQUIRED modules: `Buffer.alloc`, `allocUnsafe`, `compare`, `concat`,
`from`, `isBuffer`; `.copy`, `.fill`, `.includes`, `.indexOf`,
`.readBigUInt64BE`, `.readUInt16BE`, `.readUInt32BE`, `.readUInt8`,
`.slice`, `.subarray`, `.toString('hex' | 'utf8')`, `.writeBigUInt64BE`,
`.writeUInt16BE`, `.writeUInt32BE`, `.writeUInt8`.
**buffer@6.0.3 provides every one** — checked by loading the package
(fetched to a scratch directory, not added): nothing missing, BigInt
read/write round-trips, `slice` is a view as in Node. (5.7.1, in the tree
today, lacks the BigInt pair.) Carrying the polyfill is a one-line install
plus a global assignment; converting ~182–258 sites to Uint8Array is days of
mechanical edits in the most security-sensitive code. **The polyfill is
smaller.** S1's move of the transport interface to Uint8Array was one
declaration, not a precedent for the bulk.

**crypto.** Node `crypto` functions in REQUIRED modules:
`createCipheriv`/`createDecipheriv` ('aes-256-gcm', one-shot use) 8+8,
`randomBytes` 11, `randomInt` 4, `createHash('sha256')` 4,
`getRandomValues` 3, `hkdfSync` 1, `timingSafeEqual` 1, `pbkdf2Sync` 5.
@noble covers all but PBKDF2's speed: @noble/ciphers `gcm`, @noble/hashes
`sha256`/`hkdf`, `getRandomValues` (already polyfilled on mobile) for
`randomBytes`/`randomInt`, a constant-time compare is a few lines. Every
call site uses GCM one-shot (update + final + tag), so a thin
Node-compatible shim over @noble is feasible without touching callers.

**PBKDF2** (100 000 iterations; in JavaScript on a phone this is the
multi-minute hang class). Going native makes these asynchronous. Every call
site the change touches:

| Site | Today | With a native (async) PBKDF2 |
|---|---|---|
| `identity.ts:47` `deriveIdentityFromSeedPhrase` (@noble, sync inside an async function) | already returns a Promise | callers unchanged |
| `link.js:248-249` GMPNode **constructor** (`seedPhrase` option): peer-cache key, `deriveNonceStoreKey` | sync in a constructor | must move into `loadIdentity` (constructors cannot await) |
| `link.js:697-698` `loadIdentity`: peer-cache key, nonce-store key | sync inside an async method | await; no caller change |
| `nonce-store.ts:266` `deriveNonceStoreKey` (exported, sync); `nonce-store.ts:305` NonceStore **constructor** `seedPhrase` option | sync | becomes async; the constructor option must go |
| `node-registry.ts:188` | sync | excluded on mobile |
| `peer-cache.ts:44` PeerCache **constructor** `seedPhrase` option | sync | must move out of the constructor (optional module) |
| `link.js:722` `_startStorage` | sync | excluded (storage host) |
| `gmp-node-manager.ts:320` store-forward state key | sync | excluded (the mobile app supplies its own key) |

So: one exported function turns async, two constructor options move into
`loadIdentity`, and `loadIdentity` gains awaits. The Kotlin `Pbkdf2Module`
already exists and is registered.

## M2-5 — housekeeping

- `mobile/MOBILE_BUILD.md` "Not in this build": corrected — it described
  `gmp-mobile-bridge.js` and `nodejs-assets/.../main.js`, deleted in 1cd5d43.
- Declared-but-unimported packages:
  - `react-native-get-random-values` — **keep.** It *is* imported
    (`index.js:8`, bare import) and supplies the CSPRNG; M0 was wrong.
  - `react-native-fs` — **drop** (recommendation). Unused, and not the right
    tool if the claim store comes to the phone: it has no fsync, so a durable
    store needs a small native module anyway, which would cover file I/O too.
  - `react-native-encrypted-storage` — **drop** (recommendation). Unused;
    `react-native-keychain` (used) already holds the secrets.

## Revised effort for the port as scoped

| Boundary | Scoped work | Estimate |
|---|---|---|
| net | one React Native transport (~150 lines, mirrors tcp-transport); replace link.js's `createRequire` default with injection | small |
| Buffer | buffer@6 polyfill (+ `events`, `path` polyfills) | small (hours) |
| crypto | Node-compatible shim over @noble for ~23-40 sites; PBKDF2 native, making `loadIdentity` and one export async | small-medium |
| fs, without per-handshake claims | 11 core sites, all async-tolerant (console logger, bundled peer list, async SF state) | small |
| fs, **with per-handshake persisted claims (M2-1 as the code stands)** | Storage interface under nonce-store/claim-log/file-lock/atomic-file (47 sites), sync → async through the handshake's claim points, a native write+fsync+rename module; I3 and I4 as above | **large** — the one large item, and it is the M2-1 decision |
| coordinator | GMPNode as-is (excluded subsystems loaded, their imports shimmed for the bundler) or a smaller client composition | medium |

The size of the port is set almost entirely by one choice: keep per-handshake
durable claims on the phone (large, and I3 still weakens without a native
fsync module), or prove a boot-counter replacement (small, but a new security
argument). Not decided here.

## M3-4 — mobile profile decisions (recorded 2026-09-30)

- **Claim strategy: in-memory claims + durable boot counter.** No claim store
  on the phone, no Kotlin fsync module. Reasoning: M2-1 showed persisted claims
  matter only against an RNG repeat across a restart; GM-M3-2' makes that
  repeat unable to reproduce an ephemeral (`ephemeral = HKDF(rng ‖ bootCounter
  ‖ processSequence)`), with the counter read from storage and advanced
  write-ahead, and a refusal to handshake if it cannot be persisted.
  **Residual (M3-2'-2 g): rollback.** If the counter file is restored from a
  backup, cleared, or lost in the OS flush window at a power cut (React Native
  has no fsync, so "persisted" means "handed to the OS"), the counter re-issues
  values it already used, and cross-restart non-repetition is gone for that
  range until the counter climbs past it. The phone then has no cover at all
  across restarts. The in-memory LRU covers only the current run, and it is
  floodable (entries go in before key confirmation), so it is not a guard.
  Desktop keeps its persisted claim log as partial cover.
- **Buffer: buffer@6 polyfill.** Covers every Buffer method used (M2).
  The 182–258 call sites are not converted to Uint8Array.
- **Coordinator: one link.js.** Excluded subsystems are gated by profile config
  and loaded lazily (S1). No mobile fork: two coordinators diverge on the wire.
- **Dependencies:**
  - `react-native-get-random-values`: keep (bare import at `index.js:8`
    supplies the RNG).
  - `react-native-fs`: drop.
  - `react-native-encrypted-storage`: **not dropped.** The check the brief
    required failed. The keychain holds only the keypair
    (`crypto.js:352`); message history, the wrapped recovery bundle, all 7
    Shamir fragments (threshold 3), the invite code and peers are in plain
    AsyncStorage. See docs/TASKS.md, "Mobile secrets outside the keychain".
