# Security Policy — Ghost Mesh Protocol (GMP)

This document outlines the security model, cryptographic design assumptions, known limitations, and response policies for the Ghost Mesh Protocol.

---

## 1. Security Guarantees (What GMP Protects)

GMP is designed to establish secure, decentralised, and metadata-minimising communication between peer nodes. It provides the following guarantees:

- **End-to-End Encryption (E2E)**: All application data (`DATA` frames) is encrypted end-to-end between the sending and receiving endpoints using AES-256-GCM. Intermediate relaying nodes in the mesh can only view transport-level routing frames (`DATA` envelope and destination NodeID); they cannot access message payloads.
- **Forward secrecy of link sessions**: Each connection's session keys combine an ephemeral–ephemeral and a static–static X25519 exchange (PROTOCOL_SPEC.md §4.3); the ephemeral private keys are discarded. Later compromise of a node's long-term static key does not reveal the content of recorded link sessions. Limits:
  - **Relayed circuits:** the sealed circuit layer has no forward secrecy. Whoever recorded a circuit (the relay is best placed) and later obtains the callee's static key learns who talked to whom — both NodeIDs and public keys — but not message content (PROTOCOL_SPEC.md §15.4, docs/relay-metadata.md).
  - **Store-and-forward:** mailbox blobs are sealed to the recipient's static key with no forward secrecy. A host that kept a blob and later obtains that key can read it (docs/store-and-forward.md).
  - There is no per-message ratchet: a link's session keys do not change for the life of the connection.
- **Cryptographic Identity Verification**: Node addresses are 64-byte `NodeID` values derived securely via `SHA-512(staticPubKey)`. Handshakes authenticate node ownership using Ed25519 signatures, preventing impersonation and active MITM attacks.
- **Replay Protection**: Handshakes enforce timestamp freshness validation (2-minute window) and persistent nonce tracking. A session key may be used once and only once: the fingerprint of every key ever negotiated is recorded permanently in an append-only, individually authenticated log, backed by an in-memory LRU for the current process. A claim that cannot be written to disk causes the handshake to be refused. See §3 for the full design, its audit history, and its limits.
- **Origin Security**: Local browser applications communicate with the background daemon node via a loopback WebSocket bridge protected by origin validation (`file://`, `localhost`, `127.0.0.1`, `::1` only) to block DNS rebinding and cross-site scripting (XSS) extraction.

---

## 2. Out of Scope (What GMP Does NOT Protect)

Operators and developers should understand the boundaries of the GMP security model:

- **Traffic Analysis**: Relaying nodes can observe packet sizes, timings, and destination/source routing paths. GMP does not natively obfuscate traffic patterns or packet schedules (though padding is utilized where feasible).
- **Endpoint Integrity**: If an operator's physical device, local file system, or React Native client memory is compromised, all security guarantees are bypassed. Private keys are protected at rest (AES-256-GCM) but must be loaded into memory to establish connections.
- **Metadata Protection of IP Addresses**: While NodeIDs protect cryptographic addresses, public rendezvous nodes (Public Peers) can see the physical IP addresses of nodes connecting to them.
- **Symmetric NAT Limitations**: Nodes behind symmetric NATs cannot directly establish P2P links without a relaying peer.

---

## 3. Replay Protection in Detail

Replay protection is the part of GMP most likely to fail quietly, so this section documents it in enough detail to be checked against the source. The implementation is `gmp-core/src/nonce-store.ts`, `claim-log.ts`, `file-lock.ts` and `atomic-file.ts`.

The problem it solves: session keys are derived from a fresh ephemeral X25519 exchange on every connection, so a session key that appears twice means the same AES-256-GCM key is about to encrypt under a counter it has already used. Nonce reuse under GCM leaks the XOR of the two plaintexts and, with enough material, the authentication key. A peer that replays an old handshake transcript is attempting exactly this, and the check that stops it has to survive restarts, crashes and concurrent processes — otherwise it only works until the first inconvenient moment.

### 3.1 What it guarantees

Four invariants, stated as they appear in the header comment of `nonce-store.ts`:

1. **A session-key fingerprint is claimed at most once, ever** — across every process, every peer, and every restart. A fingerprint is `SHA-256(session key)` truncated to 128 bits.
2. **A high-water mark never decreases.** Not on merge, not on reload, not on an out-of-order frame. A mark that moves backwards reopens the window it exists to close.
3. **A claim reported successful is durable.** `claimSessionKey()` does not return success until the record is on disk, and refuses the claim if it cannot be written.
4. **State is merged, never replaced.** Every path that reads persisted state folds it into what is already in memory rather than overwriting it. Counter writes re-read the file under the lock before writing it back; claims are appended, so there is nothing to overwrite.

### 3.2 How it works

Two files, because the two kinds of state have opposite lifetimes.

**`nonce-claims.log`** — session-key claims, keyed by fingerprint alone. Claims are permanent, so the set only grows and the file is append-only.

- One record per claim: `[4-byte big-endian length][12-byte IV][16-byte GCM tag][ciphertext]`, sealed with AES-256-GCM under a key derived from the node's seed phrase (PBKDF2-HMAC-SHA256, 100,000 iterations).
- Each record is **independently authenticated**, with the additional authenticated data bound to the literal `gmp-nonce-claim-v1`. A record damaged in the middle of the file cannot forge or invalidate the records before it, and a record cannot be transplanted from another sealed file.
- An in-memory `Set` of fingerprints makes the lookup O(1). A repeat claim is refused without any disk access at all.
- A **sealed checkpoint** snapshots that index at a known byte offset, so a restart opens one record and replays only the claims appended since — 0.90 s instead of 36.3 s at a million claims. It is a cache, never the authority: a checkpoint that fails to authenticate, declares a version this build does not read, claims to cover more bytes than the log contains, or does not match the bytes of the log it points into is discarded, and the log is replayed in full.
- The log is **named after the key that seals it**. Records are sealed with a key derived from the node's seed phrase, so a log only means anything to the identity that wrote it; giving every identity one filename made that mismatch indistinguishable from corruption. Two nodes sharing a data directory, and one node after a seed rotation, each get their own log.
- A claim is **global, not per peer**. The defence is against broken ephemeral key generation — an RNG failure, a seeded PRNG, a VM snapshot restoring entropy state — and none of those confine a repeated key to one peer.

**`nonce-state.json`** — per-session send/receive counters, keyed by peer and fingerprint. These prune (90 days idle by default, `GMP_NONCE_PRUNE_AGE_MS`), so the file stays bounded and is rewritten whole. Claims are never pruned, and live in a separate file specifically so that no change to the pruner can reach them.

The two files reach disk differently, because appending and replacing have different failure modes:

- **The claim log is appended and `fsync`ed** before the claim is reported successful. A process killed mid-append leaves a partial final record, which is discarded on the next read — it was never a completed claim. Records already written are unaffected, because each authenticates on its own.
- **The counter file is replaced atomically**: write to a temp file unique to the writing process, `fsync` the descriptor, `rename` into place, then `fsync` the containing directory. A crash or full disk at any point leaves the previous file intact rather than a truncated one. `fsync` precedes the rename, and closing a file is not treated as a durability barrier. Log compaction uses the same path.
- **Both take a lock.** An `O_EXCL` lockfile serialises the whole read-modify-write for counters, and each append for claims. A lock records the holder's pid, hostname and acquisition time; it is broken only when it is both older than 30 seconds and its owner is confirmed dead, and the liveness check is only trusted when the hostname matches. Default acquisition timeout is 5 seconds.
- **Fail-closed throughout**: if the append fails, the `fsync` fails, the disk is full, or the lock cannot be acquired within the timeout, `claimSessionKey()` **rejects the claim** and the handshake is refused. A claim that could not be persisted is treated as a claim that was never made, because the next process will not honour it.
- **A log that cannot be read is distinguished from a log that is damaged.** An I/O failure — a file descriptor limit, a permissions problem, a mount that went away — says nothing about the file's contents, so nothing is rebuilt and nothing is renamed; the file is left exactly as it is, the failure is logged at ERROR (`state-log-unreadable`), and under `GMP_STRICT_STATE` the node refuses to start rather than run with no record of which session keys have been used.

Claims made before the encryption key is configured — the node supplies it only after deriving its identity — are held in memory, honoured immediately, and written when the key arrives.

### 3.3 What was found, and fixed

Repeated review of this subsystem has turned up nine defects. Every one was a real fault in shipped code, and every one was found because somebody read this code directly — none surfaced as a field failure, which is the point: this class of bug does not announce itself. All nine are fixed. They are listed so a reader can check each against the git history and the test that now pins it.

Four earlier defects: the `NonceStore` was **never constructed** by the node, so the persisted half of the check did not run at all; `updateCounters()` was **called from 22 places but did not exist**; claims were **reported successful before being written**, with persistence deferred up to a second; and claims held in memory were **discarded on the next load**, which replaced in-memory state instead of merging it.

Five further violations, from a dedicated audit of the subsystem's invariants:

| | Exposure | Closed by |
|---|---|---|
| **V1** | Claims expired. The pruner could not distinguish a claim from a stale counter, so after 90 days idle a fingerprint became claimable again — an attacker only had to wait out the retention window. | Claims moved to their own file, which the pruner cannot reach. |
| **V2** | A forward clock jump aged out fresh entries. An NTP correction on hardware without a working RTC, or a restored VM snapshot, could discard the whole state at once. | Claims never prune. Counters skip a prune cycle that looks like a clock jump rather than genuine age. |
| **V3** | Two processes sharing a data directory silently erased each other's claims. Each wrote a file derived from a snapshot taken before the other's write, and **both were told their claim had succeeded**. No attacker required. | An exclusive lock around the read-modify-write, per-writer temp file names, and a re-read inside the lock. |
| **V4** | A state file written by a newer build was discarded in total silence — no log line, and `GMP_STRICT_STATE` did not fire — taking every claim and high-water mark with it. | An unrecognised version is an ERROR, and fatal under strict mode. |
| **V5** | Claims were scoped per peer, so the same session key could be refused for one peer and accepted for the next. The in-memory half of the same check was already global; the persisted half was the one that was wrong. | Claims keyed by fingerprint alone. Older files are migrated on read. |

The same audit raised one further issue that was performance rather than correctness, but would have made the subsystem unusable in practice: every claim rewrote every claim ever made, so handshake latency grew linearly and synchronously — about 5.3 ms per thousand claims held, blocking the event loop. A node with 100,000 claims blocked for roughly half a second per handshake. The append-only log replaced that; measured latency is now flat at 0.10–0.14 ms from 1,000 claims to 1,000,000.

Each fix is pinned by tests that were verified to fail against the pre-fix code — including a multi-process test using real forked processes, in which the unlocked implementation loses six of eight concurrent claims.

### 3.4 Known limits

Stated plainly, because each is a real constraint a deployment can hit.

**The claims log grows without bound.** Claims are permanent by design, so the file accumulates one record per session key ever negotiated. Measured at one million claims: **215 MiB of log, 31 MiB of checkpoint, 20 MiB of index memory**. Claim latency is flat at 0.11 ms and startup from the checkpoint is 0.90 s, so the growth is a disk cost rather than a latency one — but it is still unbounded, and a busy public peer reaches these numbers sooner than a client. Compaction does not help: it only removes duplicate records, because a claim never expires.

**Startup is bounded only when a checkpoint is usable.** A checkpoint is written once the tail passes a threshold, inline once it passes twice that, and unconditionally on a clean shutdown. A clean stop therefore costs no replay at all, and an unclean stop replays at most the ceiling — measured at 0.66 s for 60,000 claims. But when no usable checkpoint exists — missing, damaged, or describing a different log — the fallback is a full replay of everything ever claimed: **36.3 seconds at a million claims**. That path is correct but slow, and it is the honest worst case.


**`GMP_STRICT_STATE` is off by default.** When a state file exists but cannot be authenticated, the default is to log at ERROR, discard it and continue; with strict mode on, the node refuses to start. The default favours availability: a corrupt file on a user's laptop should not lock them out of their own client with an error they cannot act on. The cost is that the loss of replay protection is visible only as one ERROR line at startup. **Unattended nodes and public peers should run with `GMP_STRICT_STATE=true`.** See `docs/archive/DEPLOYMENT.md` in the repository root for the operator-facing version of this trade-off.

**Multi-process safety depends on `O_EXCL`.** The lock is a lockfile created with `O_CREAT|O_EXCL`, which the kernel guarantees will succeed for exactly one caller on a local filesystem. A data directory on a filesystem where `O_EXCL` is not atomic — some network filesystems, notably older NFS — **is not supported**, and two nodes sharing such a directory can still lose claims. Running two nodes against one data directory is not a configuration we recommend in any case.

**Truncation of the claim log is only partly detected.** Records are individually authenticated, so nothing in the log can be forged or altered undetectably — but the log's *length* is not protected. An attacker with write access to the data directory can cut records from the end, and the claims in the removed span become claimable again.

The checkpoint covers part of this today: it records the byte offset it summarises, and a log shorter than that offset is reported at ERROR (`claim-log-shorter-than-checkpoint`) before the checkpoint is discarded. Truncation *below the last checkpoint* is therefore loud. Truncation of the tail written since the last checkpoint is still silent, the checkpoint can itself be deleted, and `GMP_STRICT_STATE` does not currently treat any of this as fatal.

Closing the rest is designed but **not implemented**; the options and the trade-off between them are written up in the header comment of `nonce-store.ts`. Note that none of it defends against an attacker who deletes the log, the checkpoint and everything else together — a node starting with no state cannot distinguish that from a first run. Filesystem access to the data directory is outside the threat model (see §2, Endpoint Integrity); the value of the remaining work is making tampering *noisy*, not impossible.

**Fingerprints are 128-bit truncated hashes.** `SHA-256` of the session key, truncated to 16 bytes. An accidental collision between two distinct session keys would *refuse* a legitimate connection rather than accept a repeated key, so the failure direction is the safe one. At a billion claims the birthday probability is on the order of 10⁻²¹.

---

## 4. Known Limitations

- **Real-Network NAT Traversal (Beta status)**: TCP hole punching is verified on loopback and local networks. However, cross-network traversal across multi-layered carrier-grade NATs (CGNAT) remains unverified in production.
- **Clock Dependency**: Security replay checks depend on correct system time (tolerance window of 2 minutes). Substantial clock drift (> 2 minutes) prevents successful handshakes.

---

## 5. Responsible Disclosure

If you discover a security vulnerability in the Ghost Mesh Protocol, please report it privately:

- **Email**: [ghostlink@proton.me](mailto:ghostlink@proton.me)
- **Response window**: submissions are acknowledged within **72 hours**, with a concrete resolution path or patch timeline within **10 days**.
- Please do **not** open public issues or pull requests for security vulnerabilities until a patch is ready.

What happens to a report:

1. **Acknowledgement** within 72 hours, confirming receipt and who is looking at it.
2. **Reproduction.** We try to reproduce the issue and write a failing test for it before attempting any fix. If we cannot reproduce it, we say so and ask what we are missing rather than closing it.
3. **Assessment.** We tell you what we believe the exposure is and whether we agree with your severity. If we disagree, we explain why in technical terms, and we will publish the disagreement alongside the report if you want that.
4. **Fix and disclosure.** The fix ships with the test that pins it. We will credit you by whatever name you choose, or not at all if you prefer, and we will coordinate timing with you rather than announcing unilaterally.
5. **If we will not fix it**, we say that plainly and document it in §2 or §4 of this file, so the limitation is public rather than private.

Reports about the subsystems documented in §3 are particularly welcome. The defects listed there were found by reading the code, which suggests there are more to find.
