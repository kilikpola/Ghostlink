# GMP Refactor & Hardening — Work Report

**Period:** 2026-09-28 → 2026-09-30
**State:** all work uncommitted in the working tree (nothing committed or pushed).
**Verification at end (after GM-N2):** build clean · `npm test` **47 suites / 1000 assertions / 0 failing** (LAN discovery skipped itself: multicast filtered on the test network) · strict-mode I0–I4 trace 21/21 · pre-refactor build ↔ current build interoperate over TCP, including a relay-hop identity dialling an old node (28/28).

Detail lives in: `ARCHITECTURE_BASELINE.md` (§1–13), `PROTOCOL_SPEC.md` (§3, §8.4, §15), `docs/relay-metadata.md`.

---

## Phase summary

| Phase | What changed | Key evidence |
|---|---|---|
| **S1 — Transport** (started by Kimi, verified) | `GMPNode` takes an injected transport; `TcpTransport`, `MemoryTransport`; link.js no longer imports `net`/`tls` | two nodes handshake over memory transport |
| **S2 — Link split** | `link.js` 2062 → node only; new `link/frame.ts`, `session.ts`, `handshake.ts`, `keepalive.ts`, `link.ts` | 89 new assertions; old↔new wire interop identical, counters identical |
| **Self-check** | handshake refuses HELLO/HELLO_ACK carrying our own NodeID (not penalised) | reflected HELLO/ACK + self-dial tests |
| **S3 — Config injection** | config precedence explicit > env > file > default; file layer (was dead) works; node-level modules no longer read global config; `dataDir` per node | option matrix test; 3 nodes in one process fully isolated |
| **S4 — Event contract** | `src/events.ts` — 11 maps / 26 events; emitters typed; `link.js` under `@ts-check` | census + runtime payload validation; compile fails on wrong payload |
| **S5 — Multi-instance bridge** | `NodeRegistry`: node chosen by seed identity; per-session event delivery; `startBridge().close()` | 36 WebSocket assertions + real-TCP standalone bridge smoke test |
| **GM-N1 — Relay tier** | 0x0C–0x10; signed vouchers (30 min, renew at 80%); quotas; throwaway hop identities; end-to-end sealed circuits; relay metrics | 10 MiB over real TCP; relay sees no identity/key/plaintext |
| **GM-N1b — Corrections** | role separation (`roles`, `operator`), record padding (interactive/bulk), ephemeral nonce state (memory only), Sybil rate limit for CGNAT | A/B runs per change; strict-mode I0–I4 trace holds |
| **GM-N2 — Sealed store-and-forward** | infrastructure range 0x0C–0x15; STORE/FETCH/DELETE 0x11–0x15; bucket addressing (host never sees a tag); sealed blobs in 4K/64K/1M at-rest buckets; exact-N fetch with decoys; throwaway identity per operation; storage role + operator-level separation; TTL/LRU hard deletes; `gmp storage-peer` self-host; UI sent (stored) / delivered from protocol events only | `store-forward-test` 71, `storage-selfhost-test` 7 (real TCP, spawned CLI); **finding: FETCH_DELETE gives the host the exact IP-level edge** (docs/store-and-forward.md) |
| **GM-N2b — Delivery oracle removed** | 0x15 FETCH_DELETE retired (byte kept in the infra range); blobs leave by TTL/LRU only; DELIVERED from a sealed receipt blob in the sender-direction bucket, deposited at the recipient's next poll; fetch cursors `{bucket, since}` + seen-set; decoys are fake channels with real cursors; bucketCount 64, release-pinned, one-TTL overlap on change | `store-forward-n2b-test` 29, `store-forward-test` 68, `storage-selfhost-test` 7, `sf-anonymity-sim-test`: **a week of daily messages still identifies the recipient's address in 60–100 % of cases at 10–1000 users** |
| **GM-N2c — Fixed buckets** | bucket = f(sharedSecret, direction), no epoch; bucketCount 1 at launch (growth rule from measured blob cost); 5-min cursor rounding on; ladder dial starts staggered 500 ms, dial cap 2.5 s; key-rotation-test on port 0; inferred operator removed | sim: 7-day candidates stay at day-1 occupancy (201 of 1000) instead of converging to 1.8; residual overlap 87 % at 10 contacts; ladder live-host reached 10/10 behind 3 dead, worst case 7.51 s |
| **S1 re-verified** | link.js had no `net` since phase S1; remaining leaks fixed: hole punching via transport, lazy TCP/LAN defaults, data typed `Uint8Array`, `separation` declared; `NullTransport` with no Node dependency | `null-transport-test` 9/9 with net/tls/dgram blocked (handshake, DATA, relay circuit, store-and-forward + receipt, hole punch); boundary audit in ARCHITECTURE_BASELINE §14 |
| **GM-N3 (partial)** — ladder, LAN in TS | bootstrap ladder cache → LAN (known peers only) → public (shuffled, 3 in flight) → peer exchange → manual; first success cancels the rest; public-peer demotion with backoff; `lan-discovery.ts`; dials abortable down to the TCP connect | `bootstrap-ladder-test` 20: worst case 7.51 s (< 8 s); real TCP from desktop: shipped host 790–994 ms, 5 unroutable hosts 4.0 s. **Not done: N3-1 (only 1 real host), N3-3 (no device attached), N3-4 (needs hosts)** |
| **GM-N1c — Corrections** | HELLO ephemeral bit removed (cleartext selector); every responder session keeps nonce state in memory until its first non-relay frame, then claims durably before sealing/dispatching it; relay observes hops from their first frame; role rules applied by NodeID before the dial; circuit FS (no), Sybil burst and per-circuit class written down; file transfer must use its own bulk circuit (§15.5) | replay attack written out and tested; strict-mode trace incl. promotion path 20/20; interop 28/28 |
| **GM-M3-1 — Transcript binding** | every HELLO / HELLO_ACK field traced from the derivation code; varying a field cannot yield a second HELLO_ACK under one (key, nonce). Related §6 finding: infrastructure replies (RELAY_RESERVATION, FETCH_RESPONSE) on never-promoted sessions reuse (key, nonce) under an RNG repeat | `transcript-binding-test` 11 |
| **GM-M3-2' — Ephemeral non-repetition** | `ephemeral = HKDF(rng ‖ bootCounter ‖ processSequence)`; counter from storage, write-ahead, under a file lock, refuses on persist failure and on an unreadable/garbled file; initiator + responder + hop identities; unilateral (wire unchanged). SessionKeyLRUSet built unconditionally, capacity raised, documented as floodable and NOT the guard | `ephemeral-nonrepeat-test` 24, `boot-counter-production-test` 9 (A: boots 0,0,0 on the shipped path; 30/200 duplicate counters across processes), trace 21/21, interop 28/28. **Residual: counter rollback** |
| **GM-M3-1b-2 — Optional-control sweep** | startup assertion (`_assertSecurityControls`); limiter built unconditionally so HELLO/handshake timeouts always run; `_sendHELLO` no longer draws from the bare RNG; hop/storage sessions require an ephemeral source | `handshake-timeout-default-test` 5 (A: 30/30 silent sockets open; B: 0/30) |
| **GM-M3-1b-3 — Harness** | run-all forces FAIL on a ✗ marker, a self-reported failure count, or a zero exit with no summary and no skip marker; one summary regex (the old one read the total as the failure count) | caught `link-modules-test` after the seventh link/ module |
| **GM-M4-1 — One construction path** | `createGMPNode` (src/node-factory.ts) is the only place a GMPNode is built: the manager (so every entry point) and all 36 test files that built nodes by hand (135 sites); run-all refuses a run with `new GMPNode(` anywhere else. Entry-point options live in src/entry-points.ts, called by cli.ts, `gmp storage-peer` and electron/src/main.js. `argv[1].includes('test')` removed from GMPNode (a production path containing "test" had bootstrap and LAN off); tests isolate through env. Boot counter starts at 1; EphemeralKeySource refuses 0. **Found on the way:** withFileLock let two processes hold one lock (an empty just-created lock read as stale; release deleted by path) — fixed | `production-construction-test` 43: each of cli / public-peer / storage-peer / Electron in its own process, restarted. **Reverting each of the four bugs fails it — all four, with the startup assertion on and with it off.** `file-lock-race-test` 11 (A: 150 of 600 locked increments lost) |
| **GM-M4-1b-1 — Claim log under the broken lock** | REPRODUCED: 16 processes x 300 fingerprints on one claim log, pre-fix lock: 8 session keys accepted by two processes over 4 rounds, 81 live locks broken as "stale" — V3's closure and I1 across processes did not hold under contention (recorded as V6 in nonce-store.ts). Nothing in the log's structure prevents it: the at-most-once check is read-then-append, made atomic only by the lock. Also fixed: a backward clock step broke a live same-host lock without the pid check. Read-only checker for the deployed log: scripts/check-claim-log.mjs | `claim-lock-race-test` (A 8 doubles / B 0, permanent), `file-lock-race-test` 12; checker validated on a real duplicate (2 found = 2 reported won twice, files byte-identical) |
| **GM-M4-1b-2 — Environment sniffing** | sweep table below; one behaviour branch removed (claim-log asserts on NODE_ENV=test) | `env-sniffing-test` 4 (A: 2 hits) |
| **GM-M4-2' — Admission** | outbound close no longer decrements the global count; resource self-measurement to stdout (on for the public peer) incl. distinct-address counts; global concurrent cap 540 (PROVISIONAL, from 1 fd + ~340 KiB per connection against Railway's 0.5 GB floor, 40 % headroom); per-address token bucket (N1b-4) 256 / 30 per min, IPv6 by /64; no per-address concurrent cap; GMP_RATE_LIMIT_MAX_PER_IP retired with a config warning. **CPU, not memory, binds first: ~100-130 peers (topology re-signing per join)** | `limiter-accounting-test` 3 (A: -5), `admission-cgnat-test` 11 (200 from one address over 60 s all admitted; 5000 in 1 s: 256 admitted, 4744 address-rate) |
| **GM-M4-3 — strictState by role** | on for public peer / relay / storage, off for clients, explicit wins; refusals operator-actionable, seed change = one refusal + one combined `mv` | `strict-role-test` 16 (the printed command is executed and the node then starts) |
| **GM-M4-4 — Mobile secrets** | sealed storage (XChaCha20-Poly1305, data key in react-native-encrypted-storage, key name as AAD, no plaintext fallback); every key classified; stored Shamir fragments and the never-read invite code retired and deleted at upgrade; fragments made on demand for copy-out only | `secret-storage.test` 49 (A on HEAD: 5 AsyncStorage importers, 2 fragment writes); mobile suite green; **not run on a device** |
| **GM-M4-5 — Nonce-reuse witness** | relay RELAY_RESERVATION and storage FETCH_RESPONSE captured twice under one (key, counter) with the counter bypassed; C1^C2 == P1^P2 over 522 / 4193 bytes; B refuses | `nonce-reuse-witness-test` 16; with the boot counter removed it FAILS (both B cases: second reply, shared key) |
| **GM-M5-1 — Topology** | own edges signed once per validity window and cached; each peer shown a keyed sample of <= 8 (fixed per address key and 24 h epoch, so fresh identities add nothing); nothing flooded, received announces stored only; only new or re-signed edges sent; routes kept alive by local rebuild from fresh edges; routes to NAMED NodeIDs / Ghost Addresses found on demand (PEER_REQUEST routeQuery, TTL 3, fan-out 8, 30/min per link); peer exchange shares only dialled peers, sampled, rate-limited per address; inbound peers kept in the cache for key rotation WITHOUT their address. Found on the way and fixed: accept-time rate limits banned the whole address for 24 h (M4-2' had armed it); the first sampler cost 9 s per round at 540 peers | capacity (same harness, lab per-address bucket): before, never above ~140 held, max lag 3.8-7.5 s, 105-113 dropped per step; after, 540 held, 0 dropped, p99 29 ms, 113 KiB/conn. `membership-disclosure-test` (A: 30/30 via topology + 20 via PX on one visit, 633 signatures for 30 joins; B: 8 via topology, 36 signatures). **Restated 2026-10-11 (M6-1c-fix-6e): the B run's "0 via PX" was measured through a dead channel** — see "M5 disclosure figures, restated" below. Bound: 8 per address key per epoch — not a defence against many addresses (50 keys see ~half of 540) |
| **GM-M5-2 — Fragment migration** | legacy recovery copies (stored fragments; 0.0.x wrapped key and phrase check) sealed and kept unless a matching modern bundle exists or can be rebuilt from them; otherwise the user confirms the phrase (verified by re-derivation, the bundle, or the 0.0.x check), a PBKDF2 bundle is written, then they go; manual fragments 3-of-5 with instructions and a hand-out checklist. Found: 0.0.x wrapped keys used a 32-bit hash as "SHA-256", and 0.0.x "keypairs" were random, unrelated bytes | `legacy-recovery-migration.test` 33 (install that cannot re-derive: kept, wrong phrase deletes nothing, right phrase -> same key restorable on a fresh device); mobile suite green; **never built or run** |
| **GM-M5-3 — Deploy diagnostics** | read-only claim-log check (src/claim-log-diagnostic.ts) runs at startup on the public peer and storage peer, before the node can compact the log, and on the standalone bridge when a seed is set; the bridge says at startup that it is not a public peer | `claim-log-diagnostic-test` 14: zero fs mutations with every mutator trapped, files byte/mtime/inode-identical; real `gmp public-peer`: verdict 240 ms after launch, before the node starts; first resource sample at 1.4 s. **The Railway start command is not in the repo; `npm start` would run the standalone bridge** |

### M4-1b-2 sweep — code that branches on where it runs

| Where | Branch | Changes behaviour? | Action |
|---|---|---|---|
| gmp-core link.js (M4-1) | `argv[1].includes('test')` → bootstrap and LAN off | yes | removed in M4-1 |
| gmp-core claim-log.ts:62, :480 | `NODE_ENV === 'test'` → deep boundary asserts on; a violation THROWS instead of logging CRITICAL | yes | removed; `GMP_DEBUG_ASSERTS` only, set explicitly by the harness |
| gmp-core cli.ts:306 | `process.argv.slice(2)` | no — argument parsing | none |
| gmp-core gmp-bridge.ts:503 | `argv[1]` is this file → run standalone | no — main-module detection, not environment | none |
| gmp-core file-lock.ts | `os.hostname()` in lock records | no — liveness judgement for locks | none |
| gmp-core gmp-bridge.ts, metrics.ts | `localhost` / loopback checks | no — access control on the connecting address | none |
| gmp-core entry-points.ts / electron main.js | `app.isPackaged` → data dir under userData | yes, deliberately: the packaged app's package dir is read-only | kept; covered by production-construction-test |
| electron main.js:96 | `--dev` flag → devtools on, updater off | yes, but an explicit operator flag, not detection | kept |
| electron main.js:244 | `process.defaultApp` → deep-link registration via argv | yes — Electron's documented dev/packaged distinction for protocol registration | kept |
| electron main.js, preload.js | `process.platform` → icons, badges, window-all-closed | yes — platform adaptation | kept |
| web src/p2p/p2p-connector.js | `window.location` → which bridge URLs to try | yes — connects to the host it was served from | kept |
| mobile src | none found (`__DEV__`, `NODE_ENV`, platform sniffing) | — | — |

### M3-1b-2 sweep — security controls that could be absent

| Control | Default when absent | Production supplier before | Silently lost | Now |
|---|---|---|---|---|
| `nonceStore` | null | none (fixed earlier) | persisted replay claims | built unconditionally; asserted |
| `sessionKeyLRUSet` | null | none | in-process session-key dedupe | built unconditionally; asserted |
| `ephemeralSource` / boot counter | constant 0 without `dataDir` | **none: cli, storage-peer, Electron pass no dataDir** | cross-restart non-repetition on every shipped node | counter in the process-wide data dir when no dataDir; asserted |
| boot-counter file unreadable / garbled | treated as 0 | — | silent rollback | refused, file untouched |
| bare-link `_sendHELLO` | bare RNG keypair | not reachable in production | non-repetition | uses the caller's explicit keypair, else throws |
| hop / storage session `ephemeralSource` | — | required | — | required, refused if absent |
| `rateLimiter` (HELLO/handshake timeouts) | null | **none** | timeouts: silent sockets held forever | built unconditionally; asserted |
| admission caps (per-IP / global) | off | none | connection-flood limits | **still off by default**, decision in TASKS.md |
| `GMP_STRICT_STATE` | false | none | claims/state failing auth are discarded, node runs on | kept configurable (seed rotation would lock clients out); unattended default needs a decision |
| `reputation` | always built | — | — | asserted |
| `bindingRateLimiter` | only if `isPublicPeer` | isPublicPeer never forwarded (known #1) | public-peer binding limits | unchanged; open decision #1 |

#### Variant: control live, counter correct, firing unrecorded (M6-1c-fix-6c)

The control exists, runs, and keeps its numbers right — but when it FIRES,
nothing is written down, so in the field a firing control and a quiet one
look the same. Each instance below was found on 2026-10-10.

| Control | What fired, unrecorded | How it surfaced | Now |
|---|---|---|---|
| Accept-time refusals (global cap, per-address rate) | `RateLimiter.checkConnection` refused, `socket.destroy()`, emitted `rate-limited` — and the only subscriber (link.js) returns early for accept-time events. Counter (`_globalCount`) correct throughout. | fd-cap work (M6-1c-fix-6b-follow): "refuse visibly" needed a log line that did not exist | `rate-limiter/connection-refused` at WARN with code `GLOBAL_CAP` / `FD_LIMIT` / `ADDRESS_RATE`; first at once, then a count per `GMP_REFUSAL_LOG_INTERVAL_MS` (fd-cap-test: 56 closed = 56 logged) |
| Listener (post-bind server errors) | `server.on('error', reject)` on an already-settled promise: errors after bind swallowed | M6-1c-fix-2 had to probe the live host from outside | `link/listener-error` at ERROR with code, syscall, stillListening (listener-error-test A 0 lines, B 1) |
| Connection cap vs descriptor limit | a cap log line that would only have appeared when the clamp bites | review of M6-1c-fix-6b-follow: silence read as "not clamped" and as "line missing" alike | `link/connection-cap` on EVERY start: configured cap, soft/hard limit, effective cap, clamped yes/no (INFO, or WARN when clamped) |

Not a control of ours but the same shape: libuv sheds connections at the
descriptor limit and reports nothing to JavaScript. Covered by the clamp (the
node refuses first, logged) and by the /proc ground truth in the resource log.

#### M5 disclosure figures, restated (M6-1c-fix-6e)

The vacuous-negative sweep found that M5's "0 via peer exchange" was read
through a channel that could not have shown anything: every in-memory node
arrives from 'memory.local', so the hub's per-address PEER_REQUEST limit
answered the first member and dropped every later request, the stranger's
included. Re-run 2026-10-11 with the channel working (hub's request interval
lifted so the per-requester SAMPLE is what is measured). Network rows: N = 30,
three runs, identical; sampler rows: N = 540, 100 random secrets.

| Figure | Published (M5) | Restated | Positive control in the same test |
|---|---|---|---|
| members learned via topology, one visit | 8 | **8** with only member links; **7** when the hub also holds an outbound link (it takes one of the 8 slots). Bound unchanged: <= 8 NodeIDs per address key per epoch | the stranger's lsdb holds 7-8 members (non-zero by its own reading) |
| members learned via peer exchange, one visit | 0 (**dead channel**) | **0**, now through a live channel | the hub's outbound peer reaches the stranger through PX (pool 1) |
| union after 6 visits from one address | <= 8 | **8** (7 with the outbound peer) | as the two rows above |
| guessed NodeIDs found by route query | 0 of 8 | **0 of 8** | a query for a NodeID the asker holds is answered |
| route-query burst on one link | cut to budget | **cut**: 1 answered of 40 (9 of the 10-query burst already spent by the probes above) | answered > 0 |
| hub signatures for 30 joins | 36 | **40-42** (1.3-1.4 per join; was 633 before M5) | counted by wrapping the signing functions; > 0 |
| one address, daily epochs to see all 540 | median ~466 | **median 484 (282-1063)** | sampler returns 8 per pick (asserted) — a value channel, never dead |
| one epoch, address keys to see all 540 | median ~447 (330-675) | **median 474 (298-886)** | same |
| coverage at 10 / 50 / 100 / 200 keys | ~65 / ~half / ~74 % / ~94 % | **75 (13.9 %) / 278 (51.5 %) / 406 (75.2 %) / 504 (93.3 %)**, medians; ranges 58-80, 240-326, 356-455, 468-531 | same |

Only the peer-exchange zero was measured through a dead channel; its value
does not move. The sampler figures were never at risk (value channel); they
move by sampling only (one secret per run before, 100 secrets now), and the
"10 keys" figure was low: ~65 published against a median of 75. Use the
restated column in anything user-facing.

#### Fifth family member: a test that proves a negative by observing nothing (M6-1c-fix-6d)

An assertion of the form "never happened / not called / no event / 0 of N"
passes just as well when the channel that would have shown the event does not
work. Found by the interop relay pairing (M6-1c-fix-6c): "the relay never saw
the real NodeID" passed while the relay emitted nothing at all for relay
sessions. The rule is now structural, not remembered (M6-1c-fix-6e):
test/helpers/assert-absent.mjs `assertAbsent({ channel, control, absent,
message })` throws when called without a control thunk, runs the control
first, and reports the absence as VACUOUS (a failure) when the control
observes nothing — the same reasoning that made the security controls
non-optional. All 41 below (38 + the 3 repaired channels) go through it; new
negatives are meant to. A plain assert() can still express a negative; no
regex can find them all (two were missed this time), so the helper is the
guard, and test/assert-absent-test.js proves its refusals.

Sweep (gmp-core/test, 2026-10-11): 273 assertions matched a negative-form
pattern; 173 are value checks (a return value, a thrown error, a byte
comparison — the value is the observation). 100 observe an absence through a
channel (event list, spy, log capture, connection counter, file or source
scan). 62 already had a positive control in the same file; 38 did not. Two
more were found only because a new control failed (the regex missed their
wording), so the extraction is not exhaustive.

| Assertion (file) | Channel | Control before | Added |
|---|---|---|---|
| address not banned (admission-cgnat) | reputation.isBanned | no | a banned address reports banned |
| no bootstrap/failed, no retry-scheduled (bootstrap-role 1, 2) | log parse | no (only check-trigger shown) | client run: parser counts both |
| no fs mutation attempted (claim-log-diagnostic) | monkeypatched fs | no | same trap catches writeFileAtomicSync |
| no full fingerprint in report (claim-log-diagnostic) | report JSON | no | the two duplicated fingerprints are named by prefix |
| refused claim writes nothing (claim-log) | file size | no | an accepted claim grows the file |
| every DEFAULTS key classified (config) | key diff | no | a synthetic unclassified key is caught; 72 keys |
| no node module imports config.js (config) | source regex | no | the regex finds the six allowed importers |
| no NODE_ENV / argv sniffing (env-sniffing) | source regex | no (A run only, historical) | rule flags both shapes, passes a comment |
| no plaintext IP / NodeID on disk (encryption-at-rest) | file read | no | the same file decrypts to the record |
| impostor's message not delivered (handshake-impersonation) | target message log | no (connection channel only) | the real victim's message is delivered |
| no half-open link left (handshake-timeout-default) | node.links | no | node held 30 links before the timeout |
| peer list empty before connecting; stale peer dropped (lan-discovery) | getStatus / getNodeIds | no | list shows bob after connect; fresh peer listed — UNVERIFIED: never run (the suite skips at [1] without multicast loopback on UDP 49698 / 239.255.42.98; TASKS.md "LAN discovery controls") |
| link/ imports only allowed modules (link-modules) | specifier regex | no | 14 specifiers extracted |
| PX gives a stranger no member (membership-disclosure) | PX candidate pool | no — and the channel was DEAD: every MemoryTransport node is 'memory.local', so the hub's per-address PEER_REQUEST limit answered only the first member and dropped the stranger's request | hub interval lifted so the sample is what is measured; hub's outbound peer reaches the stranger (pool 1), still no member |
| link.js has no net / tls import (memory-transport) | source regex | no | regexes match tcp-transport.js |
| message never reached E (multi-hop TTL) | E 'message' event | no — and the channel could not fire: the mock payload is not sealed to E | forwarder spy: 0 arrivals at TTL 3, 1 with enough hops |
| nothing leaked into GMP_DATA_DIR (multi-instance) | filename regex | no | pattern matches B's own state files |
| ephemeral state writes nothing (nonce-invariant-trace I3-eph; relay-ephemeral-nonce 9) | directory listing | no | a durable claim in the same dir changes it |
| null transport imports nothing, no Node global (null-transport) | source scan | no | both checks fire on tcp-transport.js |
| refused session's frame never dispatched (relay-ephemeral-nonce) | relay 'message' | no | an accepted session's frame reaches the same listener |
| relay-only host never dialled (relay-roles 2) | dial spy | no | listed bootstrap host is recorded |
| refused host holds no reservation (relay-roles 3, 6) | relayServer stats | no | a successful reservation counts 1 |
| no link carrying N's real NodeID at the relay (relay-roles 4, x2) | R.connections | no — and the channel was WRONG: a relay keeps a new link 'pending' in links, outside connections | checks moved to links (bounded wait for the refused link's close); control: the bootstrap host holds N's link |
| accept counter unchanged (relay-roles 4b; role-separation-merge) | accept spy | no | counter counted the reservation's own connection |
| no revoked NodeID in a peer list (seed-leak) | file read | no | the scan finds the current NodeID |
| storage peer persisted no claim / peer (storage-selfhost) | files in data dir | no — an empty or wrong path would pass | the dir holds the peer's state |
| no client names a blob (store-forward-n2b) | host tap | no | tap captures 'bucket' |
| host read no tag / NodeID / key / plaintext (store-forward) | byte search | no | search finds "bucket" and requestId |
| storage host saw no peer (store-forward) | connection event + counters | no | a real peer is seen (1 event, +1 claim) |
| relay never saw the real NodeID (interop, M6-1c-fix-6c) | relay 'connection' | no — DEAD channel: no event for relay sessions | relay reports every link's NodeID; ≥1 seen, never the real one |

Three of these were not merely missing a control but had a dead or wrong
channel (peer exchange, multi-hop E, relay-roles connections), plus the
interop case that started the sweep. In every one, the property held once it
was observable: no product defect behind them, but until now nothing showed
it. Covered-before examples, for the shape of a good control: the
impersonation test's honest-victim connection; claim-log's quarantine and
corrupt-tail lines shown in sibling cases; relay-ephemeral-nonce's peer D
emitting 'connection'; fd-cap's closedByServer > 0.

## Bugs found and fixed along the way

- VirtualSocket had no `end()` → a routed `GET ` payload penalised the innocent relay peer.
- Binding response from a remote peer was cast, not validated, and became the node's external address.
- `no-route` payload was a Buffer from one emitter, hex from another; several payloads typed wrong.
- `multi-hop-test` assertion could never fail (listened on the wrong emitter).
- `GMP_LAN_DISCOVERY=false` (documented) was never read — beacons kept broadcasting.
- Config file values were silently overwritten by defaults; empty env numbers became 0.
- Bridge: first seed fixed identity for every client; every client received every node's messages.
- Electron stop left bridge port 3002 bound.
- Relay: expired vouchers reported as unknown (sweep race); hop identities would have filled the relay's claim log and peer cache.
- `GMP_PORT=0` regression caught before it shipped.

## Found, NOT fixed (need a decision)

1. **Railway public peer isn't a public peer**: manager never forwards `isPublicPeer`; enabling it = IPv4-only bind + strict per-IP limiter.
2. **Dead config keys**: `GMP_MAX_PEERS`, `GMP_MAX_CONNECTIONS`, `GMP_SESSION_KEY_LRU_SIZE`, `GMP_MESSAGE_HOP_LIMIT`, `GMP_RATE_LIMIT_MAX_PER_IP/_GLOBAL`.
3. **Routing-loop check is dead code** (compares 64-hex prefix to 128-hex NodeID).
4. **Mesh-routed traffic leaks identities** to every forwarding hop (NodeID prefixes + cleartext inner handshake).
5. **Topology announces flood the social graph** (who is directly linked to whom) to every node.
6. **R2 linking**: operator-level and IP-level vectors both remain open; shipped `public-peers.json` has no `operator`, so every relay shows "not separated".
7. **Railway egress**: $0.05/GB from credit; with no card, exhausted credit stops workloads. Check the account's plan before any relay host.
8. Process-wide still: metrics server/counters, logger; bridge-created nodes are never idle-reaped.
9. **Relay use is visible to a passive tap regardless of the HELLO bit**: frame headers (type 0x0C–0x10, lengths) are cleartext AAD, and relay hosts are publicly listed. Hiding it needs encrypted frame types (wire break).
10. PROTOCOL_SPEC §4.3 described ephemeral-only key derivation; the code has used ephemeral–ephemeral ‖ static–static since the impersonation fix. Spec corrected in GM-N1c.

## Deliberate trade-offs (documented)

- Relay record **timing** still leaks typing rhythm / call presence (no cover traffic — battery).
- For ephemeral relay identities, invariant **I1 holds per connection**, not across restarts.
- ~~HELLO version byte bit `0x80` = ephemeral initiator~~ — removed in GM-N1c-1; hops are observed, not signalled.
- Responder sessions persist nothing until their first non-relay frame (GM-N1c-1); a relay-enabled node waits up to `GMP_RELAY_ROLE_OBSERVATION_MS` (2 s) before calling a silent inbound session a peer.
- Sealed circuit layer has **no** forward secrecy against later compromise of the callee's static key (identities exposed, content not).
- Sybil bucket: 30/min refill, **burst 256** (brief's 200-in-60 s requirement is impossible at 30/min without burst).

## New tests (all in `gmp-core/test/`)

`memory-transport` · `link-modules` · `config` · `multi-instance` · `event-contract` · `bridge-multi-instance` · `relay` · `relay-roles` · `relay-padding` · `relay-ephemeral-nonce` · `nonce-invariant-trace` · `relay-sybil`

## Next

GM-N3 is NOT complete: the S10+ was never attached (N3-3), the peer list has one real host (N3-1), and storage-via-relay needs hosts that do not exist (N3-4). See docs/TASKS.md.
Remaining spec items: port-collision review, Electron package contents check.
