# GMP Architecture Baseline (Phase 0)

**Date:** 2026-09-28
**Method:** Direct repository inspection + 4 parallel read-only recon passes. Every claim below is verified against the working tree with file:line citations. No production code was modified in this phase.

> **Line numbers below describe `link.js` as it was before Phase S2** (2075 lines). S2 split it; see §10 for where each piece now lives.

---

## 1. Toolchain & Baseline Results

| Item | Value |
|---|---|
| Package | `@ghostlink/gmp-core` 0.0.3, ESM (`"type": "module"`), `gmp-core/package.json` |
| Package manager | npm 11.19.0 (`package-lock.json` present) |
| Runtime | Node v26.7.0 (engines: `>=22.12.0`) |
| Language | TypeScript 5.9.3, **non-strict** (`"strict": false`, `tsconfig.json:9`), `allowJs: true` |
| Mixed JS/TS | `src/link.js`, `src/ghost-address.js`, `src/lan-discovery.js` are JavaScript; everything else TypeScript |
| Build | `npm run build` → `tsc -p tsconfig.json` → **PASS, 0 errors** |
| Tests | Custom runner `node test/run-all.mjs` (no framework; sets `NODE_ENV=test`, per-process `GMP_DATA_DIR` isolation via `test/helpers/isolate-data.mjs`) |
| Test baseline | **33 suites, 475 assertions, 0 failing** (1 SKIP: `lan-discovery-test.js`) |
| Lint | **None configured.** No eslint config, no `lint` script anywhere in repo |
| Deps | `@noble/curves`, `@noble/hashes`, `ws` only |

Entry points: `dist/gmp-node-manager.js` (main), `dist/gmp-bridge.js`, `dist/cli.js` (`gmp` bin). Consumers: Electron (`electron/src/main.js:55-60` dynamically imports `dist/`, starts bridge on 3002). Mobile does **not** embed gmp-core — it talks to a bridge over browser WebSocket and has its own separate WebRTC/X25519 path.

---

## 2. Source Tree (actual, `gmp-core/src/`)

29 files. Key deviations from the spec's assumed layout: there is no `primitives/`, `link/`, `routing/` etc. directory structure — everything is flat in `src/`. `link.js` (2075 lines) contains **three** classes: `GMPLink` (:193), `VirtualSocket` (:1236), `GMPNode` (:1280).

link.js internal sections (approximate): preamble/crypto helpers 1–191 · GMPLink ctor + nonce bridge 193–254 · framing & dispatch 256–349 · handshake responder 351–516 · handshake initiator 518–670 · keepalive/DATA receive 672–750 · send paths 752–888 · teardown/reputation 890–933 · per-type protocol handlers 935–1233 · VirtualSocket 1236–1278 · GMPNode ctor/module assembly 1280–1423 · node utilities 1425–1533 · `listen()` 1535–1652 · dial paths 1654–1936 · virtual incoming/status 1938–2017 · `close()`/exports 2019–2075.

---

## 3. Transport Inventory (Problem A — CONFIRMED)

`link.js` imports `net` (:22) and `tls` (:23) directly. Confirmed coupling.

**Network module imports (all of them):**
- `net`: `link.js:22`, `gmp-bridge.ts:3`, `hole-punch.ts:1`, `types.ts:1` (type-only)
- `tls`: `link.js:23` · `dgram`: `lan-discovery.js:24` · `http`: `gmp-bridge.ts:4`, `metrics.ts:1`, `cli.ts:3` · `https`: `gmp-bridge.ts:5` · `ws`: `gmp-bridge.ts:1`

**link.js socket operations the Transport abstraction must cover:**
- Server: `net.createServer` (:1539), per-accept ban/rate-limit veto via `socket.remoteAddress` + `destroy()` (:1540–1556), bind `'0.0.0.0'` public / `'::'` otherwise (:1637–1638), ephemeral port via `server.address().port` (:1641).
- Dial: `net.connect` / `tls.connect` selected by `options.tls || port === 443` (:1660, :1749–1751). TLS is **dial-only and unauthenticated** (`rejectUnauthorized: false`, :1667–1668) — obfuscation layer, auth is protocol-level. No `tls.createServer` exists.
- Socket adoption: `dialWithSocket(socket)` (:1762, used by hole-punch); `dialVirtual`/`handleIncomingRoutedPayload` adopt a duck-typed `VirtualSocket` EventEmitter (:1236–1278) with synthetic `'data'` injection (:1998).
- Timeouts: **no `socket.setTimeout` anywhere** — all JS timers (handshake-confirm 10s :511–514, PONG :826–830, RateLimiter events).
- Backpressure: **write return values ignored everywhere**, no `'drain'`, no send queue. Nothing to preserve, but nothing to assume either.
- Half-close: `socket.end()` once (HTTP health-check shim :266–279); `'end'` never subscribed.
- Remote metadata: `remoteAddress`/`remotePort` read at many sites, including outside link.js (`gmp-node-manager.ts:125-126,414-415`, `metrics.ts:380-381`, `peer-reputation.ts:95`) — Connection must carry endpoint metadata.
- Framing: `[4B uint32 BE length][1B type][payload]`, `MAX_MESSAGE_SIZE = 1 MiB` (:79) enforced on declared length at receive only (:287–290). 5-byte header is AES-GCM AAD.

**Out-of-band operations that do NOT fit listen/dial/write/close:**
- UDP multicast (lan-discovery.js:62, group 239.255.42.99:49599) — separate datagram concern.
- Pre-framing byte sniffing: HTTP health-check shim (link.js:266–279); first-byte TLS/ws demux with `pause()/unshift()/resume()` (gmp-bridge.ts:173–183).
- Parallel connect racing with loser cleanup (hole-punch.ts:66–142).
- Query-pattern throwaway links: dial → BINDING_REQUEST → destroy (public-peer-list.ts:31–91).

**Spec contradictions discovered:**
1. `holePunchConnect` has **no production caller** — test-only dead code. It also never sets `localAddress`/`localPort`/`SO_REUSEADDR`, so it cannot traverse port-restricted NATs the way PROTOCOL_SPEC §11.3–11.4 implies.
2. **No connection cap exists.** `maxPeers`/`maxConnections` are forwarded by the manager (`gmp-node-manager.ts:91-92`) but never destructured by `GMPNode` (`link.js:1281-1310`); the `'connection-cap-reached'` event advertised in link.js's header (:10) is never emitted.
3. The standard `RateLimiter` is **never constructed in production** — `GMPNode.rateLimiter` defaults to `null` (:1283), manager never injects one; only `bindingRateLimiter` exists, only when `isPublicPeer` (never passed by manager). Accept-time rate limiting is inert on the shipped path.
4. No TCP `setKeepAlive`/`setNoDelay` anywhere; keepalive is protocol-level PING/PONG only.

---

## 4. Configuration Inventory (Problem B — CONFIRMED, worse than assumed)

`config.ts`: 37 keys in `DEFAULTS` (:7–44), `loadConfig()` layers defaults → JSON file → env, singleton `export default config = loadConfig()` (:229–230), eager at import.

**18 files import the singleton directly** (all lower layers included): link.js, gmp-node-manager, gmp-bridge, claim-log, topology-announce, metrics, routing-table, logger, rate-limiter, key-rotation, peer-reputation, peer-exchange, peer-cache, nonce-store, cli, network-health, bootstrap, forwarder.

**Raw `process.env` reads outside config.ts:** `GMP_BRIDGE_ALLOW_NULL_ORIGIN` (gmp-bridge.ts:45), `GMP_BRIDGE_CERT/KEY` (:65-66), `GMP_BRIDGE_PORT/HOST` re-read (:469-470), all six `paths.ts` vars (:38–73), `GMP_SEED_PHRASE` (cli.ts:183), `PORT` (cli.ts:207), `NODE_ENV`/`GMP_DEBUG_ASSERTS` (claim-log.ts:62,471).

Full 37-option matrix was produced (option × default × consumer). Headline findings:

1. **The config-file layer is effectively dead for all 37 keys.** Env helpers fall back to `DEFAULTS`, not the file value (config.ts:133) — an unset env var overwrites the file value.
2. **21 of 28 manager-forwarded options are silently dropped by `GMPNode`** — documented in the code itself (`types.ts:246-263` docblock: only port, minPeers, pingIntervalMs, pongTimeoutMs, timestampWindowMs, noncePruneAgeMs, seedPhrase honored). The spec's "don't claim 21 dropped until verified" — **verified: 21 dropped, 7 honored, 28 forwarded.**
3. **Dead options (zero consumers):** `GMP_MAX_PEERS`, `GMP_MAX_CONNECTIONS`, `GMP_SESSION_KEY_LRU_SIZE`, `GMP_MESSAGE_HOP_LIMIT`.
4. **Shadowed/unreachable config reads** (constructor defaults always win): `GMP_FORWARD_RATE_LIMIT_PER_SOURCE` (also name-mismatched: `forwardRateLimitPerSource` vs `forwardRateLimitMax`), `GMP_REANNOUNCE_INTERVAL_MS` (topology path), `GMP_RATE_LIMIT_WINDOW_MS` (forwarder path), `GMP_BAN_DURATION_MS`, `GMP_REPUTATION_RECOVERY_INTERVAL_MS`.
5. **`GMP_LAN_DISCOVERY*` documented (README:76) but non-functional** — keys absent from `DEFAULTS`, always `undefined` (link.js:1301–1305).
6. Logger mutates the shared singleton (logger.ts:29) and ignores `GMP_DATA_DIR` (hardcoded cwd-relative log dir, logger.ts:19). Tests mutate the singleton too (claim-log-test.js:150–180).
7. `GMP_SEED_PHRASE` is deliberately absent from `DEFAULTS` (types.ts:228–230) so config files drop it — yet metrics.ts:433 *writes* it to config.json on key rotation. Value never read back.

---

## 5. Event Inventory (Problem D — actual emit-site census)

14 EventEmitter subclasses across 9 files; **`NonceStore` and `TopologyManager` extend EventEmitter but never emit.**

Events with verified payloads (emit-site truth):

| Event | Emitter | Payload | Notes |
|---|---|---|---|
| `error` | GMPLink, VirtualSocket | `(err)` / `{ connId, err }` (node) | |
| `clock-skew-detected` | GMPLink → GMPNode | `{ delta, remoteNodeId }` → `{ delta, link, remoteNodeId }` | link-level copy has no consumer |
| `connected` | GMPLink | `{ peerNodeId }` | |
| `message` | GMPLink | **string** (`plaintext.toString('utf8')`, :699) | node re-emits `{ connId, msg: Uint8Array }`; manager re-emits `{ fromNodeId, payload: string }` |
| `close` | GMPLink / GMPNode | none / `{ connId }` | |
| `binding-response` | GMPLink | `info` object | consumed via `.once` in public-peer-list.ts:52–68 |
| `rate-limited` | GMPNode, forwarder, RateLimiter | `{ ip, type }` / `{ sourceNodeId, type:'forward' }` / `{ ip, reason, current, limit? }` | three payload shapes, one name |
| `connection` | GMPNode | `{ connId, link, peerNodeId, type }` | 5 emit sites |
| `no-route` | GMPNode, forwarder | `{ finalDestinationNodeId }` (Buffer vs hex — **inconsistent**) | |
| `ttl-expired`, `forwarded` | forwarder via node | `{ finalDestinationNodeId, hopCount }` / `{ sourceNodeId, finalDestinationNodeId, hopCount }` | |
| `routing-degraded` | NetworkHealthMonitor → node → manager | `{ droppedInLast5M, totalForwarded }` | monitor's own copy unconsumed |
| `bootstrap-complete` | BootstrapManager via node | **bare number** at node; `{ peersConnected }` at manager | arity differs by layer |
| `bootstrap-failed` | same | `(count, diagnosis)` positional at node; `{ peersConnected, diagnosis }` at manager | |
| `key-rotated` | KeyRotationManager | `{ oldNodeId, newNodeId }` hex | **zero consumers** |
| `route-added`/`route-removed`/`route-expired` | RoutingTable | `(route)` | |
| `hello-timeout`/`handshake-timeout` | RateLimiter | `{ linkId, ip }` | inert in production (limiter never built) |
| `ban` | ReputationManager | `{ nodeId, ip, expiresAt, reason }` | **zero consumers** |
| `candidates-added` | PeerExchangeManager | `(addedCount)` | **zero consumers** |
| `peer-discovered` | LanDiscovery | `{ nodeId, address, port }` | **zero consumers** — manager polls instead |
| `external-address` | GMPNodeManager | `{ address, port }` | |
| `peer-connected`/`peer-disconnected` | GMPNodeManager | `{ nodeId, address, port }` / `{ nodeId }` | |

**Test anomaly:** `multi-hop-test.js:215–225` subscribes to `'route-added'` on `topologyManager` — that event is only emitted by `RoutingTable`. The listener can never fire; the assertion passes vacuously (compares 0 to 0).

---

## 6. Singletons & Bridge Lifecycle (Problem E — CONFIRMED, single-tenant)

Module-level mutable state: config singleton (config.ts:229, mutated by logger.ts:29 and tests), logger singleton (logger.ts:196, cwd-dependent log dir), metrics singleton (metrics.ts:531 — process-global counters, one HTTP server, `registerNode` silently overwrites). No top-level `let`/`var` exports anywhere in src.

**Bridge is single-tenant** (gmp-bridge.ts):
- One closure `manager` variable (:41); first client to send `'start'` fixes the identity for all later clients (:283); later seed phrases silently ignored (:287–297).
- `broadcast()` pushes **all** manager events — including every received message payload — to **all** connected WS clients (:190–216). Any local client can read all traffic and send as the node's identity.
- No `stop`/shutdown command; bridge-spawned node lives until process exit.

**Existing security restrictions (to preserve):** default bind 127.0.0.1 (:17); IP allowlist localhost / RFC1918-in-lan-mode with 401 (:104–112); Origin allowlist with 403/400 (:129–152); missing Origin accepted deliberately for CLI/mobile (:126–128). Metrics server: loopback-only + Host header check + any-Origin→403 + JSON content-type requirement (metrics.ts:189–244). Covered by `bridge-security-test.js` and `metrics-csrf-test.js`.

**Note:** `POST /rotate-key` (metrics.ts:402–454) replaces node identity from a caller-supplied seed, protected only by loopback/Host/Origin/CT checks — no auth token. Existing behavior; flag for later hardening discussion, not this refactor.

---

## 7. Replay Protection Boundary (high-risk area mapped)

Four primitives: `atomic-file.ts` (119 ln: temp+fsync+rename+dir-fsync, mode 0600), `file-lock.ts` (165 ln: O_EXCL lock, stale-breaking, `LockTimeoutError` fail-closed), `claim-log.ts` (1322 ln: append-only sealed log, locked re-check, checkpoint cache with anchor digest, quarantine-never-delete), `nonce-store.ts` (1098 ln: two-file design, merge-never-replace, invariants I0–I4 documented :53–97).

**Call semantics that MUST remain identical:**
- `claimSessionKey(remoteNodeId, fingerprint)` — exactly 2 call sites, both in handshake after key derivation before LRU check: responder link.js:467, initiator link.js:617. Fingerprint = `sha256(sendKey).hex.slice(0,32)` (link.js:143–145). Write failure refuses the claim (I3).
- `updateCounters(remoteNodeId, sendKey, sendCounter, recvCounter)` — via `GMPLink._updateNonceStore` (:245–254), called from **22 sites**, counter incremented before the call.
- `setEncryptionKey` at link.js:1365–1367 (ctor w/ seedPhrase) and :1461–1463 (loadIdentity).
- `nonceStore.close()` last in `GMPNode.close()` (:2069–2071).
- Per-link store injection at 5 sites (:1565, :1678, :1774, :1866, :1956).

**Data-dir layout** (paths.ts, resolved once at import): `GMP_DATA_DIR` → `<pkg>/data`; per-file env overrides for public-peers/peer-cache/nonce-state/nonce-claims/config. Claim log re-scoped per identity: `nonce-claims.<16-hex-key-digest>.log` (claim-log.ts:251–266). `GMPNode` accepts `nonceStorePath`/`peerCachePath` overrides; **`GMPNodeManager` exposes neither** — multi-node same-process tests rely on per-process `GMP_DATA_DIR`.

**Restart-volatile dedup (unlike nonce claims):** TopologyManager seq LRU (topology-announce.ts:87) and KeyRotationManager seq Set (key-rotation.ts:33, unbounded, never evicted) are memory-only.

**Known-open documented gaps (do NOT "fix" during structural refactor):** claim-log tail truncation below last checkpoint is silent (nonce-store.ts:165–221); `updateCounters` batching can lose counters by design (:706–714) — only claims have fsync-before-success.

**Stale comments found:** nonce-store.ts:826–829 and :1074–1076 narrate fixed history as current; `checkNonce`/`checkAndUpdate`/`getEntry` have no production callers (test-only API surface).

**Invariant tests that must stay green:** nonce-persistence, nonce-durability, claim-log, claim-checkpoint, claim-permanence, claim-race, multi-process-claim, strict-state, clock-hardening, encryption-at-rest, manager-restart, peer-cache(-merge), plus e2e paths (two-node, binding, handshake-impersonation, multi-hop, key-rotation).

---

## 8. Phase-Readiness Assessment vs. Spec Assumptions

| Spec assumption | Verdict |
|---|---|
| A. link depends on Node `net` | **Confirmed** (+ `tls`) |
| B. Global config imports | **Confirmed** — 18 importers; file layer dead; 21/28 forwarded options dropped |
| C. link.js responsibility overload | **Confirmed** — 2075 lines, 3 classes, ~9 responsibilities |
| D. Events need census | Done above — payload shape inconsistencies and 5 orphan events found |
| E. Bridge must be multi-instance | **Confirmed single-tenant** — first-start-wins, broadcast-all |
| WebSocket ≠ TCP caveat | Valid — demux/sniffing, no backpressure handling, synthetic data events all need explicit design |
| "Do not assume 28 options / 21 broken" | **Verified true**: 28 forwarded, 21 dropped (types.ts:246–263) |
| Replay protection = high-risk, preserve call semantics | Mapped; 2 claim sites + 22 counter sites identified |

## 9. Risks Carried Into Phase S1+

1. Non-strict TS + 3 JS files — type-checking baseline is weak; S2's TS conversion will surface latent type errors that are pre-existing, not regressions.
2. No lint gate; "tests green" is the only automated safety net. Architectural checks (layer-import rules) will need to be added (spec §15).
3. Tests mutate the config singleton and rely on per-process `GMP_DATA_DIR` — S3 (config injection) must keep a compatibility path or update tests deliberately.
4. VirtualSocket proves GMPLink already runs over a duck-typed stream — the S1 Transport/Connection interface should be stream-shaped (data/close/error + write callback + remote metadata), not `net.Socket`-shaped, but must still expose pre-framing byte access or own the HTTP health-check shim.
5. Inert production rate-limiting and missing connection cap are **behavior gaps**, not refactor targets — fixing them is a behavior change requiring explicit sign-off per Rule 3.

---

## 10. Phase S1 + S2 Status (2026-09-28)

**S1 — transport.** `src/transport/{transport,tcp-transport,memory-transport}.ts`. `GMPNode` takes `transport` (default `TcpTransport`); `listen`/`dial`/`dialWithSocket` go through it. `GMPConnection` is stream-shaped (data/close/error, `write(data, cb?)`, `end`, `destroy`, remote address/port), derived from what the link actually uses. Two nodes handshake over `MemoryTransport` (`memory-transport-test.js`).

**S2 — link decomposition.** `link.js` now holds only `GMPNode` + `VirtualSocket` (889 lines) and re-exports `GMPLink`, `MESSAGETYPES`, `SessionKeyLRUSet`, `DEFAULT_PORT` unchanged.

| Module | Responsibility |
|---|---|
| `link/frame.ts` | message types, 5-byte header (also the AEAD AAD), frame encode, `FrameDecoder` reassembly, `MAX_MESSAGE_SIZE` bound |
| `link/session.ts` | AES-256-GCM + IV layout, frame seal/open, `deriveLinkKeys` (eph–eph ‖ static–static → HKDF → directional keys), key fingerprint, `SessionKeyLRUSet` |
| `link/handshake.ts` | HELLO / HELLO_ACK layout (build/parse), NodeID binding, timestamp delta, signature check, handshake constants |
| `link/keepalive.ts` | PING interval, PONG timeout, liveness flag |
| `link/link.ts` | `GMPLink` coordinator: handshake sequencing, penalties, nonce-store calls, per-type dispatch (~650 code lines) |

Invariants kept: check order and error strings in both handshake handlers; penalty weights; `claimSessionKey` once per side right after derivation; `updateCounters` after every seal/open (22 inline copies collapsed into `_sealPayload`/`_openPayload`, same order: crypt → counter++ → persist); keepalive timer quirk (re-arm without clear). Ping/pong defaults are now resolved from config in `GMPNode`, so `link/` never reads the config singleton.

Evidence: full suite 35 suites / 579 assertions / 0 failing; `link-modules-test.js` (89 assertions: per-module units, malformed/hostile HELLOs, replay stall, key-reuse refusal, layering guard); pre-S2 build ↔ S2 build interop over TCP in both roles (handshake, DATA, BINDING, keepalive; identical counter progression).

**Open items found during S1/S2 (not changed — need a decision):**
1. ~~PROTOCOL_SPEC claimed a NodeID self-check that did not exist.~~ **Resolved after S2** (user-approved behaviour change): `GMPLink._checkNotSelf` refuses a HELLO / HELLO_ACK carrying our own NodeID, before the ban check and key derivation, without penalising the source address (a self-dial's address is our own). Tests: `link-modules-test.js` (reflected HELLO, reflected HELLO_ACK, node dialling itself); `two-node-test.js` Test 3b now signs its stale HELLO with a non-self identity.
2. `GMPLink._handleHELLO` calls `rateLimiter.recordHelloReceived(link._connId)`, but the node registers the pending connection under its own `connId` (rate-limiter.ts:77–100). The lookup misses, so the HELLO timer is never cleared and the handshake timer never starts: the whole handshake is bounded by the HELLO timer from accept (cleared by `recordHandshakeComplete(connId)`). Pre-existing; only matters where a limiter exists (public-peer binding limiter).
3. `link/` still depends upward on node services through the explicit `LinkHost` interface (reputation, forwarder, topology, peer exchange, key rotation), and transitively on config through `logger`. Replacing `LinkHost` with events is a behavior-affecting follow-up; logger → S3.
4. An exception thrown by a `'message'`/`'connected'` listener is caught by the frame handler and reported as a decryption failure, penalising the peer (pre-existing).
5. `MAX_MESSAGE_SIZE` is enforced on receive only; an oversized send goes out and the peer drops the link.

---

## 11. Phase S3 Status — Configuration Injection (2026-09-28)

**Flow now:** environment + config file → `loadConfig()` (config.ts, application layer only) → `GMPNodeManager` → `new GMPNode({ config, dataDir, seedPhrase, transport })` → explicit options to every subsystem. Node-level modules fall back to `DEFAULTS` (config-defaults.ts, side-effect free) and never read the environment. `config.js` is imported only by config, logger, metrics, cli, gmp-bridge, gmp-node-manager (was 18 files) — enforced by `config-test.js`.

**Precedence (per key, tested):** explicit option > environment > config file > default. Invalid env/file values are skipped and reported (`loadConfigDetailed().issues`, logged by the manager at start) instead of silently becoming the default — or `0`, for an empty numeric env var.

**Multi-instance:** `dataDir` (GMPNode and manager option) roots nonce state, claim log and peer cache per node; `node.config` is a frozen per-node copy. `multi-instance-test.js` runs three nodes in one process and proves distinct identity/keys/config/peer state/claim logs, nothing written to the global data dir, and restart from each node's own directory.

### Configuration matrix

"Before" is what actually took effect before S3; "Consumer" is where the value lands now.

| Option | Default | Before S3 | Consumer now | Behaviour change |
|---|---|---|---|---|
| GMP_PORT | 49500 | env/explicit via manager | `node.port` | explicit `port` manager option now honoured (was ignored) |
| GMP_MIN_PEERS | 3 | env/explicit via manager | `bootstrap.minPeers` | — |
| GMP_HELLO_TIMEOUT_MS | 10000 | env via singleton (binding limiter only) | `bindingRateLimiter.helloTimeoutMs` | — |
| GMP_HANDSHAKE_TIMEOUT_MS | 10000 | env via singleton (binding limiter only) | `bindingRateLimiter.handshakeTimeoutMs` | — |
| GMP_PING_INTERVAL_MS | 30000 | env/explicit via manager | `node.pingIntervalMs` → link keepalive | — |
| GMP_PING_TIMEOUT_MS | 10000 | env/explicit via manager | `node.pongTimeoutMs` → link keepalive | — |
| GMP_TIMESTAMP_WINDOW_MS | 120000 | env/explicit via manager | `node.timestampWindowMs` | — |
| GMP_BOOTSTRAP_STAGE1/2_TIMEOUT_MS | 10000 / 15000 | env via singleton | `bootstrap.stage1/2TimeoutMs` | explicit manager option now honoured |
| GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS | 30000 | env via singleton | `bootstrap.rebootstrapBackoffInitialMs` | explicit manager option now honoured |
| GMP_RATE_LIMIT_WINDOW_MS | 60000 | **dead** for forwarding (GMPNode literal 60000) | `node.forwardRateLimitWindowMs` | env/file now take effect |
| GMP_FORWARD_RATE_LIMIT_PER_SOURCE | 500 | **dead** (GMPNode literal 500; manager name mismatch) | `node.forwardRateLimitMax` | env/file now take effect |
| GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS | 60000 | env via singleton | `peerExchange.requestIntervalMs` | explicit manager option now honoured |
| GMP_SEQUENCE_NUM_LRU_SIZE | 1000 | env via singleton | topology seq-number LRU | explicit manager option now honoured |
| GMP_NONCE_PRUNE_AGE_MS | 90 d | env/explicit via manager | `nonceStore.pruneAgeMs` | — |
| GMP_ROUTE_EXPIRY_MS | 300000 | env via singleton | `routingTable.expiryTimeoutMs` | explicit manager option now honoured |
| GMP_TOPOLOGY_TTL | 16 | env via singleton | topology + key-rotation TTL | explicit manager option now honoured |
| GMP_REANNOUNCE_INTERVAL_MS | 60000 | routing prune / health: env; topology: **dead** (GMPNode literal) | topology announce, routing prune, health check (÷2) | env/file now reach topology |
| GMP_PEER_CACHE_MAX_SIZE | 500 | env via singleton | peer cache size, peer-exchange pool | explicit manager option now honoured |
| GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD / _AGE_DAYS | 10 / 30 | env via singleton | peer cache pruning | explicit manager option now honoured |
| GMP_STRICT_STATE | false | env via singleton, read at runtime | nonce store, claim log, peer cache (`strictState` ctor option) | tests pass the option instead of mutating the singleton |
| GMP_BAN_DURATION_MS | 86400000 | **dead** (GMPNode literal) | `reputation.banDurationMs` | env/file now take effect |
| GMP_REPUTATION_RECOVERY_INTERVAL_MS | 60000 | **dead** (GMPNode literal) | `reputation.recoveryIntervalMs` | env/file now take effect |
| GMP_LAN_DISCOVERY / _PORT / _GROUP | unset (on, off in tests) | **dead** — never parsed, though README documents `GMP_LAN_DISCOVERY=false` | LAN discovery on/off, port, group | **the documented off switch now works** |
| GMP_BRIDGE_PORT / _HOST | 3002 / 127.0.0.1 | bridge, CLI | unchanged (application layer) | — |
| GMP_METRICS_PORT | 9090 | manager → metrics | unchanged (application layer) | — |
| GMP_LOG_LEVEL / _TO_FILE / _TO_CONSOLE | INFO / false / true | logger read (and wrote) the singleton | logger's own settings, `logger.configure()` | logger no longer mutates shared config |
| GMP_MAX_PEERS, GMP_MAX_CONNECTIONS | 100 | dead | dead — no connection cap exists | none (implementing one is a feature) |
| GMP_SESSION_KEY_LRU_SIZE | 50 | dead | dead — GMPNode builds no LRU set unless injected | none |
| GMP_MESSAGE_HOP_LIMIT | 16 | dead | dead — VirtualSocket hard-codes 16 | none |
| GMP_RATE_LIMIT_MAX_PER_IP / _MAX_GLOBAL | 10 / 100 | dead in production — standard RateLimiter never built | same | none |
| *config file layer as a whole* | — | **dead** — every env helper fell back to DEFAULTS, overwriting file values | live, below env | a `config.json` now takes effect (none exists in the repo or `gmp-core/data`) |

All defaults are unchanged, so a deployment that sets nothing behaves as before. A `GMPNode` built directly without `config` (tests, scripts) now ignores the environment and uses DEFAULTS; the production path (manager) resolves env/file as before.

### Open items from S3 (need a decision)
1. **`isPublicPeer` is not forwarded by the manager** (pre-existing). `gmp public-peer` — the Railway service — sets it, but the node runs as an ordinary node: binds `::` (dual-stack), no binding rate limiter. Forwarding it would bind `0.0.0.0` (IPv4 only) and apply a 2-connections/IP/minute limiter whose trips ban the IP for 24 h. Left unchanged deliberately.
2. Dead options above: implement (connection cap, configurable hop limit, in-memory session-key LRU) or remove from config/docs.
3. Still process-wide: `paths.ts` default locations (env at import), logger (log dir is `cwd/gmp-core/data/logs`, ignores `GMP_DATA_DIR`), metrics server/counters — the latter two are S5 concerns.
4. `POST /rotate-key` (metrics.ts) writes `GMP_SEED_PHRASE` into `cwd/gmp-core/data/config.json`, which is now the first config-file candidate. The seed key is never loaded from a file, so no effect today, but the file it creates now participates in config loading.

---

## 12. Phase S4 Status — Event Contract (2026-09-29)

`src/events.ts` holds one map per emitter (event → listener argument tuple), built from the emit sites. Emitters extend `EventEmitter<Map>` (@types/node generics), so `emit` and `on/once/off` are type-checked; `link.js` is now under `// @ts-check` with GMPNode typed via JSDoc `@extends`, and `GMPNodeLike` / `GMPLinkLike` carry the same typed signatures, so subsystem emits through `this.node` are checked too. Verified by probe: a wrong payload key fails the build in both a .ts emitter and link.js.

**Inventory (11 maps, 26 distinct event names):**

| Emitter | Event | Payload | Consumers |
|---|---|---|---|
| GMPLink | `connected` | `{ peerNodeId: Buffer }` | GMPNode (all 5 link paths) |
| | `message` | `string` (UTF-8) | GMPNode → `message` |
| | `binding-response` | `unknown` (peer JSON) | public-peer-list (validated by `isBindingResponse`) |
| | `clock-skew-detected` | `{ delta, remoteNodeId: Buffer }` | — |
| | `error` | `Error` | GMPNode, public-peer-list |
| | `close` | — | GMPNode, public-peer-list |
| GMPNode | `connection` | `{ connId, link, peerNodeId: Buffer, type: 'incoming'\|'outgoing' }` | manager, peer cache, peer exchange |
| | `message` | `{ connId, msg: string }` | manager |
| | `close` | `{ connId }` | manager, bootstrap |
| | `error` | `{ connId, err }` | (only emitted when listened to) |
| | `clock-skew-detected` | `{ delta, link, remoteNodeId: Buffer }` | — |
| | `rate-limited` | `{ ip, type: 'binding'\|'standard' }` \| `{ sourceNodeId, type: 'forward' }` | GMPNode (bans) |
| | `no-route` | `{ finalDestinationNodeId: hex64 }` | health monitor |
| | `ttl-expired` | `{ finalDestinationNodeId, hopCount }` | health monitor |
| | `forwarded` | `{ sourceNodeId, finalDestinationNodeId, hopCount }` | health monitor |
| | `routing-degraded` | `{ droppedInLast5M, totalForwarded }` | manager |
| | `bootstrap-complete` | `(peersConnected)` | manager |
| | `bootstrap-failed` | `(peersConnected, diagnosis)` | manager |
| | `key-rotated` | `{ oldNodeId, newNodeId }` hex | — |
| GMPNodeManager | `peer-connected` | `{ nodeId, address\|null, port\|null }` | bridge |
| | `peer-disconnected` | `{ nodeId }` | bridge |
| | `message` | `{ fromNodeId, payload: string }` | bridge, metrics (ping) |
| | `bootstrap-complete` / `-failed` | `{ peersConnected }` / `{ peersConnected, diagnosis\|null }` | bridge |
| | `routing-degraded` | as GMPNode | bridge |
| | `external-address` | `{ address, port }` | bridge |
| RateLimiter | `rate-limited` / `hello-timeout` / `handshake-timeout` | `{ ip, reason, current, limit? }` / `{ linkId, ip }` | GMPNode (timeouts) |
| RoutingTable | `route-added` / `-removed` / `-expired` | `RouteEntry` | — |
| ReputationManager | `ban` | `{ nodeId, ip, expiresAt, reason }` | — |
| PeerExchangeManager | `candidates-added` | `(count)` | — |
| BootstrapManager, KeyRotationManager, NetworkHealthMonitor | as their GMPNode re-emits | | — |
| LanDiscovery (JS) | `peer-discovered` | `{ nodeId, address, port }` | — (manager polls) |
| TopologyManager, NonceStore | none (`NoEvents`) | | |

**Defects fixed by the contract:** `no-route` sent a Buffer from VirtualSocket and hex from the forwarder (now hex from both); the manager typed the node's `message` as `Uint8Array` (it is a string); `DialResult.peerNodeId` was typed `string` (it is a Buffer); peer-exchange cast its `connection` listener to a wrong shape; the bridge re-annotated every manager payload by hand, `address: string` where it can be null; `binding-response` was cast straight to `BindingResponse` and adopted as the node's external address — now validated (string address, integer port 1–65535) and a malformed reply rejects; `VirtualSocket` lacked `end()`, so a routed payload starting with "GET " threw inside the DATA handler and penalised the innocent relay; `multi-hop-test` listened for `route-added` on the TopologyManager (never emitted there) — it now counts real announce receptions and asserts propagation (8) and termination.

**Tests:** `event-contract-test.js` — census (every emitted name is in the contract and every contract name has an emit site; verified to fail on an injected unknown emit) plus real flows capturing 35 node, 26 link and 8 manager payloads, each shape-validated; every contract event observed except `external-address` (needs a reachable public peer; type-checked only).

**Found, not fixed (routing behaviour):** the forwarder's routing-loop check compares a 32-byte source prefix (64 hex) with the full 128-hex NodeID, so it can never match — loop detection is dead code; TTL still bounds loops.

---

## 13. Phase S5 Status — Multi-Instance Bridge (2026-09-29)

`src/node-registry.ts`: identity → GMPNodeManager. The bridge keeps no node variable; each WebSocket is a session bound to one manager, and a node's events go to its own sessions only (previously every client received every event, message payloads included, and the first seed fixed the identity for all clients).

- `start {seedPhrase}` → the node for that seed's NodeID (created on first use, shared by later sessions with the same seed). `start` with no seed, or a bare connection, → the host's node (manager passed to `startBridge`), as before. A different seed never binds the host's node (it used to be silently ignored).
- Created nodes: `dataDir` = `<GMP_DATA_DIR>/nodes/<NodeID[0:32]>/`; port = requested, else GMP_PORT, else ephemeral if another node holds it; at most `maxNodes` (default 8) → `START_FAILED` / `reason: REGISTRY_FULL`. An identity whose claim log already exists in the root data dir keeps the root layout (nothing moved or copied), so existing installs keep their replay history.
- `startBridge()` now returns `{ wss, manager, registry, port, close() }`; `close()` releases the TCP listener (Electron's stop previously closed only `wss`, leaving port 3002 bound) and stops the nodes the bridge created, never the host's. Electron updated to call it.
- `GMPNodeManager.start()` shares an in-flight start between concurrent callers (bridge and host), `resolveNodeId()` derives the NodeID from the seed before start, `dataDir` getter.
- Unchanged: localhost / RFC1918-in-LAN-mode IP allowlist, Origin policy (foreign and `null` refused), TLS sniffing, command set and reply shapes (`started` gains `port`; start errors gain `reason`).

**Verification:** `bridge-multi-instance-test.js` (36 assertions, real WebSocket clients): distinct nodes per seed, same-seed sharing, A→B messaging through the bridge, per-node event delivery (B's message never reaches A's sessions), key/config/dataDir/claim-log/table isolation, host-node binding rules, capacity, Origin refusals, `close()`, legacy layout. Standalone `node dist/gmp-bridge.js` smoke test over real TCP with two seeds: separate `nodes/<id>/` dirs, A→B delivered, no LAN beacon and no public-peer dial with `GMP_LAN_DISCOVERY=false` and an empty peer list.

**Remaining (S5-adjacent, process-wide by design today):** the metrics server and counters are one per process (`registerNode` keeps the last node; `/rotate-key` acts on it); the logger is one per process. Nodes created by the bridge live until `close()` / process exit — no idle reaping. Any local client allowed by the IP/Origin policy can still start a node for a seed it knows or use the host's node without one — the pre-existing trust model.


---

## 14. S1 re-verified — transport boundary (2026-09-29)

The transport abstraction itself dates from phase S1 (§10); the GM-N2c/S1
brief assumed link.js still used `net` directly. Checked: it did not. What
remained, and what changed:

**Interface, derived from the call sites** (`command grep` over src/ for every
member used on a connection or transport object):

| Member | Uses | In the interface |
|---|---|---|
| `remoteAddress` | 17 | yes |
| `destroy()` | 14 | yes |
| `isRelayed` | 11 | yes (optional) |
| `on('data' \| 'close' \| 'error')` | 9 | yes — **data typed `Uint8Array`, was `Buffer`** (the only consumer, the frame decoder, needs no more) |
| `remotePort` | 6 | yes |
| `write(data, cb)` | 5 | yes |
| `end()` | 2 | yes |
| `separation` | 1 (manager, relayed links) | **added** (was used, undeclared) |
| `once` / `removeListener` / `pause` / `resume` / `unref` | — | only on raw Node sockets inside tcp-transport, lan-discovery and the bridge: not the connection contract |
| `emit('data')` | 1 | VirtualSocket's own internals, not the contract |
| local address | 0 | **not added**: nothing reads it |
| `transport.dial` / `listen` / `adopt` / `close` | 2 / 1 / 2 / — | yes; `dial` takes an `AbortSignal` (GM-N3-2) |

**Changes (no behaviour change; no suite edited):**

- `hole-punch.ts` no longer imports `net`: each attempt is `node.transport.dial`
  with an AbortController, handed to the new `GMPNode.dialWithConnection`
  (no `adopt`, which non-TCP transports cannot do). hole-punch-test output is
  identical before and after (13/13).
- `link.js` no longer imports `TcpTransport` or `LanDiscovery` at module load;
  both are loaded on first use (`createRequire`). A node built without a
  transport still gets TCP. Before: loading link.js pulled in `net` and
  `dgram`, so no platform without them could construct a node at all, even
  with its own transport.
- `NullTransport` (`src/transport/null-transport.ts`): no imports, no Node
  globals. `null-transport-test.js` runs handshake, DATA, a relay circuit, a
  store-and-forward round trip with its receipt, and hole punching over it in
  a process where importing `net`, `tls` or `dgram` throws.

**Still Node-bound (not transport):** `fs` in the storage layer (nonce store,
claim log, atomic-file, file-lock, peer cache, blob store, store-and-forward
state) and in config/paths/logger/metrics/node-registry/public-peer-list/
bootstrap health/link.js (`mkdirSync` of the data dir); node `crypto`
throughout; `Buffer` throughout. A phone build needs a storage backend and a
crypto shim as much as a transport — that is the next boundary, not this one.

## 15. Runtime floor (M0-1, 2026-09-29)

| Runtime | Version | Node |
|---|---|---|
| Electron (desktop builds: .deb / .exe / .dmg) | 44.4.5 | **24.21.0** |
| engines floor, `package.json` and `gmp-core/package.json` | — | >= 22.12.0 |
| CI matrix (test job) | — | 22, 24 |
| development machine (system Node) | — | 26.7.0 |

The desktop builds ship Node 24.21.0, above the floor and above the
require()-of-ESM threshold (20.19 / 22.12) that link.js's lazy loads need (S1).
`test/electron-runtime-test.js` asserts this under the Electron binary itself
(ELECTRON_RUN_AS_NODE=1): both floors satisfied, dist/link.js loads, the lazy
TCP transport and LAN discovery load, a TCP handshake completes, and — as a
negative control — the same probe fails when `net` is blocked. It runs in the
CI packaging jobs (GitHub and GitLab), the only jobs with the Electron binary;
the test job sets ELECTRON_SKIP_BINARY_DOWNLOAD and it skips there.
