# Ghost Mesh Protocol (GMP) Specification

**GMP Protocol Version:** 1.0.0
**Status:** Release Candidate
**Phase:** Production Ready (Phases 1-8)

---

## 1. Overview

GMP is GhostLink's owned peer-to-peer encrypted mesh protocol. Phase 1 establishes a single, direct, encrypted link between two nodes with no routing, no multi-hop, and no topology awareness. Phase 2a adds nonce tracking and rate limiting for improved security.

**Phase 1 Goals:**
1. Platform-independent key derivation (runs identically on web, Electron, and mobile).
2. A clear and auditable protocol specification suitable for peer review.
3. Correct handshakes between two nodes on the same LAN, with replay protection and tamper detection.

**Phase 2a Goals:**
1. Session key uniqueness verification to prevent nonce reuse attacks.
2. Persisted nonce high-water marks for defense-in-depth.
3. Per-IP connection rate limiting to prevent resource exhaustion.
4. Global concurrent connection cap.
5. Handshake timeouts to prevent slow-loris attacks.

**Out of Scope:**
- Multi-hop routing (A → B → C) — Phase 3
- Routing tables or topology awareness — Phase 3
- NAT traversal — Phase 2b
- Address compaction (full 64-byte NodeID used) — Phase 1.5
- Key rotation — later phase
- Peer reputation/blocklisting — later phase

---

## 2. Node Identity

### 2.1 Key Derivation

```text
seed = PBKDF2(seedPhrase, salt="ghostlink-yggdrasil-v1", iterations=100000, hash=SHA-256, outputLen=32)
staticPrivKey = seed                               (32 bytes)
staticPubKey  = X25519.getPublicKey(seed)          (32 bytes)
NodeID        = SHA-512(staticPubKey)              (64 bytes)
signingPrivKey = HMAC-SHA512("ed25519-signing", seed)[0:32]  (32 bytes)
signingPubKey  = Ed25519.getPublicKey(signingPrivKey)        (32 bytes)
```

### 2.2 Address Format

Phase 1 uses the full 64-byte `NodeID` (128 hex characters). Truncation is deferred to Phase 1.5.

---

## 3. Wire Protocol

### 3.1 Message Framing

Length-prefixed binary frames:

```
[ 4 bytes: uint32 big-endian payload length ]
[ 1 byte:  message type                     ]
[ N bytes: payload                           ]
```

- `length`: payload size in bytes. Max 1,048,576 bytes.
- `type`: message type.

### 3.2 Message Types

| Type     | Value | Encrypted | Description                    |
|----------|-------|-----------|--------------------------------|
| HELLO    | 0x01  | No        | Initiator handshake message    |
| HELLO_ACK| 0x02  | No        | Responder handshake reply      |
| DATA     | 0x03  | Yes       | Application data               |
| PING     | 0x04  | Yes       | Keepalive probe                |
| PONG     | 0x05  | Yes       | Keepalive response             |
| BINDING_REQUEST | 0x06 | Yes | STUN-style binding request     |
| BINDING_RESPONSE | 0x07 | Yes | STUN-style binding response   |
| TOPOLOGY_ANNOUNCE | 0x08 | Yes | Link-state topology announcement |
| PEER_REQUEST | 0x09 | Yes | In-band peer list request      |
| PEER_RESPONSE | 0x0A | Yes | In-band peer list response     |
| KEY_ROTATION | 0x0B | Yes | Key rotation certificate flood |
| RELAY_RESERVE | 0x0C | Yes | Client asks a relay for a reservation (§15) |
| RELAY_RESERVATION | 0x0D | Yes | Relay grants a signed voucher (§15) |
| RELAY_CONNECT | 0x0E | Yes | Dial a reservation by voucher / circuit opened (§15) |
| RELAY_DATA | 0x0F | Yes | Circuit bytes: 4-byte circuit ID + opaque sealed record (§15) |
| RELAY_STOP | 0x10 | Yes | Refusal or teardown with a reason code (§15) |
| STORE_REQUEST | 0x11 | Yes | Deposit one sealed blob into a bucket (§16) |
| STORE_ACK | 0x12 | Yes | Accepted (expiry) / rejected + reason (§16) |
| FETCH_REQUEST | 0x13 | Yes | Fetch exactly N `{ bucket, since }` entries (§16) |
| FETCH_RESPONSE | 0x14 | Yes | One blob per frame, then a final frame with the next cursor (§16) |
| *(retired)* | 0x15 | — | **RETIRED** (was FETCH_DELETE). Never sent, ignored, never reused (§16, GM-N2b-1) |

### 3.3 HELLO Payload (265 bytes, unencrypted)

| Offset | Size | Field                               |
|--------|------|-------------------------------------|
| 0      | 1    | protocolVersion (0x01); any other value is refused (§15.7) |
| 1      | 64   | initiatorNodeId                     |
| 65     | 32   | initiatorStaticPubkey (X25519)      |
| 97     | 32   | initiatorSigningPubkey (Ed25519)    |
| 129    | 32   | initiatorEphemeralPubkey (X25519)   |
| 161    | 8    | timestamp (milliseconds, uint64 BE) |
| 169    | 32   | initiatorNonce (random)             |
| 201    | 64   | signature (Ed25519 of bytes 0..200) |

### 3.4 HELLO_ACK Payload (280 bytes, unencrypted)

| Offset | Size | Field                               |
|--------|------|-------------------------------------|
| 0      | 64   | responderNodeId                     |
| 64     | 32   | responderStaticPubkey (X25519)      |
| 96     | 32   | responderSigningPubkey (Ed25519)    |
| 128    | 32   | responderEphemeralPubkey (X25519)   |
| 160    | 8    | timestamp (milliseconds, uint64 BE) |
| 168    | 48   | encryptedProof (16-byte GCM auth tag + 32-byte ciphertext, §4.4) |
| 216    | 64   | signature (Ed25519 of bytes 0..215) |

---

## 4. Handshake Protocol

### 4.1 Flow

```
Initiator                           Responder
    |                                   |
    | --- HELLO ------------------->    |
    |                                   | Verify ID, Sig, Timestamp
    |                                   | Generate ephemeral key
    |                                   | Derive session keys
    |                                   | [Phase 2a] Check session key uniqueness (LRU)
    |                                   | Encrypt proof
    |  <--- HELLO_ACK ----------------  |
    | Verify ID, Sig, Timestamp         |
    | Derive session keys               |
    | [Phase 2a] Check session key uniqueness (LRU)
    | Decrypt and verify proof          |
    v                                   v
[connected]                        [connected]
```

### 4.2 Verification Steps

Both sides MUST perform these checks in order:
1. **NodeID Check**: Recompute `SHA-512(staticPubkey)` and verify it matches the claimed `nodeId`.
2. **Timestamp Check**: Must be within ±5 minutes of local system time.
3. **Signature Verification**: Verify Ed25519 signature of the signed portion.
4. **Phase 2a — Session Key Uniqueness**: Verify the derived session key hasn't been used before (LRU set, size 50). If duplicate detected, refuse connection — this should NEVER happen in correct operation.

### 4.3 Session Key Derivation

```text
ssEphemeral  = X25519(localEphemeralPriv, remoteEphemeralPub)   // fresh on BOTH sides, per connection
ssStatic     = X25519(localStaticPriv,    remoteStaticPub)      // long-term identities
IKM          = ssEphemeral || ssStatic

initiatorInfo = "ghost-mesh-hkdf-phase1-initiator" || hex(initiatorNodeId) || hex(responderNodeId)
responderInfo = "ghost-mesh-hkdf-phase1-responder" || hex(initiatorNodeId) || hex(responderNodeId)

sessionInitiatorKey = HKDF-SHA512(salt=null, IKM, info=initiatorInfo, length=32)
sessionResponderKey = HKDF-SHA512(salt=null, IKM, info=responderInfo, length=32)
```

The ephemeral–ephemeral term gives forward secrecy and makes every session key new even when a HELLO is replayed (the responder's ephemeral is generated per connection). The static–static term proves each side holds the static key its NodeID commits to. (This section described the ephemeral term alone until GM-N1c; the code has used both since the impersonation fix — `session.ts` `deriveLinkKeys`.)

**Initiator**: uses `sessionInitiatorKey` for sending, `sessionResponderKey` for receiving.
**Responder**: uses `sessionResponderKey` for sending, `sessionInitiatorKey` for receiving.

### 4.4 Encrypted Proof (HELLO_ACK only)

The `encryptedProof` in `HELLO_ACK` is an AES-256-GCM encryption of the 32-byte `initiatorNonce` from the `HELLO` message, using the responder's derived session key and a zero IV:

```text
encryptedProof = AES-256-GCM(sessionResponderKey, iv=0^96, initiatorNonce)
```

This proves the responder successfully performed ECDH.

---

## 5. Encrypted Messaging

### 5.1 Encryption Format

```text
PING/PONG/DATA payload after encryption:
[16 bytes: AES-GCM auth tag]
[N bytes:  encrypted ciphertext]
```

- `key`: sendKey or recvKey (32 bytes)
- `nonce`: 12-byte counter, zero-padded, incremented per message per direction
- `aad`: the 5-byte header ([length][type])

### 5.2 Keepalive

- PING interval: 30 seconds
- PONG timeout: 10 seconds

---

## 6. Nonce Management (Phase 2a)

### 6.1 Session Key Uniqueness (LRU Set)

**Defense Layer 1**: In-memory LRU set tracking the last 50 session keys per peer.

- On every handshake, compute `SHA-256(sessionKey)` fingerprint
- If fingerprint exists in LRU set, refuse connection immediately
- This should NEVER trigger in correct operation (ephemeral keys ensure uniqueness)
- If triggered, indicates either: crypto bug, RNG failure, or attack

### 6.2 Persisted Nonce High-Water Marks

**Defense Layer 2**: Persistent storage of nonce counters per (peerNodeId, sessionKeyFingerprint).

File: `gmp-core/data/nonce-state.json`

```text
{
  version: 1,
  entries: {
    "<peerNodeIdHex>:<sessionKeyFingerprint>": {
      sendHighWater: <number>,
      recvHighWater: <number>,
      firstSeen: <timestamp>,
      lastActivity: <timestamp>
    }
  }
}
```

**Check on new connection**: If same sessionKeyFingerprint seen before, verify starting nonces don't overlap with recorded high-water marks.

**Pruning**: Entries older than 90 days with no activity are automatically removed.
The 30-day pruning of persisted nonce high-water marks means this defense does not provide an unconditional guarantee for peers who reconnect after more than 30 days of inactivity. In this case, protection relies entirely on Layer 1 (ephemeral key uniqueness via the session key LRU set). Since session keys are derived from fresh ephemeral X25519 keypairs generated per connection, key reuse remains cryptographically negligible in practice even without the persisted high-water mark.

---

## 7. Rate Limiting (Phase 2a)

### 7.1 Per-IP Connection Rate Limiting

- **Sliding window**: 60 seconds
- **Default limit**: 10 new connections per IP per window
- **Configurable** via constructor options
- **Behavior when exceeded**: Immediately destroy socket, reject before any handshake crypto

### 7.2 Global Concurrent Connection Cap

- **Default**: 100 simultaneous connections
- **Behavior when reached**: Refuse new incoming connections at TCP accept level
- **Existing connections**: Unaffected

### 7.3 Handshake Timeouts

| Timeout | Duration | Trigger |
|---------|----------|---------|
| HELLO timeout | 10 seconds | Connection accepted but no HELLO received |
| Handshake timeout | 10 seconds | HELLO received but handshake not complete |

Purpose: Prevent slow-loris resource exhaustion attacks.

### 7.4 Configuration Defaults

```text
RATE_LIMIT_WINDOW_MS = 60000
RATE_LIMIT_MAX_PER_IP = 10
RATE_LIMIT_MAX_GLOBAL = 100
HELLO_TIMEOUT_MS = 10000
HANDSHAKE_TIMEOUT_MS = 10000
```

---

## 8. Threat Model

### 8.1 Assumed Attacker

- Full network control (MITM, replay, drop, delay, forge)
- Knowledge of the protocol specification
- No access to long-term private keys
- Can open many connections rapidly (connection flood)
- Can capture and replay previous session traffic

### 8.2 Attack Analysis

| Attack Scenario              | Protection                                                                          | Status      |
|-----------------------------|-------------------------------------------------------------------------------------|-------------|
| Passive Eavesdropping        | AES-256-GCM encryption on `DATA`/`PING`/`PONG` frames                                | MITIGATED (Ref: [link/session.ts](src/link/session.ts)) |
| Replay (HELLO/HELLO_ACK)    | Timestamp ±2 min window checks and strict signature verification                    | MITIGATED (Ref: [link/handshake.ts](src/link/handshake.ts)) |
| Timestamp Replay (stale)    | Timestamp tolerance checks reject old requests                                     | MITIGATED (Ref: [link/handshake.ts](src/link/handshake.ts)) |
| Impersonation (no priv key) | Ed25519 signature checks bind static keys to the session                           | MITIGATED (Ref: [link/session.ts](src/link/session.ts), [link/link.ts](src/link/link.ts), [identity.js](src/identity.ts)) |
| Man-in-the-Middle           | Ephemeral key exchange and GCM encryptedProof authentication check                  | MITIGATED (Ref: [link/session.ts](src/link/session.ts), [link/link.ts](src/link/link.ts)) |
| Reflection (reflected HELLO)| HELLO/HELLO_ACK carrying our own NodeID is refused (not penalised)                  | MITIGATED (Ref: [link/link.ts](src/link/link.ts)) |
| Pubkey Replacement          | SHA-512 NodeID derivation verification check                                        | MITIGATED (Ref: [link/handshake.ts](src/link/handshake.ts)) |
| Desynchronization           | GCM auth tag check on payload decryption                                            | MITIGATED (Ref: [link/session.ts](src/link/session.ts)) |
| Nonce reuse via key collision | Ephemeral key LRU check + persisted nonce high-water mark validation               | MITIGATED (Ref: [link/link.ts](src/link/link.ts), [nonce-store.js](src/nonce-store.ts)) |
| Connection flood             | Per-IP rate limiting + global connection limiters + timeout hooks                   | MITIGATED (Ref: [rate-limiter.js](src/rate-limiter.ts), [link.js](src/link.js)) |
| Symmetric NAT Traversal      | Cannot traverse symmetric-to-symmetric NAT directly                                 | ACCEPTED (Requires mesh relay forwarding) |
| Real-network NAT Traversal   | TCP hole punching classification and connection coordination                        | UNVERIFIED IN PRODUCTION (Loopback-verified, deferred VPS verification) |

### 8.3 Known Limitations

**Phase 1 Limitations**:
1. **No Key Rotation**: Compromised signing key affects all future handshakes.
2. **Clock Dependence**: ±5 min window requires loosely synchronized clocks.
3. **No Revocation**: No protocol-level way to globally revoke a NodeID.

**Phase 2a Limitations**:
4. **Per-node rate limiting only**: No distributed rate limiting coordination between nodes.
5. **No peer reputation**: A node blocked by rate limiting can reconnect from different IP.

---

### 8.4 Relay Security

Two different things relay traffic, with very different exposure:

- **Mesh forwarding** (routed DATA, §12): every forwarding hop decrypts the hop layer and sees the 32-byte source and destination NodeID prefixes, and the inner handshake's HELLO / HELLO_ACK in the clear (both NodeIDs and public keys). It does not see message content or session keys. The earlier wording here ("volume and timing only") was wrong for this path.
- **Relay tier** (§15): the relay sees network addresses, circuit pairing, padded record sizes and timing — no NodeID, key or content. See §15.9 and `docs/relay-metadata.md`.

---

## 9. Implementation Notes

- **Phase 1+2a Target**: Electron (Node.js `net` module).
- **Dependencies**: `@noble/curves`, `@noble/hashes`, Node.js `crypto`.
- **Default Port**: 49500
- **New Modules (Phase 2a)**:
  - `nonce-store.js`: Persisted nonce high-water marks
  - `rate-limiter.js`: Per-IP and global rate limiting

---

## 10. Protocol State Machine

```
                    TCP Connection
                         |
                         v
               +-----------------+
               |   NEW          |  (socket accepted)
               +-----------------+
                         |
                         v
               [Rate Limiter Check]  --- fail --> [CLOSED: rate-limited]
                         |
                         v
               +-----------------+
               |  HELLO_WAIT    |  (waiting for HELLO)
               +-----------------+  (10s timeout)
                         |
                         v
               [Parse & Verify HELLO]  --- fail --> [CLOSED: invalid]
                         |
                         v
               [Session Key Uniqueness]  --- fail --> [CLOSED: key reuse]
                         |
                         v
               +-----------------+
               |  HELLO_SENT    |  (HELLO_ACK sent, waiting)
               +-----------------+  (10s timeout)
                         |
                         v
               [Parse & Verify HELLO_ACK]  --- fail --> [CLOSED: invalid]
                         |
                         v
               +-----------------+
               |  CONNECTED     |  (authenticated, encrypted channel)
               +-----------------+
                         |
                         v
                   [PING/PONG]
                         |
                         v
               [Connection Close]

```

---

## 11. NAT Traversal (Phase 2b)

### 11.1 STUN-style Binding Protocol

GMP includes a native STUN-like mechanism implemented over the existing authenticated and encrypted wire protocol:

- **`BINDING_REQUEST (0x06)`**: Sent by a node to a Public Peer asking "What address do you see me connecting from?". The payload is empty.
- **`BINDING_RESPONSE (0x07)`**: Sent by a Public Peer in response to a `BINDING_REQUEST`. The payload contains a JSON object mapping the observed remote IP and port:
  ```json
  {
    "address": "<remote_ip>",
    "port": <remote_port>
  }
  ```
  Both `BINDING_REQUEST` and `BINDING_RESPONSE` are fully encrypted and authenticated via the ephemeral session key established during the standard GMP handshake.

### 11.2 Public Peer Role and Rate Limiting

To bootstrap connections for nodes behind NAT, GMP utilizes a decentralized, manually-maintained list of volunteer "Public Peers" (GMP nodes running on stable, public IPs). 

- **Open Access**: Public Peers accept handshakes and binding requests from strangers.
- **Stricter Rate Limiting**: To prevent resource exhaustion, unestablished binding requests are subject to a separate, stricter rate limiter (default: 2 concurrent connections per IP, global cap of 20 concurrent stranger connections).
- **Established Exemption**: Once a node completes the handshake and authenticates as a registered peer in the `establishedPeers` whitelist, it is moved to the standard rate limiter and exempt from the strict binding limits.

### 11.3 NAT Type Classification Heuristics

A node classifies its NAT environment by querying 2 distinct Public Peers using 3 total queries:
1. **Query 1 (Q1)** to Public Peer 1: Record `(IP1_A, Port1_A)`
2. **Query 2 (Q2)** to Public Peer 1: Record `(IP1_B, Port1_B)`
3. **Query 3 (Q3)** to Public Peer 2: Record `(IP2, Port2)`

**Classification Heuristics**:
- **Symmetric NAT**: If the ports from the same peer mismatch (`Port1_A !== Port1_B`), the NAT maps source ports dynamically. Simultaneous-open hole punching **will not work** in this scenario.
- **No NAT / Full-Cone NAT**: If the mapped ports are stable and match across different peers (`Port1_A === Port1_B === Port2`), the mapping is destination-independent. Direct connection or standard hole punch is highly likely to succeed.
- **Restricted Cone NAT**: If the ports are stable for the same peer but different for different peers (`Port1_A === Port1_B !== Port2`), the NAT is address or port-restricted. Simultaneous-open hole punching can successfully traverse this NAT.
- **Unknown NAT**: If public IPs do not match across queries or query failures occur, classification returns `UNKNOWN`.

### 11.4 Simultaneous-Open Hole Punching

For traversable NAT configurations (Cone NATs), nodes establish a connection using simultaneous-open TCP connections. The coordination is achieved via a **two-step manual payload exchange sequence** over the signaling channel (QR/paste):

#### Step 1: Invite Payload (Payload A)
The Initiator (Node A) performs address discovery and generates the **Invite Payload** containing its details:
- `nodeId`: Initiator's public identity NodeID (hex string)
- `address`: Discovered public IP address (or loopback fallback)
- `port`: Discovered public port (or loopback fallback)
- `natType`: Discovered NAT classification
This payload is encoded in Base64 and sent to the Responder (Node B).

#### Step 2: Coordinated Response Payload (Payload B)
The Responder (Node B) receives and decodes Payload A. Since Node B now knows Node A's details, B selects a target connection time (`attemptTimestamp`) set to 60 seconds in the future. B then generates the **Coordinated Response Payload** containing B's details and the timestamp:
- `nodeId`: Responder's public identity NodeID (hex string)
- `address`: Discovered public IP address (or loopback fallback)
- `port`: Discovered public port (or loopback fallback)
- `natType`: Discovered NAT classification
- `attemptTimestamp`: The target countdown Epoch timestamp in milliseconds
This payload is encoded in Base64 and sent to the Initiator (Node A).

#### Step 3: Coordinated Timing & Outbound Simultaneous Open
Upon pasting/verifying Payload B, both nodes wait until the `attemptTimestamp` is reached. Once the timestamp arrives, both sides attempt to connect outbound to each other's discovered public address every 200ms for up to 5 seconds.

#### Step 4: Handshake Transition
The first raw TCP socket that establishes a connection is adopted by the node's `dialWithSocket(socket)` to run the standard GMP handshake (HELLO/HELLO_ACK) on top. All other pending/failed sockets are immediately closed.

#### Step 5: Honest Fallback
If no connection succeeds within 5 seconds, the process fails honestly with a clear fallback notification directing the user to use manual signaling or the optional Python relay.

### 11.5 Protocol State Machine with NAT Traversal

```
                    [Address Discovery]
                             |
                      (Public Peers)
                             v
                     [NAT Classification]
                             |
              +--------------+--------------+
              |                             |
      (Cone / No NAT)                  (Symmetric / Unknown)
              |                             |
              v                             v
     [Coordinated Countdown]        [Honest Fallback]
              |                             |
              v                             v
      [Simultaneous Open]           (Manual Signaling / Relay)
              |
              v
     [GMP HELLO Handshake]
              |
              v
         [CONNECTED]
```

---

## 12. Multi-Hop Routing (Phase 3)

### 12.1 Topology Announcement Message (0x08)

Sent encrypted and authenticated at the link level. The payload is a JSON object representing the link-state of the announcer:

```json
{
  "announcerNodeId": "<64-byte announcer NodeID in hex>",
  "connectedToNodeId": "<64-byte connected NodeID in hex>",
  "sequenceNumber": <integer counter incremented per event>,
  "timestamp": <epoch millisecond timestamp>,
  "withdrawn": <boolean (true if connection is closed, false if established)>,
  "ttl": <integer (starts at 16, decremented each hop)>
}
```

### 12.2 Updated DATA Message (0x03) Plaintext Format

For direct (single-hop) messages, the plaintext is simply the application payload.
For routed (multi-hop) messages, the plaintext is prefixed with routing fields:

```
[ 1 byte:  routing flag (0x01 for routed, 0x00 for direct) ]
[ 32 bytes: sourceNodeId (first 32 bytes of source NodeID) ]
[ 32 bytes: finalDestinationNodeId (first 32 bytes of destination NodeID) ]
[ 1 byte:  hopCount (starts at 16, decremented per forward) ]
[ N bytes: payload (encrypted/unencrypted application payload) ]
```

---

## 13. Peer Discovery & Network Bootstrap (Phase 4)

### 13.1 Message Types
Phase 4 introduces two new message types for in-band peer discovery, sent fully encrypted and authenticated at the link level:

- **`PEER_REQUEST (0x09)`**: Sent to a directly connected peer to ask for their verified peers.
  - Payload:
    ```json
    {
      "maxPeers": <integer (1 to 20, cap of 20)>
    }
    ```
- **`PEER_RESPONSE (0x0A)`**: Sent as a reply containing the responder's known direct peers.
  - Payload:
    ```json
    {
      "peers": [
        {
          "nodeId": "<128-character hex NodeID>",
          "address": "<ip_address>",
          "port": <port_number>,
          "lastSeen": <epoch_timestamp>
        }
      ]
    }
    ```

### 13.2 NodeID Usage & Consistency
- **Full NodeID**: Derived using `SHA-512(staticPubKey)` yielding **64 bytes (128 hex characters)**. Used for peer identity authentication (handshake and signatures) and transmitted in `PEER_RESPONSE` payloads to ensure cryptographically secure identity verification.
- **Truncated Prefix**: The first **32 bytes (64 hex characters)** of the NodeID. Used exclusively for prefix matching in routing tables and the headers of multi-hop routed `DATA` messages.

### 13.3 Security & Privacy Considerations
- **Request Rate Limiting**: Nodes must ignore incoming `PEER_REQUEST` messages from a connected peer if they occur more than once per 60 seconds. This mitigates peer list enumeration attacks.
- **Unverified Candidate Data**: Peer response addresses and ports are treated as unverified hints. The standard GMP handshake ensures that fake or malicious identities are caught and rejected on connection setup.
- **Plaintext Storage Privacy Gap**: The file `data/peer-cache.json` stores sensitive connection history and addresses in plaintext. This is a known privacy gap to be resolved in Phase 5 via authenticated encryption at rest.

### 13.4 Bootstrap Sequence (the ladder, GM-N3-2)
A bootstrap run climbs a ladder. **The first successful connection wins; every other dial of the run is cancelled** (a pending handshake is torn down, a pending TCP connect destroyed). Peer exchange then fills up to `minPeers` as before.

| Rung | Source | Budget (config) | Notes |
|---|---|---|---|
| 1 | peer cache, most recently seen first | 1.5 s (`GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS`) | up to 5 in flight |
| 2 | LAN discovery | 1 s (`GMP_BOOTSTRAP_LAN_TIMEOUT_MS`) | only NodeIDs already in the peer cache, at the address the LAN reports; any LAN peer only with `GMP_LAN_BOOTSTRAP_ANY=true` (lan-discovery never introduces strangers). Skipped when LAN discovery is off |
| 3 | `public-peers.json`, `bootstrap` role | 4 s (`GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS`) | shuffled, 3 in flight; demoted hosts skipped while any undemoted remain |
| 4 | peers learned by peer exchange | 1 s (`GMP_BOOTSTRAP_PX_TIMEOUT_MS`) | including from earlier sessions |
| 5 | manual (QR / paste) | — | `bootstrap-failed` with a diagnosis; unchanged |

No dial lasts longer than `GMP_BOOTSTRAP_DIAL_TIMEOUT_MS` (4 s) or outlives its rung; a rung with nothing to dial is skipped. **Worst case to rung 5 = sum of the budgets = 7.5 s** (measured 7.51 s with every rung populated by hosts that accept TCP and never answer). Failures are remembered per NodeID *and* address, so a peer that failed at a stale cached address is still tried where the LAN or a list says it is.

**Demotion.** A public peer that fails a ladder dial is demoted for 60 s × 2^(failures−1), capped at 6 h; a success clears it. Health persists in `<dataDir>/public-peer-health.json`. Nothing is ever removed from the shipped list, and when every entry is demoted they are all tried anyway. Within one run, three dead hosts shuffled into the three slots hold them for the whole 4 s budget, so a live fourth host is not reached until the dead ones are demoted on the next run.

**Re-runs & backoff** are unchanged: if active connections drop below `minPeers/2`, retry after 30 s; repeated failures back off 30 s, 60 s, 120 s, 300 s.

### 13.5 Network Health & Self-Healing
A health check executes every 30 seconds:
- If direct connections drop below `minPeers` and the node is not bootstrapping, start the bootstrap sequence.
- Track metrics: `currentPeerCount`, `peakPeerCount`, `messagesForwarded`, `messagesDroppedNoRoute`, `messagesDroppedTTL`, `uptimeSeconds`, `bootstrapAttempts`.
- Emit `routing-degraded` if missing routes in the last 5 minutes exceed 20% of forwarded messages.
- Status values exposed: `'healthy'`, `'degraded'`, `'isolated'`, `'bootstrapping'`.

---

## 14. Security Hardening & Privacy (Phase 5)

### 14.1 Encrypted State Storage at Rest
Sensitive metadata storage files `peer-cache.json` (peer history) and `nonce-state.json` (nonce counters) are encrypted at rest using AES-256-GCM.
- **Key Derivation**: Keys are derived from the operator's secret seed phrase using PBKDF2/SHA-256 with 100,000 iterations and distinct salts:
  - `"ghostlink-peer-cache-v1"` for the peer cache key.
  - `"ghostlink-nonce-store-v1"` for the nonce counter key.
- **Pruning defaults**: Configurable default for the nonce store is extended to 90 days. If the seed phrase is absent, the store operates in plaintext.

### 14.2 Key Rotation Protocol
Nodes can rotate their signing keys (e.g., in case of compromise) without changing static static key identities or losing connection:
- **Rotation Message (0x0B)**: Flooded through the mesh to notify all nodes.
- **Certificate Fields**:
  - `oldNodeId`: 128-hex old NodeID.
  - `newPublicKey`: 64-hex new Ed25519 signing public key.
  - `newNodeId`: 128-hex new routing identity (SHA-512 of newPublicKey).
  - `rotationTimestamp`: Epoch timestamp of rotation.
  - `signature`: Ed25519 signature of `oldNodeId + newPublicKey + newNodeId + rotationTimestamp` signed by the compromised key. `newNodeId` is covered so a relay cannot redirect the old identity.
- **Verification**: Receivers check the certificate signature against the sender's cached key and replace the routing target upon match. Certificates from unknown peers are ignored.

### 14.3 Clock Dependency Hardening
- **Handshake window**: Acceptable timestamp delta for handshakes is reduced from 5 minutes to 2 minutes (`timestampWindowMs = 120000`).
- **Clock Skew warnings**: If the skew delta exceeds 5 minutes, nodes emit a `'clock-skew-detected'` warning event.

### 14.4 Peer Reputation System
Nodes track a local peer reputation score (0–100) to mitigate misbehavior:
- **Initial Score**: 100.
- **Recovery**: +1 point every 60 seconds (up to 100).
- **Penalties**:
  - **Suspicious actions** (decryption failure, format error, invalid type): -10 points.
  - **Untrusted actions** (signature verification failure, duplicate packet/key rotation): -50 points.
  - **Banned actions** (routing loop, DOS/flooding, rate limit exceeded): -100 points.
- **Enforcement on Ban (Score 0)**:
  - Direct links are torn down immediately.
  - IP and NodeID are blocked for 24 hours.
  - Relaying/forwarding packets for banned NodeIDs is dropped.


---

## 15. Relay Tier (GM-N1, GM-N1b, GM-N1c)

A relay lets two nodes that cannot reach each other directly (≈ half of real connections behind NAT) talk through a public host that learns neither identity. Modelled on libp2p Circuit Relay v2. Off unless `GMP_RELAY_ENABLED`; a host advertises the service with `"roles": ["relay"]` in `public-peers.json`.

### 15.1 Hops

Clients reach a relay over an ordinary, link-encrypted GMP link, but under an **ephemeral identity** generated for that one connection (`generateEphemeralIdentity`). Nothing on the wire marks it (§15.7). A dial uses a fresh one every time. A hop — ours, or one the relay has observed (§15.7) — may carry only HELLO, HELLO_ACK, PING, PONG and 0x0C–0x10; anything else tears it down. The relay treats hops as infrastructure: no `connection` event, no peer-cache entry, no topology announce.

### 15.2 Messages

All payloads below are the plaintext inside the hop link's AES-GCM (type byte + length as AAD, §5.1).

| Type | Direction | Payload |
|---|---|---|
| RELAY_RESERVE 0x0C | client → relay | JSON `{}` or `{ "renew": voucherId }` |
| RELAY_RESERVATION 0x0D | relay → client | JSON `{ "voucher": Voucher }` |
| RELAY_CONNECT 0x0E | client → relay | JSON `{ "voucherId", "requestId" }` |
| RELAY_CONNECT 0x0E | relay → client | JSON `{ "circuitId", "requestId"? }` — no `requestId`: an incoming circuit for the reserver |
| RELAY_DATA 0x0F | both | `[circuitId u32 BE][sealed record]` — the relay reads the circuit ID only |
| RELAY_STOP 0x10 | both | JSON `{ "reason", "circuitId"?, "requestId"?, "op"? }` |

### 15.3 Vouchers

```
Voucher = { v: 1, relayNodeId, voucherId (16 random bytes, hex), reserver (hop NodeID, hex),
            expiresAt (epoch ms), signature }
signature = Ed25519(relay signing key,
            "gmp-relay-voucher-v1|" relayNodeId "|" voucherId "|" reserver "|" expiresAt)
```

Default lifetime 30 min (`GMP_RELAY_RESERVATION_TTL_MS`); the client renews at 80 % with `{ renew: voucherId }`, keeping the ID. The client checks signature, relay NodeID, its own hop NodeID and expiry. Expiry is a hard delete; the relay remembers only recently expired voucher IDs (for one lifetime) so a late dial hears `reservation-expired` rather than `no-reservation`.

### 15.4 Sealed circuits

Before any GMP byte flows, the dialer seals the circuit to the callee's static X25519 key, which it knows from the contact / invite:

```
dialer:   e = fresh X25519 keypair; first RELAY_DATA on the circuit = e.pub (32 bytes)
both:     ikm  = X25519(e.priv, callee.staticPub) = X25519(callee.staticPriv, e.pub)
          okm  = HKDF-SHA256(ikm, salt = e.pub || callee.staticPub, info = "gmp-relay-circuit-v1", 64)
          dialer→callee key = okm[0..32], callee→dialer key = okm[32..64]
records:  AES-256-GCM, IV = 4 zero bytes || u64 counter per direction; wire = [16-byte tag][ciphertext]
```

The ordinary GMP handshake then runs inside the circuit, unchanged — it is what authenticates both parties and gives forward secrecy. The circuit layer exists so the relay never reads the cleartext HELLO / HELLO_ACK. After the handshake the dialer also checks that the proven NodeID matches the key it dialled.

**Forward secrecy of the circuit layer: NO.** The circuit key has one ephemeral contribution (the dialer's) against the callee's *static* key. Anyone who recorded a circuit — the relay is best placed to — and later obtains the callee's static X25519 private key can open every recorded circuit layer and read the inner cleartext HELLO / HELLO_ACK: both parties' NodeIDs and public keys, i.e. who talked to whom. Message content is not exposed: the inner GMP session keys include an ephemeral–ephemeral term (§4.3) whose private halves were discarded. Accepted for now; not changed by GM-N1c.

### 15.5 Record padding and traffic classes (GM-N1b-2)

Every sealed record's plaintext is exactly one bucket long; the padding is inside the AEAD, so the relay cannot tell padding from data:

```
record plaintext = [kind u8][length u16 BE][payload][zero padding to the bucket]
kind 0 = DATA, kind 1 = CLASS (payload: 1 byte, 1 = interactive, 2 = bulk)
```

| Class | Record plaintext size | On the wire (+16 tag) |
|---|---|---|
| INTERACTIVE (default) | smallest of 256 / 1024 / 4096 that fits | 272 / 1040 / 4112 |
| BULK | always 16384; the final record padded | 16400 |

The class is agreed at circuit set-up: the dialer's first sealed record (after the 32-byte circuit hello) is a CLASS record, padded like any other; both directions then use that class. A callee whose first sealed record is not a valid CLASS record closes the circuit. No cover traffic, no constant-rate sending, no timing jitter.

**Protocol constraint (binding).** A circuit's traffic class is fixed for its lifetime; there is no class switch, because switching per record would tell the relay "a file transfer starts now". Therefore **file transfer MUST open its own BULK circuit** and MUST NOT be sent over an INTERACTIVE (chat) circuit. An implementation that carries a file over an interactive circuit is non-conforming: it ships the file as 272 / 1040 / 4112-byte records, making the transfer both slow and conspicuous. Likewise, interactive traffic MUST NOT ride a bulk circuit.

### 15.6 Quotas and reason codes

Enforced by the relay; each refusal or teardown is a RELAY_STOP with a reason, and counted per reason in `/metrics`.

| Limit | Config | Default | Reason |
|---|---|---|---|
| reservations held by the relay | `GMP_RELAY_MAX_RESERVATIONS` | 1024 | `reservation-limit` |
| new reservations per /24 (IPv6 /48): token bucket | `GMP_RELAY_RESERVATION_RATE_PER_MINUTE` / `_BURST` | 30 per min, burst 256 | `subnet-rate-limit` |
| concurrent reservations per /24 | `GMP_RELAY_MAX_RESERVATIONS_PER_SUBNET` | 256 | `subnet-limit` |
| concurrent circuits per reservation | `GMP_RELAY_MAX_CIRCUITS_PER_RESERVATION` | 8 | `circuit-limit` |
| bytes per circuit (padded) | `GMP_RELAY_MAX_CIRCUIT_BYTES` | 64 MiB | `bytes-exceeded` |
| circuit lifetime | `GMP_RELAY_MAX_CIRCUIT_DURATION_MS` | 1 h | `duration-exceeded` |

Other reasons: `relay-disabled`, `no-reservation`, `reservation-expired`, `peer-gone`, `closed`, `malformed`. Renewals spend no token. The per-/24 limit is a rate because CGNAT puts hundreds of legitimate subscribers behind one address.

**Accepted residual (Sybil burst).** The bucket is per /24 (IPv6 /48), and CGNAT puts many subscribers in one. An attacker inside the victim's own carrier /24 can spend the 256-reservation burst (and then the 30/min refill) and deny new reservations to everyone else behind that /24 on this relay. Fixing it properly needs proof-of-work or attestation; not done.

### 15.7 Hop identities and nonce state: observed, not signalled (GM-N1b-3, GM-N1c-1)

Nothing in the handshake says a connection is a relay hop. (GM-N1b-3 used bit 0x80 of the HELLO version byte; HELLO is cleartext, so the bit told every passive observer "this user is opening a relay circuit". GM-N1c-1 removed it; a HELLO with version byte 0x81 is now refused like any unknown version, as it always was by older nodes, so old and new nodes interoperate fully again.)

- **Dialer.** Ephemerality is local: the hop identity is generated for one connection and its claim and counters live in memory only (`EphemeralNonceState`). No wire change.
- **Responder (every inbound session, every node).** Claim and counters are held in memory until the session carries its first **non-infrastructure frame** — any frame other than HELLO, HELLO_ACK, PING, PONG and the infrastructure range **0x0C–0x15** (relay 0x0C–0x10, storage 0x11–0x15; widened by GM-N2-0) — in either direction. Before that frame is sealed or dispatched, the session key is claimed in the persisted store (durable, §6.2, I3) and the counters move there; a refused claim tears the session down first. A session that closes without one is discarded. Keepalive is excluded deliberately: the initiator's key-confirmation PING is always its first encrypted frame, so counting it would persist every session and change nothing.
- **Role.** A key-confirmed responder session's first frame that is not keepalive decides its role: an infrastructure frame (0x0C–0x15) makes it a **hop** (infrastructure frames only from then on; never a peer, never persisted), anything else a **peer**. On a node that runs a relay or storage server, a session that sends nothing within `GMP_RELAY_ROLE_OBSERVATION_MS` (default 2000) is a peer; honest hops send RELAY_RESERVE / RELAY_CONNECT immediately after their confirmation PING. Nodes without a relay or storage server, and circuits, classify as peer at key confirmation.

Consequences. The relay's claim log and counter state do not grow with relayed traffic. For hop sessions I1 holds per connection, not across restarts. Replay protection for a relay-only session does not depend on persistence: a replayed HELLO meets a fresh responder ephemeral, derives a different session key, and cannot produce the key-confirmation PING (proof: `docs/relay-metadata.md`; test: `relay-ephemeral-nonce-test.js` §7). The role and promotion decisions read the frame's type byte before the frame is authenticated; forging it needs an on-path attacker, who can end the session anyway, and at worst persists one claim early or makes a peer look like a hop (which then fails on its first non-relay frame).

### 15.8 Role separation (GM-N1b-1)

`public-peers.json` entries carry `roles` (`"bootstrap"`, `"relay"`; absent = `["bootstrap"]`) and optionally `operator`. Bootstrap uses only `bootstrap` hosts. A client:

- never reserves on a host that has seen its real identity this session (`RoleSeparationError RESERVE_ON_BOOTSTRAP_HOST`);
- never connects with its real identity to a host holding its live reservation (`BOOTSTRAP_VIA_RELAY_HOST`) — checked **before connecting** by address and by NodeID (GM-N1c-3): the NodeID the caller knows (bootstrap candidate, public-peer entry, LAN beacon) or, for a bare address, the one `public-peers.json` lists for it, so a listed host is recognised under any of its listed names. Only a host whose NodeID is known from nowhere beforehand — learned through peer exchange (the NodeID is a third party's unverified claim) or typed in — is caught after the handshake instead, in which case it has seen the HELLO and the reservation is demoted;
- reports a relayed connection as `relayed` only when the relay's operator is known and differs from every operator whose infrastructure has seen the real identity; otherwise `relayed-unseparated`, shown in the UI.

### 15.9 What the relay learns

Both ends' network addresses and ports, which pairs it joins, when and for how long, bytes per circuit, and the number and timing of padded records (bucket sizes only). Not: NodeIDs, keys, message content or message sizes. Full statement: `docs/relay-metadata.md`.

A **passive observer on the path** (ISP, carrier) can still tell that a user uses a relay, flag or no flag: every frame header (length + type) is cleartext (§3.1, used as AAD, not encrypted), so relay frames show as type 0x0C–0x10; padded records give distinctive frame lengths; and the destination is a host listed with `roles: ["relay"]` in the public `public-peers.json`. Removing the HELLO bit removed one redundant signal, not the observation.
---

*Document version: 1.5.0-phase5-final | Phase 1: Delivered | Phase 2a: Delivered | Phase 2b: Delivered | Phase 3: Delivered | Phase 4: Delivered | Phase 5: Delivered*

## 16. Sealed Store-and-Forward (GM-N2, GM-N2b, GM-N2c)

A message for an offline contact is sealed to the contact's static X25519 key and left on a **storage host** (role `storage`), addressed only to a **bucket**. Full design, limits, self-hosting and the metadata statement: `docs/store-and-forward.md`. Bucketing hides a conversation only among users sharing a bucket; at launch there is one bucket (everyone), and buckets are fixed per direction so repeated observation adds nothing — see that document for the measurements before relying on it.

### 16.1 Addressing

```
sharedSecret = HKDF-SHA256(X25519(s_A, s_B), salt = sort(N_A, N_B), "gmp-sf-shared-v1")
offset       = HKDF(sharedSecret, "gmp-sf-epoch-offset-v1" || N_recipient)  mod 86400
epoch        = floor((unixSeconds + offset) / 86400)
tag          = HKDF(sharedSecret, "gmp-sf-tag-v1" || N_recipient || u64 epoch)      32 bytes, rotates daily, inside the seal
bucket       = top log2(bucketCount) bits of HKDF(sharedSecret, "gmp-sf-bucket-v1" || N_recipient)
               NO epoch term: fixed per direction for the pair's lifetime (GM-N2c-1)
```

The recipient NodeID in the info makes each direction its own channel. **The host never sees a tag.** `bucketCount` is release-pinned: `RELEASE_BUCKET_SCHEDULE` = `[{ bucketCount: 1, from: 0 }]` — one bucket at launch; the growth rule is derived from measured costs in `docs/store-and-forward.md`. A change appends `{ bucketCount, from }` in a release; from `from`, senders use the new count and every client fetches under both the new and the previous count for exactly one TTL, then drops the previous. Hosts accept bucket ids below the largest active count.

### 16.2 Blob

```
e = fresh X25519 keypair;  key = HKDF-SHA256(X25519(e, R_static), salt = e.pub || R_static.pub, "gmp-sf-seal-v1")
blob  = e.pub (32) || GCM tag (16) || AES-256-GCM(key, IV = 0, inner)          total = 4096 | 65536 | 1048576 bytes
inner = u32 len || tag (32) || receiptSecret (32) || senderNodeId (64) || payload || zero padding
payload = kind (1: 0x00 message, 0x01 receipt) || body          receipt body = the receiptSecret it acknowledges (32)
```

The three sizes are at-rest storage buckets, distinct from the relay's transit buckets (§15.5). Nothing the host can read names the sender or distinguishes a receipt from a message.

### 16.3 Messages

Plaintext inside the hop link's AES-GCM: `[u32 control length][JSON control][raw tail]`.

| Type | Control | Tail |
|---|---|---|
| STORE_REQUEST 0x11 | `{ requestId, bucket }` | blob |
| STORE_ACK 0x12 | `{ requestId, ok: true, expiresAt }` / `{ requestId, ok: false, reason }` | — |
| FETCH_REQUEST 0x13 | `{ requestId, buckets: [{ bucket, since }] }` — **exactly** `min(GMP_SF_FETCH_BUCKETS, active bucket count)` distinct entries (1 at launch, 4 above), shuffled; decoy entries carry cursors like real ones; cursors rounded down to 5 min by default | — |
| FETCH_RESPONSE 0x14 | per blob with `seq > since`: `{ requestId, blobId, bucket, seq }`; last `{ requestId, done: true, seq, truncated }` or `{ …, error }` | blob |
| 0x15 | **RETIRED** (was FETCH_DELETE, GM-N2). Never sent; ignored on receipt; never to be reused. Stays in the infrastructure range 0x0C–0x15, so it cannot promote a session. | — |

`seq` is the host's sequence number, strictly increasing across restarts (`max(last + 1, clock-ms × 1000)`); the final frame's `seq` is the next cursor for every entry (per-bucket last `seq` when truncated). Reasons: `storage-disabled`, `malformed`, `bad-size`, `bad-bucket`, `bad-fetch-size`, `rate-limited`, `store-failed`. STORE_REQUEST and FETCH_RESPONSE may declare up to 1 MiB + 64 KiB; every other type keeps 1 MiB.

### 16.4 Rules

- All STORE / FETCH traffic uses a **fresh throwaway hop identity per operation**; the hop opener refuses anything but an ephemeral identity. These frames never persist a session on the host.
- Blobs leave only by TTL (7 days, hard delete) and LRU eviction (256 blobs / 16 MiB per bucket). **No client can delete a blob or tell the host what it read.**
- **SENT (stored)** only on STORE_ACK ok. **DELIVERED** only when the sender opens a receipt blob — deposited by the recipient in the sender-direction bucket at its next poll, authenticated by the pair's tag, echoing the message's receipt secret. No timer sets either state. No receipt after two TTLs: reported as "no receipt", not as undelivered.
- One host, one role among bootstrap / relay / storage, per host and per named operator (§15.8, GM-N2-6).

### 16.5 What the storage host learns

Per operation: source address, time, bucket ids, cursors, size class. Per message, a candidate set (everyone fetching that bucket); over days of regular messages between one pair, the intersection of those sets — usually the recipient's address. Numbers and the comparison with a WhatsApp server: `docs/store-and-forward.md`.
