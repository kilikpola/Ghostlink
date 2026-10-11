# Sealed store-and-forward (GM-N2, GM-N2b, GM-N2c)

A message to an offline contact is sealed to the contact's key and left in a
**mailbox** — a storage host — until the contact fetches it. This replaces
"Not sent: this peer is offline".

A one-hop mailbox cannot hide the sender→recipient edge from the operator
storing it. This document says exactly what it does hide, from whom, and what
it does not.

## Read this first: what bucketing does and does not give you

Messages are filed in **buckets**, and many conversations share each bucket,
so the mailbox host cannot tell which conversation a message belongs to —
**but only among the people using the same mailbox.** That is a property of
how many people use the network, not of this code.

- **At launch there is one bucket.** Every client fetches every blob. The
  host learns nothing from buckets, because there is nothing to tell apart;
  it still sees who deposits and who fetches, and when.
- Buckets are **fixed per conversation direction** (GM-N2c). Earlier builds
  rotated them daily, and seven daily samples let a patient host intersect a
  recipient down to one address; fixed buckets repeat one observation, which
  adds nothing (measured below).
- Nothing in the app claims anonymity from bucketing: no badge, tooltip or
  settings line. The app says where your mailbox is and whether it is
  separated from the hosts that know your identity — nothing more.

What does protect you today: content sealed end to end; the mailbox host never
learns your identity from the mailbox traffic itself; and you can **self-host
your mailbox**, which takes the third party out entirely.

## How it works

| Step | Who | What the storage host sees |
|---|---|---|
| Deposit | sender, fresh throwaway hop identity | source IP, time, bucket id, blob size class (4 KiB / 64 KiB / 1 MiB) |
| STORE_ACK | host | → sender shows **sent (stored)** |
| Poll | recipient, fresh throwaway hop identity per poll | source IP, time, exactly 4 entries `{ bucket, since }` |
| Fetch | host → recipient | the blobs in those buckets deposited after each cursor (≤ 256) |
| Receipt | recipient, at its **next** poll | a deposit like any other: source IP, time, bucket, 4 KiB |
| Receipt read | sender's poll of its own mailbox | nothing new → sender shows **delivered** |

- **No delete (GM-N2b-1).** Nothing a client says removes a blob or tells the
  host what it read. Blobs leave only by TTL (7 days, hard delete) and by LRU
  eviction. Wire byte 0x15 (formerly FETCH_DELETE) is retired.
- **Receipts are blobs (GM-N2b-2).** Each message seals a random receipt
  secret. The recipient, having opened it, deposits a sealed receipt carrying
  that secret into the *sender-direction* bucket on the sender's mailbox, at
  its next poll (not in the session that fetched the message). To the host it
  is a 4 KiB blob with the same STORE_REQUEST fields as any message. The
  sender shows **delivered** only when it opens that receipt, authenticated by
  the pair's channel tag. No timer anywhere in this path sets a state.
- **Buckets are fixed (GM-N2c-1).** `bucket = top bits of HKDF(sharedSecret,
  "gmp-sf-bucket-v1" || recipient NodeID)` — no epoch term, stable for the
  pair's lifetime, one per direction. The tag inside the seal still rotates
  daily and still identifies the contact to the recipient.
- **Cursors (GM-N2b-3, N2c-4).** Each entry carries `since`, the host sequence
  number from the last response covering that bucket, **rounded down to a
  5-minute window** by default; the host returns only newer blobs. A bucket
  never fetched starts one TTL back (never 0, which would mark it). A local
  seen-set means nothing is trial-decrypted twice.
- **Decoys are fake channels.** Each client keeps `GMP_SF_DECOY_CHANNELS`
  (default 2) random channel secrets and polls them exactly like contacts:
  same fixed bucket per channel, same round-robin, same cursors. At one
  bucket they are inert (everything is bucket 0); above one they activate. A decoy entry is encoded,
  rotated and cursored like a real one, so the request itself does not mark
  it. (Random padding with a previously returned cursor only fills in when the
  whole set is smaller than 4.)
- **Sealing.** Fresh X25519 per blob against the recipient's static key,
  HKDF, AES-256-GCM. Sender NodeID, tag and receipt secret are inside. No
  forward secrecy against later compromise of the recipient's static key.
- **Polling.** On app foreground, on network change (`online` event), and on
  an interval jittered uniformly over 0.5–1.5 × `GMP_SF_POLL_INTERVAL_MS`
  (default 15 min). One FETCH_REQUEST per poll of exactly
  `min(4, bucketCount)` entries — **one entry at launch**. The set is every
  contact's and decoy channel's fixed bucket, under every active bucket count.
  **Latency:** at one bucket every poll covers everything; above that a
  message is fetched within `ceil(set / 4)` polls (12 contacts + 2 decoys ≈ 14
  buckets ≈ 4 polls ≈ 1 h at the default interval). DELIVERED then needs the
  recipient's next poll plus up to one rotation of the sender's.
- **Where the mailbox is.** `GMP_SF_STORAGE_PEER` (self-hosted), else the
  first `public-peers.json` entry with role `storage`. Each user tells its app
  contacts its mailbox end to end once connected; senders deposit there.

### Cursor rounding

A cursor is a sequence number the host itself returned. Exact cursors let the
host chain one client's successive polls and tell apart clients behind one
shared (CGNAT) address — and those users are the population this subsystem
exists for. So cursors are **rounded down to 5 minutes by default**
(`GMP_SF_CURSOR_QUANTUM_MS`, 0 = exact): everyone who polled in the same
window sends the same value. Cost: the host resends up to one window of blobs
per bucket; the seen-set skips them without decrypting (counted as `refetched`
in each poll report).

## Limits and abuse

| Limit | Config | Default |
|---|---|---|
| blob lifetime (hard delete) | `GMP_SF_TTL_MS` | 7 days |
| blobs per bucket (LRU eviction) | `GMP_SF_BUCKET_MAX_BLOBS` | 256 |
| bytes per bucket (LRU eviction) | `GMP_SF_BUCKET_MAX_BYTES` | 16 MiB |
| entries per FETCH_REQUEST, exactly | `GMP_SF_FETCH_BUCKETS` | 4 |
| blobs per FETCH_RESPONSE | `GMP_SF_FETCH_MAX_BLOBS` | 256 |
| deposits per /24 (IPv6 /48), token bucket | `GMP_SF_DEPOSIT_RATE_PER_MINUTE` / `_BURST` | 30 / 256 |

The deposit limit is the N1b-4 `SubnetTokenBucket` with its own quota. The
GM-N2 brief asked for it "per relay reservation"; a depositor never holds a
reservation on its storage host (the roles are separated), so it is keyed per
source /24.

**Known and accepted, not fixed:**

- (a) A malicious contact holds the pair secret, so it knows the channel's
  buckets and can fill them — denying that channel (and every other channel
  sharing those buckets) until the TTL.
- (b) Anyone can flood a bucket with 256 blobs and evict other users' blobs
  (LRU). An evicted message is never read, so never shows delivered; the
  sender shows "no receipt" after two TTLs.
- (c) Same-/24 Sybil burst as for relays (GM-N1b-4).
- (d) Blobs are no longer removed when read, so storage holds every message
  for its full TTL — more disk per message than with deletes.

## Bucket count (GM-N2c-3)

**One bucket at launch**, pinned per release (`RELEASE_BUCKET_SCHEDULE` in
`sf-crypto.ts`), not a runtime setting. A change is a new schedule entry
`{ bucketCount, from }` in a release: from `from`, senders deposit under the
new count and every client fetches under **both** counts for exactly one TTL
(7 days), then drops the old. The 1 → 2 transition is tested end to end
(`store-forward-n2b-test.js` §4); the fetch shape and decoy machinery are
tested inert at one bucket (`store-forward-test.js` §6b) and live above it.

### When to grow it — the arithmetic

**Measured** (`gmp-core`, this desktop, memory transport, 2026-09-29):

| Quantity | Value |
|---|---|
| wire bytes per 4 KiB blob fetched | **4 240 B** (4 096 blob + frame, control, AEAD) |
| fixed cost of one poll with nothing new (hop handshake + request + final frame) | **780 B** |
| trial decryption of one 4 KiB blob | **1.5 ms** (desktop; phone not measured) |

**Policy inputs — assumptions, not measurements**, to be replaced:

| Input | Assumed | Replace with |
|---|---|---|
| m — offline messages per active user per day | 10 | the storage host's own `deposits` counter ÷ 2 (each message also makes a receipt) |
| D — download budget per user per day | 20 MiB | a product decision for mobile data |
| s — buckets in a user's fetch set (contacts + 2 decoys) | 14 | — |
| polls per day | 96 (15 min) | — |

Every blob lands in one bucket. A user fetching `s` fixed buckets out of `k`
downloads a fraction `f(k) = 1 − (1 − 1/k)^s` of all blobs. Network-wide there
are `2·m·U` blobs a day (message + receipt), so per user per day:

    bytes(k) = 2·m·U·f(k)·4240 + 96·780        decrypt(k) = 2·m·U·f(k)·1.5 ms

**Rule:** use the smallest power-of-two `k` with `bytes(k) ≤ D`. At `k = 1`,
`f = 1` and the limit is `U ≤ (D − 96·780) / (2·m·4240)` ≈ **246 users**.

| Active users | bucketCount | users per bucket | fraction downloaded | MiB / day | decrypt s / day (desktop) |
|---|---|---|---|---|---|
| 50 | 1 | 50 | 100 % | 4.1 | 1.5 |
| 100 | 1 | 100 | 100 % | 8.2 | 3.0 |
| 250 | 4 | 62 | 98 % | 19.9 | 7.4 |
| 500 | 32 | 16 | 36 % | 14.6 | 5.4 |
| 1 000 | 64 | 16 | 20 % | 16.1 | 5.9 |
| 5 000 | 512 | 10 | 2.7 % | 11.0 | 4.0 |
| 50 000 | 4 096 | 12 | 0.3 % | 13.9 | 5.1 |

Two things the arithmetic says plainly:

- **Growth is not smooth.** With 14 buckets per user, small counts barely
  reduce downloads (`f(4) = 98 %`), so past ~250 users the count has to jump
  to ~32. Plan the first real step as 1 → 32, not 1 → 2.
- **The target settles near 10–16 users per bucket** under these inputs. The
  trigger to grow is measurable without any client telemetry: the storage
  host's deposits per day give `2·m·U` directly.

## Storage role separation (GM-N2-6)

`public-peers.json` roles are `bootstrap`, `relay`, `storage`. A client
never uses one host — or two hosts of one named operator — for more than one
of them. Refusals happen before any byte is sent to the host (and again once
the throwaway hop learns the host's NodeID): `STORAGE_ON_BOOTSTRAP_HOST`,
`STORAGE_ON_RELAY_HOST`, `RESERVE_ON_STORAGE_HOST`,
`BOOTSTRAP_VIA_STORAGE_HOST`, and the N1b-1 pair `RESERVE_ON_BOOTSTRAP_HOST`,
`BOOTSTRAP_VIA_RELAY_HOST`, which also refuse at operator level.

Where separation cannot be established — a storage host of unknown operator,
or a bootstrap host of unknown operator — the UI shows **"Ghost Mesh · Storage
not separated"** in amber.

## Self-hosting a mailbox

```sh
# on a machine you control, reachable by your contacts
gmp generate-seed                                   # once; keep it
GMP_SEED_PHRASE="<12 words>" GMP_PORT=49600 gmp storage-peer
#   GMP storage peer listening on port 49600
#   NodeID 3e37…
#   Clients: GMP_SF_STORAGE_PEER=<this host>:49600#3e37…
```

Then run your app's node with
`GMP_SF_STORAGE_PEER=<public host or IP>:49600#<NodeID>`. Your node tells your
contacts (end to end) to deposit there. The storage peer runs no bridge, no
bootstrap dialling and no LAN beacons, and keeps blobs sealed at rest under a
key derived from its seed in `$GMP_DATA_DIR/storage`. Tested end to end over
real TCP by `test/storage-selfhost-test.js`, which spawns exactly this command.

## What a hostile storage peer learns about one user over seven days

(Restated after GM-N2c. The GM-N2 answer — an exact per-message edge from
FETCH_DELETE — and the GM-N2b answer — rotating buckets intersecting to one
address in a week — no longer apply.)

User U, normal use: about 12 contacts, a few offline messages a day, app
opened a few times a day. The host sees, per address: every deposit (bucket,
time, size class) and every fetch (bucket ids and rounded cursors, time).

### At launch (one bucket)

Every deposit goes to bucket 0 and every client fetches bucket 0. Buckets tell
the host nothing. It learns, per address: when it deposits (and how many
4 KiB / 64 KiB / 1 MiB blobs), when it polls, and when the app is opened
(foreground polls). Linking a deposit to a fetcher is left to **timing alone**
— e.g. a deposit at 12:00 and the only fetch between 12:00 and 12:15 — which
thins out as more users poll in the same window, and which the jittered
interval blurs but does not remove.

### Above one bucket: the measurements

`test/sf-anonymity-sim-test.js`, real derivation, 64 buckets, mutual
contacts averaging 12, 2 decoy channels per user, every fetch set covered each
day, one offline message a day from A to B:

**A. Intersection over days — candidates for "who is B"**

| buckets | users | after 1 day | after 3 days | after 7 days | exact after 7 days |
|---|---|---|---|---|---|
| rotating (GM-N2b) | 10 | 3.6 | 1.3 | 1.0 | 100 % |
| rotating | 100 | 35.2 | 5.8 | 1.1 | 85 % |
| rotating | 1 000 | 360.0 | 44.8 | 1.8 | 60 % |
| **fixed (GM-N2c)** | 10 | 2.3 | 2.3 | 2.3 | 40 % |
| **fixed** | 100 | 19.1 | 19.1 | 19.1 | 0 % |
| **fixed** | 1 000 | 201.2 | 201.2 | 201.2 | 0 % |

The 7-day column **stops converging**: it equals day 1 exactly, at bucket
occupancy (about a fifth of users fetch any given bucket at 64 buckets). At
10 users the pool is simply small.

**B. Residual — A's whole deposit-bucket set against everyone's fetch set**
(1 000 users, fixed buckets, 64 buckets):

| A has | A deposits into | users sharing ≥ 1 bucket with A | fetchers per deposit bucket | A's contacts among the top-k by overlap | chance |
|---|---|---|---|---|---|
| 3 contacts | 3.0 buckets | 479 of 999 (48 %) | 195 | 0.0 % | 0.3 % |
| 10 | 9.0 | 865 (87 %) | 193 | 0.0 % | 1.0 % |
| 50 | 35.6 | 998 (100 %) | 198 | 9.6 % | 5.0 % |

**Overlap is near-universal at realistic contact counts** (87 % of users at
10 contacts, 100 % at 50); each of A's deposit buckets is fetched by ~195
users; and ranking users by overlap finds A's contacts no better than chance
up to 10 contacts, and only ~2× chance at 50.

### (b) The storage operator does not run U's bootstrap peer — the product claim

At launch: addresses and timing only, as above — no bucket information at
all. Above one bucket, with fixed buckets: for each of U's offline messages, a
candidate set of recipient addresses the size of the bucket's occupancy
(about a fifth of users at 64 buckets, 10–16 users per bucket on the growth
schedule), **which does not shrink with repetition**. Plus U's poll times and
app-open times, and size classes. No content, NodeIDs or keys, no online
traffic.

**Compared with a WhatsApp server** (identities, the full sender→recipient
graph of every message, address book, groups): materially better as far as
the mailbox host's own view goes — the edge is ambiguous within the bucket
population and stays so. The remaining exposure is **timing** (deposit
followed by a lone fetch) at small network sizes, and whatever joins
addresses to people.

### (a) The storage operator also runs U's bootstrap peer

(Refused whenever operators are named; possible when they are not — and the
shipped list names none.) The bootstrap host maps U's address to U's NodeID,
so everything in (b) becomes NodeID-level: U's poll pattern and app-open times
by NodeID, and U's deposit/fetch timing by NodeID. The bucket ambiguity above
is unchanged; timing correlation is what remains to link sender and
recipient.

### What would change the answer further

1. **Route deposits and fetches through a relay** separated from the storage
   operator (GM-N3-4): the host then sees the relay's address, not U's, which
   removes the address from both the timing and the bucket views. Needs a live
   relay host.
2. **Self-host the mailbox** (built): the storage operator is the recipient.

## Passive observers

Frame headers are cleartext, so a tap sees storage frames (0x11–0x14) and
their sizes. Hiding that is the v2 wire change (encrypted frame types).
