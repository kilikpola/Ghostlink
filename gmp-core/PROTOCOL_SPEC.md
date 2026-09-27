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

### 3.3 HELLO Payload (265 bytes, unencrypted)

| Offset | Size | Field                               |
|--------|------|-------------------------------------|
| 0      | 1    | protocolVersion (value 0x01)        |
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
sharedSecret = X25519(localEphemeralPriv, remoteEphemeralPub)

initiatorInfo = "ghost-mesh-hkdf-phase1-initiator" || initiatorNodeId || responderNodeId
responderInfo = "ghost-mesh-hkdf-phase1-responder" || initiatorNodeId || responderNodeId

sessionInitiatorKey = HKDF-SHA512(salt=null, IKM=sharedSecret, info=initiatorInfo, length=32)
sessionResponderKey = HKDF-SHA512(salt=null, IKM=sharedSecret, info=responderInfo, length=32)
```

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
| Passive Eavesdropping        | AES-256-GCM encryption on `DATA`/`PING`/`PONG` frames                                | MITIGATED (Ref: [link.js](src/link.js)) |
| Replay (HELLO/HELLO_ACK)    | Timestamp ±2 min window checks and strict signature verification                    | MITIGATED (Ref: [link.js](src/link.js)) |
| Timestamp Replay (stale)    | Timestamp tolerance checks reject old requests                                     | MITIGATED (Ref: [link.js](src/link.js)) |
| Impersonation (no priv key) | Ed25519 signature checks bind static keys to the session                           | MITIGATED (Ref: [link.js](src/link.js), [identity.js](src/identity.ts)) |
| Man-in-the-Middle           | Ephemeral key exchange and GCM encryptedProof authentication check                  | MITIGATED (Ref: [link.js](src/link.js)) |
| Reflection (reflected HELLO)| NodeID self-check prevents self-connection                                          | MITIGATED (Ref: [link.js](src/link.js)) |
| Pubkey Replacement          | SHA-512 NodeID derivation verification check                                        | MITIGATED (Ref: [link.js](src/link.js)) |
| Desynchronization           | GCM auth tag check on payload decryption                                            | MITIGATED (Ref: [link.js](src/link.js)) |
| Nonce reuse via key collision | Ephemeral key LRU check + persisted nonce high-water mark validation               | MITIGATED (Ref: [link.js](src/link.js), [nonce-store.js](src/nonce-store.ts)) |
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

Relay nodes forward ciphertext only and have no access to the session keys of the peers they relay for — they see traffic volume and timing only, not content.

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

### 13.4 Bootstrap Sequence
Upon starting, a node executes the following stages:
1. **Stage 1 (Cache-based)**: Read `peer-cache.json`, sort by reliability score, and attempt connection to the top `N` candidates in parallel (default `N=5`). Wait up to 10 seconds or until `minPeers` (default 3) is reached.
2. **Stage 2 (Public Peers)**: If connections are still below `minPeers`, load public peers from `public-peers.json` and attempt connection. Public peers respond to `PEER_REQUEST` messages, expanding the in-memory candidate pool. Wait up to 15 seconds.
3. **Stage 3 (Manual Fallback)**: If connections are still below `minPeers`, emit `bootstrap-failed` and display manual fallback instructions. The node remains fully functional for incoming connections.
4. **Re-runs & Backoff**: If active connections drop below `minPeers/2`, wait 30 seconds and retry from Stage 1. Repeated bootstrap failures trigger exponential backoffs of 30s, 60s, 120s, and 300s.

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

*Document version: 1.5.0-phase5-final | Phase 1: Delivered | Phase 2a: Delivered | Phase 2b: Delivered | Phase 3: Delivered | Phase 4: Delivered | Phase 5: Delivered*