# Open protocol tasks

Logged so they do not evaporate. Not in progress unless a brief says so.

## N1d — ephemeral–ephemeral exchange before identities enter the sealed circuit

**Opened:** 2026-09-29 (from the GM-N2 brief). **Status:** open, not started.

The sealed relay circuit keys on one dialer ephemeral against the callee's
static X25519 key (PROTOCOL_SPEC §15.4). Anyone who records circuits and later
obtains the callee's static key opens every recorded circuit layer and reads
the inner cleartext HELLO / HELLO_ACK: who talked to whom, retroactively
(docs/relay-metadata.md, "Forward secrecy of the sealed circuit").

Fix: before any identity-bearing byte, run an ephemeral–ephemeral X25519
exchange inside the circuit (the callee answers the dialer's circuit hello with
its own ephemeral), and key the circuit on ee ‖ es. Costs one round trip.
Wire change on the circuit layer only (relays are unaffected: they never read
circuit records). Needs its own A/B tests and the circuit replay argument
redone.

The same retroactive exposure applies to stored blobs (§16.2: sealed to the
recipient's static key); fixing that needs prekeys and is not part of N1d.

## v2 — encrypted frame types

**Status:** logged, not now (wire break).

Frame headers (length, type) are cleartext AAD, so a passive observer sees
relay (0x0C–0x10) and storage (0x11–0x15) use and sizes. Hiding them needs
encrypted type bytes, which old nodes cannot parse.

## Storage traffic through a relay circuit

**Status:** proposed in docs/store-and-forward.md; needs a decision and a live
relay host (GM-N3).

Without it the storage host sees the exact deposit-IP → delete-IP edge of
every delivered offline message.

## N3-1 — host diversity (peer list)

**BLOCKED** before the second bootstrap host by "BLOCKING THE SECOND HOST:
public peers do not redial each other" below.

**Opened:** 2026-09-29. **Status:** blocked on hosts that do not exist yet.

Shipped `data/public-peers.json` has one entry (hayabusa.proxy.rlwy.net,
bootstrap, provider railway, operator empty until confirmed). GM-N3-1 needs >= 5
entries across >= 3 providers with bootstrap, relay and storage present and
no operator holding more than one role. Slots are laid out, commented, in
`data/public-peers.example.jsonc`. Needed:

- bootstrap #2 and #3 on two providers other than Railway;
- one relay (`GMP_RELAY_ENABLED=true`) run by an operator who runs no
  bootstrap host;
- one storage host (`gmp storage-peer`) run by an operator who runs neither.

"No operator holding more than one role" cannot be met by one person: relay
and storage need other operators. Each entry's `nodeId` must come from that
host's own start-up output.

## N3-3 — device verification on the S10+

**Opened:** 2026-09-29. **Status:** not done — no device attached
(`adb devices` empty on every attempt this session).

Required, with output pasted: `adb install` completing; cold-start bootstrap
time via each ladder rung reachable on that network; one relayed connection;
one store-and-forward round trip including the N2b-2 receipt; the N2-9 poll
scheduler running across a screen-off period.

## N3-4 — storage traffic through a relay

**Status:** blocked on N3-1 (needs a live relay and a live storage host under
different operators). Supersedes the "Storage traffic through a relay
circuit" entry above.

## Inbound admission caps (per-IP / global)

**Status:** done in GM-M4-2' (global concurrent cap 540, PROVISIONAL; per-address
token bucket 256 / 30 per min; no per-address concurrent cap, permanently;
outbound accounting bug fixed). Open follow-ups are the next two entries.

## GMP_STRICT_STATE default (fourth optional-control instance)

**Status:** done in GM-M4-3: on by default for the public peer, relays and
storage hosts, off for user clients; explicit setting wins. Refusals say what
happened, which file, the likely cause, the exact command, and what it costs;
a seed change is one refusal with one combined command.

## Mobile secrets outside the keychain (M3-4 finding)

**Status:** done in GM-M4-4 (code and Node tests; NOT run on a device — see
"Mobile: device verification of M4-4" below).

## §6 A runs that show the second ciphertext

**Status:** done in GM-M4-5: test/nonce-reuse-witness-test.js.

## Mobile: the factory reads config.js

**Opened:** 2026-09-30 (GM-M4-1). **Status:** note for the port.

Every node is now built by `createGMPNode`, which resolves configuration with
`loadConfigDetailed` (env + config file via `fs`). A mobile build that keeps
one coordinator will construct through the factory too, so the config file
read needs a mobile source (or none) — the same fs boundary as
mobile-runtime-inventory.md, one more site.

## File lock: what can still break a live lock (GM-M4-1b-1)

**Status:** residual, written down; no shipped configuration reaches it by default.

A same-host lock is broken only when its owner's pid is gone (age, forward or
backward, only makes it eligible; the backward-clock-step shortcut that
skipped the pid check was removed in M4-1b). What remains is the case where
the waiter cannot judge the owner's liveness, and is broken on age alone:

- **The owner is on another host, or in another PID namespace.** The lock
  records `hostname` and `pid`; a different hostname is broken on age alone,
  and `kill(pid, 0)` from another PID namespace reports a live process as
  dead. Reached by: a data directory on a network filesystem mounted by two
  machines, or one volume mounted by two containers (two replicas, a
  compose file with two services on one volume, a deploy that overlaps the old
  and new container).
- **AND the owner has held the lock longer than `staleMs` (30 s).** Locks are
  held for milliseconds, so this needs a stall: SIGSTOP, a hung fsync on a
  failing disk, a VM paused mid-write.
- An empty/unreadable lock is judged by its mtime; a forward wall-clock step of
  more than 30 s inside the microseconds between creating the lock and writing
  its record would let it be broken. Negligible, named.

Shipped configurations: Electron runs one node per machine; `gmp` /
`gmp public-peer` / `gmp storage-peer` are one process each. None shares a
data directory across hosts or containers unless an operator sets that up.
Unverified: whether the Railway deploy can overlap two containers on one
volume (Railway documents downtime on redeploy for services with volumes;
not checked against this project's dashboard).

The failing direction is otherwise closed: a pid reused after the owner died
makes a dead lock look alive, which blocks waiters until the lock timeout and
fails the claim closed.

## Deployed claim log: not yet checked

**Status:** needs someone with Railway access. No Railway CLI or config is in
this repo. Run, inside the service:

    node gmp-core/scripts/check-claim-log.mjs

It is read-only (readFileSync only; no lock, no rename, no gmp-core imports),
prints record / duplicate counts and fingerprint prefixes, never keys. A
duplicate fingerprint can only come from two lock holders. Validated locally:
on a log produced by 16 processes on the pre-fix lock it reported the same 2
duplicates the processes reported winning twice, and left every file
byte-identical. The deployed build has no boot counter (M3-2' is unreleased),
so there is no counter file to check.

## Public peer CPU ceiling: topology re-signing per join (GM-M4-2')

**Status:** done in GM-M5-1. Signed edges cached; per-peer samples of 8; no
flooding; routes on demand. Local capacity (same harness, lab per-address
bucket): before, never above ~140 peers, event-loop max 3.8-7.5 s, 105-113
peers dropped per step; after, 540 held with zero drops and p99 36-61 ms. The
540 cap is reachable and is what stops the node.

## Railway TCP proxy: are client addresses preserved?

**Opened:** 2026-09-30. **Status:** unknown; the deployed node will say.

Railway documents nothing about source IPs on its TCP proxy (4 docs pages
checked). If the proxy hides client addresses, every client arrives from a few
proxy addresses and the per-address token bucket (256 burst, 30/min) becomes a
GLOBAL rate limit for the public peer. The public peer's resource-sample log
lines now report `distinctAddresses` / `maxLinksPerAddress` (counts only, no
addresses): read the first few after deploy before relying on the bucket.

## Public peer RSS under churn

**Opened:** 2026-09-30. **Status:** watch.

In the local measurement RSS rose to 206 MiB with 68 peers connected after ~400
connections had come and gone, while the JS heap stayed flat at 11-14 MiB:
native allocator high-water, not a JS leak. Not shown to plateau. The deployed
resource samples will show whether it does over days.

## Mobile: device verification of M4-4

**Status:** blocked on a device (no `adb` device attached). Node tests cover the
sealing module against fakes, the upgrade from a device state with plaintext
secrets and 7 fragments, crash mid-upgrade, secure storage unavailable, and
the source-level guarantees; the screens were only parse-checked. Needs: an
upgrade install over a build that has data, and confirmation that
react-native-encrypted-storage's native module links (it was declared but
never imported before).

## REVOKED: public peer NodeID 52ab5611… (seed disclosed)

**Opened:** 2026-10-10 (M6-1c-fix-0). **Status:** rotation prepared; waits on
the operator setting the new GMP_SEED_PHRASE in Railway's Variables.

The Railway public peer's GMP_SEED_PHRASE was disclosed in a chat transcript.
It is permanently compromised: whoever holds it can impersonate the peer and
open everything sealed under it. Its NodeID is REVOKED and must never be
reintroduced into any peer list, example, or shipped default:

    52ab56117354cf7d7f12b8f2de7a428f50462f2146a9cf6c246b21b8c67f7ff3
    57192573bd7944236472b49617edb4e4bff5e7aa8e8eeec1938235caf66afe59

`REVOKED_NODE_IDS` in src/public-peer-list.ts drops it from every list at
load (shipped, overlay, GMP_PUBLIC_PEERS_PATH), and `test/seed-leak-test.js`
fails if any `public-peers*.json[c]` in the tree names it. One place to add
future revocations: the source list; the test imports it.
`test/ghost-address-test.js` still uses it as a plain hex input to address
derivation — not a peer list, not trusted for anything.

New identity (address and port unchanged, hayabusa.proxy.rlwy.net:58516):

    562c487c1a10a649179dd7b131527344c9f6bd65e7ebc800b6570dd496371f65
    b25aec43d1d1eb3937de2bf74e3ce45f7777e6375561f26ec26215f31301ea3a
    ghost address GHOST-ARP-4GZ-0T2

Generated by `scripts/new-public-peer-seed.mjs` (src/seed-phrase.ts, the one
CSPRNG generator: crypto.getRandomValues with rejection sampling), written to
a mode-0600 file outside the repository and never printed. Note: the project's
phrases are 12 independent list words (~132 bits), not checksummed BIP-39
mnemonics; identity derivation hashes the phrase string (identity.ts).

Until the operator switches the variable, the live host still answers as
52ab5611…, and nodes holding the updated list will refuse it (NodeID
mismatch): the list change and the variable change must ship together.

On the CURRENTLY deployed build (8ba4f3a) a seed change is not refused: that
build has no strict-by-role default (GMP_STRICT_STATE false) and no
state-refusal; it discards the old peer cache and nonce state with an ERROR
and starts. The M4-3 refusal path was exercised locally instead (cli.js
public-peer, real handshake, seed change, printed command run verbatim): see
the M6-1c-fix-0 report. It found that store-forward.state was sealed under
the seed but outside the refusal — fixed.

Seed-leak guards: the logger withholds any line carrying a seed phrase
(src/seed-guard.ts); seed-leak-test scans the tree and a real public peer's
TRACE output. Not covered: `gmp generate-seed` and `gmp rotate-key` print a
phrase to the operator's terminal on purpose; console output outside the
logger is covered only for the public-peer path the test runs.

## Railway: what does the service actually run?

**Opened:** 2026-09-30 (GM-M5-3). **Closed:** 2026-10-10 (M6-1c-fix-1).

Answer, from the Railway dashboard (transcribed by the user): the live service
is the PUBLIC PEER (`node dist/cli.js public-peer`), not the standalone bridge.
Dashboard fields, verbatim:

- Build Command: `cd gmp-core && npm install && npm run build`
- Start Command: `bash -c "cd gmp-core && npm install && npm run build && node dist/cli.js public-peer"`

`railway.json` (repo root) now pins exactly these two values and nothing else
(no builder, healthcheck or restart policy: those were not read from the
dashboard, and an HTTP healthcheck on `/` cannot pass on a raw-TCP GMP node).

**The duplicated install/build is recorded deliberately.** The start command
re-runs `npm install && npm run build` that the build command already ran. Why
is unexplained (possibly the build output does not survive into the runtime
image, possibly historical). Do not remove it without testing a deploy: if the
runtime image lacks `gmp-core/dist` or `node_modules`, the node will not start.
JSON has no comments, so this note lives here and not in `railway.json`; an
unknown `_comment` key was not added because Railway's handling of unknown
keys was not verified.

## BLOCKING THE SECOND HOST: public peers do not redial each other (M6-1c-fix-3a)

**Opened:** 2026-10-10. **Status:** BLOCKING — no second public peer may be
added to public-peers.json until this is fixed and tested. Not a general open
item: with one host it cannot happen; with two it eventually will, and then
it is permanent until a restart.

Field symptom, and why it is so hard to diagnose: the mesh splits into the
clients of host 1 and the clients of host 2. Everyone reaches SOMEONE, nobody
reaches EVERYONE; each host's logs look healthy (it is serving, minPeers 0 is
satisfied, no WARN); a failed delivery looks like an offline contact. Nothing
says "partition". Acceptance for the fix: two public peers, link killed,
re-linked within a bounded time without a restart, with a test that kills the
link and measures it; plus a log line when a listed bootstrap host is not
linked.

Unattended hosts now default to GMP_MIN_PEERS 0: they try the other listed
hosts ONCE at start-up and never loop (the old loop: a failing ladder every
30 s, ~2,900 runs and ~20,000 log lines / ~4 MB a day on Railway, plus one
dial per listed dead host per run). The cost of that: if the link between
two public peers drops, neither redials — nothing is required, so nothing
retries — and their clients sit in two halves of the mesh until one host
restarts. Needs a slow, quiet "link to the other bootstrap hosts" timer,
separate from minPeers. Not built: no second host yet.

## EMFILE drops connections without a trace (M6-1c-fix-3b)

**Opened:** 2026-10-10. **Status:** closed for connections 2026-10-10
(M6-1c-fix-6b-follow); residual below.

libuv's reserve-fd trick accepts and closes connections at the descriptor
limit and reports no error to JavaScript. Now: the connection cap is clamped
to min(GMP_RATE_LIMIT_MAX_GLOBAL, soft fd limit - max(GMP_FD_HEADROOM, fds at
start + 16)), logged on every start (link/connection-cap: configured cap, soft and hard limits, effective cap, clamped yes/no); refusals at the cap
are logged with a reason code (rate-limiter/connection-refused, FD_LIMIT /
GLOBAL_CAP / ADDRESS_RATE; first at once, then a count per
GMP_REFUSAL_LOG_INTERVAL_MS); connection-pressure fires from the live
admitted count at GMP_FD_WARN_FRACTION of the cap. fd-cap-test, under
`ulimit -n 128`: A 16 clients silently dropped from 108 with no log; B cap
540 -> 64, 56 closed = 56 logged refusals, 0 silent.

Residual: descriptors held by something other than connections (a leak,
files) are invisible to the live check. The periodic /proc sample is the
ground truth for those: fd-count-mismatch when it disagrees with
start + links, fd-pressure past the warn fraction of the soft limit
(fd-pressure-test, with an in-process leak). Its granularity is the
resource-log interval (60 s on the public peer).

## IPv6 /48 rate ceiling (M6-1c-fix-3c, optional)

**Status:** not built. admissionKey is back to /64 (per-device mobile
allocations must not share a bucket); requesterKey stays /48. A second,
much higher per-/48 rate ceiling would bound one /48 holder minting 65,536
fresh /64 buckets; today only the global cap bounds that.

## LAN discovery controls: never run (M6-1c-fix-6e)

**Status:** open; needs a host with working multicast loopback.

Two assertAbsent controls in test/lan-discovery-test.js ([3] empty peer list
before connecting; [6] stale peer expiry) sit past the multicast check. The
development host skips there ("no beacons received": the group is joined but
nothing is delivered), so they have never executed. Needs: UDP 49698, group
239.255.42.98, delivered back to the sending host's own sockets — a desktop
Linux on a multicast-capable interface with no firewall rule dropping it.
Run `node gmp-core/test/lan-discovery-test.js` there and record the result.

## Interop baseline: move it when the new build is deployed (M6-1c-fix-6c)

**Status:** open; one-line change after the deploy.

`test/interop-old-new.mjs` (CI packaging job) pins the "old" side to
INTEROP_OLD_REF = 8ba4f3a7c481 — the build the Railway public peer runs.
Against it: 24/24 checks; the relay pairing is N/A (that build has no relay
code). Once the current build is deployed, set INTEROP_OLD_REF to that
commit in its own diff: the relay pairing then applies (a new node
reserving on an old relay and the reverse; the relay must see the hop's
identity and never the reserver's real one) and the run is 30 (each relay
pairing: reservation, positive control, absence — the control became its own
line with assertAbsent, M6-1c-fix-6e). Exercised with
GMP_INTEROP_OLD_DIR=<this tree>: 30/30.

## Membership: what the sample does and does not stop (GM-M5-1b)

**Status:** bound stated; stronger defence would need admission (PoW/attestation).

Guaranteed: a peer learns at most 8 member NodeIDs per address key per epoch
(24 h) through topology, and no inbound client through peer exchange; route
queries only confirm NodeIDs the asker already has; reconnecting with fresh
identities from one address adds nothing. Not stopped: an attacker with many
addresses. Measured (N = 540, sample 8, medians over 100 secrets; restated
2026-10-11, M6-1c-fix-6e): 10 address keys see 75 members (58-80), 50 see
278 (51.5 %), 100 see 406 (75.2 %), 200 see 504 (93.3 %); all of them after a
median of 474 keys (298-886). One address alone needs a median of 484 daily
epochs (282-1063). "No inbound client through peer exchange" was first
measured through a dead channel (one shared in-memory address, PX rate limit);
re-measured with the channel live: still none (WORK_REPORT, "M5 disclosure
figures, restated").
An IPv6 /48 holds 65,536 /64 keys. Also still open: key-rotation certificates
are flooded mesh-wide (key-rotation.ts), which reveals a rotating node's old and
new NodeID to every node; pre-M5 nodes still flood their own topology
announces (we store them and do not pass them on).

## Accept-time rate limits no longer ban (GM-M5-1c)

**Status:** fixed; recorded because M4-2' introduced it.

Making the per-address bucket live (M4-2') activated an old handler that
banned the ADDRESS for 24 h and destroyed every link from it on the first
refused connection: behind CGNAT, one subscriber's 257th attempt disconnected
the whole carrier address. Found by the M5-1c capacity run (every connection
dropped at ~300 from one address), not by admission-cgnat-test, whose
end-to-end part stayed under the burst. Now accept-time refusals ban nobody;
forwarding abuse bans the offending NodeID only. admission-cgnat-test section 6.

## Mobile: M5-2 is unverified on a device

**Status:** same as all mobile work: never built, never run.

The legacy-recovery migration, the phrase-confirmation card and banner, and the
3-of-5 manual path are tested in Node against fakes (legacy-recovery-migration
test) and parse-checked only as screens.
