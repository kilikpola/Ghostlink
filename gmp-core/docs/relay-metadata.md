# Relay tier: what a hostile relay learns

Adversarial review of `src/relay/` after GM-N1, the GM-N1b corrections and
GM-N1c.
The question for every change: what does the public peer running the relay
learn that it did not learn before?

## Design points that decide the answer

- **Throwaway hop identities.** Reserver and dialer reach the relay under an
  identity generated for that one connection. A dial uses a fresh one every
  time. Nothing on the wire marks it (GM-N1c-1 removed the HELLO bit): the
  relay observes a hop from its first frame after key confirmation — a relay
  frame. The relay's links never carry a user's NodeID, and it keeps no
  persisted state about hops (no claim, no counters, no peer-cache entry, no
  topology announce): every inbound session's nonce state stays in memory
  until the session's first non-relay frame, which a hop never sends.
- **Sealed circuits.** The dialer seals the circuit to the callee's static
  X25519 key before any GMP byte flows; the GMP handshake (whose HELLO /
  HELLO_ACK are cleartext and carry both identities) runs inside it.
- **Padded records.** Every sealed record is one bucket: 256 / 1024 / 4096
  bytes (interactive) or a fixed 16384 (bulk), plus the 16-byte tag. Padding is
  inside the AEAD; the relay cannot tell it from data.
- **RELAY_DATA is not parsed** beyond its 4-byte circuit ID.
- **Role separation.** A client never reserves on a host that has seen its
  real identity this session, and never shows its real identity to a host
  holding its reservation. When the relay is not demonstrably run by a
  different operator, the connection is shown as "Relayed, not separated".

Tests: `relay-test.js` §4 (nothing identifying in anything the relay handled;
the relay's keys open no record), `relay-padding-test.js` (every record is a
bucket; different message lengths look identical), `relay-roles-test.js`,
`relay-ephemeral-nonce-test.js`.

## What the relay learns

| Observation | Detail |
|---|---|
| Reserver network address | IP and port of the node holding a reservation, for as long as it holds it (renewal every 24 min by default). |
| Dialer network address | IP and port of each dialling node, per circuit. |
| The pairing | That dialler address X reached reserver address Y through voucher V, when, for how long. |
| Traffic volume | Bytes each way per circuit — padded, so rounded up to whole records. |
| Record count and bucket | How many records each way, and which bucket each is. Interactive buckets reveal only "under 253 B / under 1 KiB / up to 4 KiB per record"; bulk reveals nothing per record. A large message is several 4 KiB records, so total volume stays visible. |
| **Timing** | **When each record is sent. This leaks typing rhythm and message cadence, and makes call presence visible (a steady stream of records). Accepted deliberately: no cover traffic, constant-rate sending or jitter, because the battery cost on mobile is unacceptable and the relay already holds both addresses.** |
| Traffic class | Interactive vs bulk is visible from the record size. |
| Voucher fan-in | How many distinct dialler addresses use one voucher — a proxy for how many contacts reach a reserver through this relay. |
| Reservations per /24 | Needed for the anti-Sybil rate limit. |
| Circuit hello | The dialer's per-circuit ephemeral X25519 public key (random, unlinkable across circuits). |

## What it does not learn

NodeIDs, static or signing keys of either party; message content; message
lengths below the bucket granularity; the inner GMP session keys; any
persisted trace of the hop identities after the connection ends.

## Linking the relay's view to identities (R2)

Two vectors remain for joining "address X used relay circuits" with
"address X is NodeID N":

1. **Operator level.** Hosts run by one operator can pool what they see. The
   client refuses to reserve on a host that has seen its real identity, but
   cannot stop one operator running both a bootstrap host and a relay host.
   It surfaces the case instead: "separated" is shown only for a relay whose
   operator is known and differs from every operator whose infrastructure
   has seen the real identity this session; everything else is
   RELAYED_UNSEPARATED in the UI. The shipped `public-peers.json` has no
   `operator` fields yet, so until they are added every relay is
   unseparated.
2. **IP level.** The relay always sees the user's address. Anything else that
   ties that address to the NodeID — another GMP host, an ISP, or the relay
   itself dialling back to a publicly reachable address and reading the
   HELLO_ACK the node sends to anyone — completes the link. Role separation
   removes the one join that was guaranteed (the same host seeing both); it
   does not make the address anonymous. That would need multi-hop relaying or
   a network-layer anonymiser, which are out of scope.

Role rules are applied by NodeID before the dial (GM-N1c-3): a dial carries
the NodeID the caller knows (bootstrap candidate, public-peer entry, LAN
beacon), and a bare address is looked up in `public-peers.json`, whose
entries carry `nodeId`. So a listed host reached under any of its listed
names is refused before it receives a byte, in both directions (reserve on a
host that saw the identity; connect with the identity to a reservation host).
**Residual:** a host whose NodeID is known from nowhere beforehand — learned
through peer exchange, where the NodeID is a third party's unverified claim,
or typed in — is still caught only after the handshake; it has then seen the
HELLO, and the reservation is demoted to unseparated rather than hidden.
(`relay-roles-test.js` §4b.)

## Active attacks

| Attack | Outcome |
|---|---|
| Read, alter, reorder or replay circuit records | AEAD with per-direction counters; any failure closes the circuit before the GMP link sees a byte. |
| Strip or change padding | Padding is inside the AEAD; a changed record fails authentication. |
| Splice a dialer onto a different reserver | Records are sealed to the intended callee's key; any other node fails the first one. |
| Impersonate the callee | Needs the callee's static private key and its handshake keys. |
| Replay a recorded dialer transcript | Fails the GMP handshake's key confirmation, as over TCP. |
| Forge or extend a voucher | Ed25519-signed; clients check signature, relay NodeID, their hop NodeID and expiry. |
| Replay a recorded hop handshake to open a second circuit | Fails at key confirmation; see "Replayed handshake" below. |
| Make a session look like a hop to keep it out of the persisted store | A session whose first frame is a relay frame is a hop for good: relay frames only, never a peer. It loses no replay protection (that comes from the handshake, below) and cannot carry anything else. |
| Deny service | Always possible: refuse, stall or stop circuits. Clients see the reason. |

## Compared with before GM-N1

The only relaying that existed was mesh forwarding of routed DATA: every
forwarding hop — the public peer included — sees NodeID prefixes in each
routed frame and the full NodeIDs and keys in the cleartext inner handshake.
That path is unchanged and discloses far more than the relay tier.

## Replayed handshake against a relay-only link (GM-N1c-1)

Deferring persistence is the shape of change that quietly disables a replay
guard, so the attack is written out.

**Session keys have an ephemeral contribution from each side.** Both the
initiator and the responder generate a fresh X25519 ephemeral per connection
(`_sendHELLO`; `_acceptConnection` → `generateEphemeralKeyPair()`), and

```
K = HKDF-SHA512( X25519(e_init, e_resp) || X25519(s_init, s_resp), info = label || hex(N_init) || hex(N_resp) )
```

— ephemeral–ephemeral plus static–static, not static–static alone
(`session.ts` `deriveLinkKeys`; PROTOCOL_SPEC §4.3, which described only the
ephemeral term until now).

**The attack.** Hop H (throwaway static key s_H, NodeID N_H) opens a hop to
relay R. On the wire: HELLO (N_H, s_H.pub, e_H.pub, timestamp, nonce, Ed25519
signature) → HELLO_ACK (e_R.pub, proof) → PING sealed under K (key
confirmation) → RELAY_RESERVE sealed under K. H never sends a non-relay frame,
so R never persists anything about this session. Eve records every byte and,
within the 120 s timestamp window, replays them on a new connection to open a
second circuit.

1. R checks the replayed HELLO. It is genuine: the signature verifies, the
   NodeID matches the keys, the timestamp is in window. Nothing persisted can
   refuse it — and nothing persisted ever could have, see step 6.
2. R generates a fresh ephemeral e_R′ and derives
   K′ = HKDF(X25519(e_R′, e_H.pub) || X25519(s_R, s_H.pub), …). K′ ≠ K except
   with probability ~2⁻²⁵²: e_R′ is 32 fresh random bytes.
3. R sends HELLO_ACK′ and enters `confirming`. In that state every frame but
   PING is ignored (`_handleRELAY` returns unless `connected`), so the replayed
   RELAY_RESERVE is never processed; R does not classify the session and
   creates no reservation.
4. To leave `confirming` Eve must send a PING that opens under K′ at counter 0.
   K′ needs X25519(e_H.priv, e_R′.pub) — e_H.priv never left H and was
   discarded with its connection — and X25519(s_H.priv, s_R.pub), H's static
   private key. Eve has neither.
5. The recorded PING was sealed under K, so it fails AES-GCM authentication
   under K′: R tears the session down ("PING decryption failed") and penalises
   the source. If Eve sends only the HELLO, the 10 s confirmation timer does
   the same.
6. Why persistence was never the guard: the claim log is keyed by the
   fingerprint of the session key. Because R contributes a fresh ephemeral to
   every session, a replayed HELLO never reproduces a key R has seen, so a
   persisted claim would have accepted it too. The claim log protects against
   a *repeated key*, not a repeated HELLO.

**Result: the attack fails**, identically with and without persistence.
Executable: `relay-ephemeral-nonce-test.js` §7 records a real hop's frames,
replays them, and checks: the replayed session has a different key, the
recorded PING does not open, no reservation appears, nothing is persisted,
and a HELLO replayed alone stays in `confirming`.

**What deferral does cost** — the residual GM-N1b-3 already accepted for
flagged hops, now for every responder session until its first non-relay
frame: if R's random number generator repeated an ephemeral (a broken RNG, a
VM restored from a snapshot) *and* the matching HELLO were replayed, a
relay-only session could run under a key R used before, i.e. AES-GCM nonce
reuse over its relay frames. The persisted claim would have caught that; the
in-memory claim does not across restarts. A real session's first non-relay
frame still meets the persisted claim, which refuses a key persisted before.
Keepalive frames sealed in the meantime are identical under a repeated key
(empty payload, same header), so they leak nothing further.

## Forward secrecy of the sealed circuit (GM-N1c-2)

**No: the circuit layer does not survive later compromise of the callee's
static key.** Its key is one fresh dialer ephemeral against the callee's
static X25519 key; whoever recorded circuits (the relay is best placed) and
later obtains that key opens every recorded circuit layer and reads the inner
cleartext HELLO / HELLO_ACK — both NodeIDs and public keys, i.e. who talked to
whom. Message content stays protected: the inner GMP session keys include an
ephemeral–ephemeral term whose private halves were discarded. Not changed.

## Passive observers (after GM-N1c-1)

Removing the HELLO bit removed one signal, not the observation. A passive tap
between a user and a relay still sees that the user uses a relay:

- every frame header (4-byte length + type byte) is cleartext — it is the
  AEAD's associated data, not encrypted — so relay frames show as types
  0x0C–0x10;
- padded records make RELAY_DATA frames distinctive lengths;
- the destination is a host listed with `roles: ["relay"]` in the public
  `public-peers.json`.

Hiding relay use from the path would need encrypted frame types (a wire
change old nodes cannot parse) and relay hosts that are not publicly listed
as such. Not done; needs a decision.

## Accepted residuals

- **Sybil burst (CGNAT).** The anti-Sybil token bucket is per /24 (IPv6 /48).
  An attacker inside the victim's own carrier /24 can spend the burst of 256
  reservations (then the 30/min refill) and deny new reservations on this
  relay to everyone behind that /24. A real fix needs proof-of-work or
  attestation. Accepted.
- **Traffic class is fixed per circuit.** Interactive or bulk is chosen at
  set-up and never switched — switching per record would announce "file
  transfer starting" to the relay. Consequence, binding on implementations
  (PROTOCOL_SPEC §15.5): **file transfer opens its own bulk circuit** and never
  reuses an interactive chat circuit.

## Replayed handshake, restated for storage frames 0x11-0x15 (GM-N2-0)

GM-N2-0 widens the range that never persists from 0x0C-0x10 to 0x0C-0x15, so a
storage hop — a throwaway identity that deposits or fetches and then leaves —
is never persisted either. The argument is restated for these types, not
inherited.

The attack: Eve records a storage hop H's session to storage host S — HELLO,
key-confirmation PING, STORE_REQUEST (0x11) or FETCH_REQUEST (0x13) — and
replays it on a new connection to deposit again, or to fetch or delete as H
did. H never sent a non-infrastructure frame, so S persisted nothing.

1. S accepts the replayed HELLO (signature valid, timestamp in window) and
   derives K′ = HKDF(X25519(e_S′, e_H.pub) || X25519(s_S, s_H.pub), …) with a
   fresh e_S′ generated for this connection (`_acceptConnection`). K′ differs
   from H's key.
2. S waits in `confirming`. `_handleSTORAGE` returns unless the link is
   `connected`, exactly like `_handleRELAY`, so the replayed 0x11 / 0x13 / 0x15
   frames are never decrypted, never handed to the storage server, and never
   classify the session.
3. Leaving `confirming` needs a PING that opens under K′, which needs e_H.priv
   (discarded) and s_H.priv (H's throwaway static key). The recorded PING was
   sealed under H's key and fails: S tears the session down.
4. The persisted claim log never mattered here: a replayed HELLO cannot
   reproduce a key S has seen, because S contributes a fresh ephemeral.

**Result: the attack fails.** (0x15, FETCH_DELETE, was retired by GM-N2b-1;
it is still in the range, and a session opening with it is a hop that is
ignored — `store-forward-n2b-test.js` §1.) Tested: `relay-ephemeral-nonce-test.js` §7b
(each of 0x11-0x15 as a first frame is a hop, nothing persisted; replayed
STORE_REQUEST session: new key, PING fails, 0 handled); strict-mode trace line
`scope-sf`.
