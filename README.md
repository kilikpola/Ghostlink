# 👻 GhostLink

**Zero Trust · Zero Trace · Zero Servers**

A peer-to-peer encrypted communication platform where nothing is stored on any server — ever. Messages, files, calls, and meetings are end-to-end encrypted, blockchain-chained for tamper detection, and distributed exclusively across connected peers.

> Your data lives on your device. Your backups live with your peers. No one else has access — not even us.

**Web + Desktop + Mobile**

-----

## Why GhostLink?

Every major messaging app — even the “secure” ones — stores metadata on central servers. Who you talked to, when, how often, from where. GhostLink eliminates this entirely.

- **No servers.** Communication is peer-to-peer via WebRTC. There is no backend to hack, subpoena, or compromise.
- **No metadata.** Connection timestamps, IP addresses, and contact graphs never leave your device.
- **No trust required.** Cryptography enforces the rules, not policy.

-----

## Architecture

```
┌──────────────────────────────────────────┐
│             USER DEVICES                  │
│                                           │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐ │
│  │   Web    │  │ Desktop  │  │ Mobile  │ │
│  │ (React)  │  │(Electron)│  │ (React  │ │
│  │          │  │          │  │ Native) │ │
│  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │      │
│       └──────────┬───┘──────────────┘      │
│                  │                          │
│          ┌───────▼────────┐                 │
│          │  WebRTC P2P    │  ◄── Direct     │
│          │  Data Channels │      Connection │
│          └───────┬────────┘                 │
│                  │                          │
│          ┌───────▼────────┐                 │
│          │    Hybrid      │  ◄── QR/Paste   │
│          │   Signaling    │      first,     │
│          │                │      relay for  │
│          │                │      reconnect  │
│          └────────────────┘                 │
└──────────────────────────────────────────┘
```

-----

## Cryptographic Stack

|Layer             |Technology                             |Purpose                                               |
|------------------|---------------------------------------|------------------------------------------------------|
|Key Exchange      |ECDH P-256                             |Derive shared secrets between peers                   |
|Message Encryption|AES-256-GCM                            |Encrypt every message with unique IV                  |
|Forward Secrecy   |Signal Protocol (X3DH + Double Ratchet)|New keys per message — past messages safe if key leaks|
|Hashing           |SHA-256                                |Blockchain integrity, fingerprints                    |
|Key Derivation    |PBKDF2 (100,000 iterations)            |Derive master key from seed phrase                    |
|Identity Recovery |Shamir’s Secret Sharing GF(256)        |Split identity into 7 shares, any 3 recover it        |
|Seed Backup       |BIP39-style 12-word phrase             |Human-readable identity backup                        |

-----

## Platform Details

### Web App — `index.html`

Single HTML file with React 18 + Babel transpilation. No build step needed.

**Screens:** 
- **Splash**: Flying ghosts animation + dynamic logo loading.
- **Onboarding (v0.0.1)**: 3-step interactive walkthrough explaining E2EE, P2P architecture, and blockchain integrity BEFORE account setup.
- **Setup**: Zero-knowledge identity generation (name + BIP39 seed phrase).
- **Main Chat**: Full direct-communication interface with multi-theme support.

**Features:**

- 4 themes: Phantom (teal), Crimson (red), Arctic (cyan), Void (purple)
- Responsive layouts: mobile, tablet, desktop
- Drag-and-drop encrypted file upload
- Emoji picker (30 curated emojis)
- Self-destruct messages (30s / 60s / 5min)
- Reply threading and pinned messages
- Blockchain explorer (view SHA-256 chain per conversation)
- QR code invite generation (pure SVG, Reed-Solomon error correction)
- **Manual Signaling (v0.0.1)**: Robust serverless handshake with Unicode-safe Base64 encoding.
- **Account Deletion (v0.0.1)**: 2-step secure wipe of private keys and local data.
- Message search across encrypted conversations

### Desktop App — Electron

|Module       |Purpose                                                           |
|-------------|------------------------------------------------------------------|
|`main.js`    |Window management, IPC, GMP node, deep links, CSP                 |
|`preload.js` |Secure contextBridge API (`window.ghostlink`)                     |
|`titlebar.js`|Custom frameless title bar (38px, draggable)                      |
|`tray.js`    |System tray icon, badge count, flash on messages                  |
|`updater.js` |Auto-updates via GitHub Releases                                  |

**Desktop-specific features:**

- Frameless window with custom title bar
- Minimize to system tray with badge count
- Deep link protocol (`ghostlink://`)
- Auto-update (download + install from GitHub Releases)
- Embedded Ghost Mesh node (mesh port 49500, local bridge on 127.0.0.1:3002)
- Persistent window position
- Secure storage via `electron-store`
- Strict Content-Security-Policy headers

### Mobile App — React Native

**Screens:**

|Screen          |Purpose                                                  |
|----------------|---------------------------------------------------------|
|`SetupScreen`   |3-step identity creation (name → seed → confirm)         |
|`ChatListScreen`|Chat list with swipe actions (pin, mute, delete), FAB    |
|`ChatScreen`    |Full chat with bubbles, typing indicators, voice messages|
|`CallScreen`    |Voice/video with draggable PiP, ringing animations       |
|`SettingsScreen`|5 themes, security info, font slider, network config     |
|`RecoveryScreen`|Backup/Verify/Restore with Shamir fragments              |

**Services:**

|Service           |Purpose                                               |
|------------------|------------------------------------------------------|
|`CryptoService`   |ECDH, AES-GCM, SHA-256, ECDSA (OpenSSL-backed)        |
|`WebRTCService`   |`react-native-webrtc` peer connections + data channels|
|`SignalingService`|WebSocket with auto-reconnect + health probe          |
|`StorageService`  |AsyncStorage wrapper with encryption                  |

**Components:**

|Component        |Purpose                                                       |
|-----------------|--------------------------------------------------------------|
|`GhostAvatar`    |Deterministic gradient avatar from name hash                  |
|`MessageBubble`  |Chat bubble with receipts, replies, self-destruct, attachments|
|`EncryptionBadge`|E2EE status pill (tap for cipher details)                     |

**5 Themes:** Phantom, Neon, Blood, Ocean, Cyber

-----

## P2P Connectivity

### Ghost Addresses (connect by identity, not by location)

Every GhostLink identity has a short, stable identifier derived from its NodeID:

```
GHOST-7K2-M4Q-8ZB
```

You give it to someone once. It never changes, it is the same on every device
restored from your recovery phrase, and there is nothing to register or renew.

It is a **shorthand, not the identity itself**. Those nine characters carry 45
bits of the NodeID — short enough to read down a phone line, but not unique in
principle: two identities can in theory produce the same Ghost Address. The
resolver detects that case, refuses to guess between the candidates, and asks
you for the peer's full NodeID instead. That full NodeID is shown (and copyable)
under your address in Settings, and `Connect` accepts it wherever it accepts a
Ghost Address. The NodeID is the identity; the Ghost Address is how you say it
out loud.

Critically, neither contains an IP address or a port. That is what makes them
work from anywhere:

```
CONNECTING:
  A shows their Ghost Address (Peer Connection → My Address)
      │
      ▼
  B pastes it (Peer Connection → Connect), or scans the QR
      │
      ▼
  B's node resolves the address to a full NodeID, using the node IDs it
  already knows about:
      ├── topology announcements flooded through the mesh   (internet)
      ├── UDP discovery beacons from this subnet            (LAN, no internet)
      └── its own peer cache                                (seen before)
      │
      ▼
  B connects by NodeID:
      ├── direct TCP if the peer has a reachable address
      └── otherwise a routed GMP virtual circuit through the mesh,
          which is what works behind NAT and CGNAT
      │
      ▼
  Encrypted session established. Both sides remember each other.

STAYING CONNECTED (no user action, ever):
  Bridge socket drops   → reconnected automatically, backing off to 15s
  Peer goes offline     → redialled automatically, backing off to 30s
  App restarts          → every previous peer session is re-established
```

There is no manual SDP paste and no second code format. Earlier builds fell back
to a wall of base64 whenever the mesh was slow to start, which is how most people
ended up seeing it; the mesh now waits and reconnects instead of degrading.

**Reaching peers outside your own network** requires at least one reachable
bootstrap peer, since that is what floods the announcements addresses resolve
against. Peers on your own LAN are always found without one. To run your own:

```bash
node gmp-core/test/run-public-peer.js     # prints its NodeID on startup
```

Then add it to `gmp-core/data/public-peers.json`, or point
`GMP_PUBLIC_PEERS_PATH` at your own list.

No permanent server needed, and there is no signaling relay to deploy — the
`server/` tree that held one was removed along with the hybrid-signaling
fallback it served. Peers that cannot open a direct path are forwarded
through the mesh itself by other peers; nothing degrades to a
relay you have to run.

### WebRTC Data Channels (3 multiplexed)

|Channel   |ID|Mode             |Purpose                |
|----------|--|-----------------|-----------------------|
|`messages`|0 |Reliable, ordered|Chat messages          |
|`files`   |1 |Reliable, ordered|Encrypted file transfer|
|`presence`|2 |Unreliable       |Typing indicators      |

### NAT Traversal

- **STUN servers:** `stun.l.google.com:19302` (3 servers)
- **Fallback:** Signaling relay for symmetric NAT
- **Auto-reconnect:** Exponential backoff (1s → 30s)

-----

## Encrypted File Transfer

- 64 KB chunks with per-chunk AES-256-GCM encryption
- Unique IV per chunk
- SHA-256 hash verification (whole file)
- Flow control: 16-chunk ACK window
- Backpressure handling (buffer high/low water marks)
- Progress events (0–100%)

-----

## Voice / Video / Screen Sharing

|Mode  |Audio                                |Video                 |Method             |
|------|-------------------------------------|----------------------|-------------------|
|Voice |Echo cancellation + noise suppression|—                     |`getUserMedia()`   |
|Video |Echo cancellation + noise suppression|1280x720, front camera|`getUserMedia()`   |
|Screen|—                                    |Display surface       |`getDisplayMedia()`|

All media streams encrypted via SRTP (built into WebRTC).

-----

## Message Blockchain

Every message creates a SHA-256 linked block:

```
Block #N
├── index: N
├── sender: "Alice"
├── content: "Hello"
├── timestamp: 1711027200000
├── hash: sha256(N + sender + content + timestamp + prevHash)
├── prevHash: Block #(N-1).hash
├── nonce: N
└── encrypted: { iv: "...", ciphertext: "..." }
```

Chain explorer UI lets you verify integrity, view any block, and export the full chain as JSON.

-----

## Identity Recovery (3 Layers)

```
Layer 1: 12-word BIP39 seed phrase
    ↓ PBKDF2 (100K iterations)
Layer 2: Master key → Shamir split into 7 shares (threshold 3)
    ↓ Distribute to trusted peers
Layer 3: P2P recovery

┌────────────────────────────────────────────┐
│              BACKUP FLOW                    │
│                                             │
│  Identity + Chats + Files + Contacts        │
│              │                              │
│        AES-256-GCM encrypt                  │
│        with master key                      │
│              │                              │
│        Shamir Split (7,3)                   │
│    ┌──┬──┬──┼──┬──┬──┐                     │
│    F1 F2 F3 F4 F5 F6 F7                    │
│    │  │  │  │  │  │  │                      │
│   Copy-paste to 7 trusted peers             │
│                                             │
│         RESTORE FLOW                        │
│                                             │
│  New device → Enter 12 words                │
│              │                              │
│        PBKDF2 → Master key                  │
│              │                              │
│  Paste 3+ fragments from peers              │
│              │                              │
│        Shamir Combine                       │
│              │                              │
│        AES-GCM decrypt                      │
│              │                              │
│  Full restore: keys, chats, files,          │
│  contacts, settings, blockchain             │
└────────────────────────────────────────────┘
```

-----

## Offline Support

- IndexedDB queue stores messages when offline
- 24-hour TTL with auto-cleanup
- Auto-sync when peer reconnects
- Relay via trusted third peer

-----

## Security Model

### What GhostLink protects against

|Threat               |Protection                                          |
|---------------------|----------------------------------------------------|
|Server breach        |No server exists to breach                          |
|Man-in-the-middle    |ECDH key exchange + message authentication          |
|Message tampering    |SHA-256 blockchain chain verification               |
|Key compromise       |Forward secrecy via Double Ratchet                  |
|Data theft (device)  |AES-256-GCM encryption at rest with key wrapping    |
|Backup compromise    |Shamir’s Secret Sharing — single fragment is useless|
|Identity theft       |BIP39 seed phrase derives all keys deterministically|
|Data destruction     |2-step secure Account Deletion (wipes hardware storage)|
|Metadata surveillance|P2P direct — no central logs, no connection records |
|Replay attacks       |Unique IV per message + blockchain ordering         |

### What GhostLink does NOT protect against

- Compromised device (keylogger, screen capture malware)
- Peer collusion (3+ peers colluding could reconstruct your backup)
- Seed phrase theft (if someone gets your 12 words, they own your identity)
- Endpoint visibility (messages are readable once decrypted on-screen)
- Rubber-hose cryptanalysis (physical coercion)

### Cryptographic Primitives

|Function            |Algorithm            |Parameters                    |
|--------------------|---------------------|------------------------------|
|Key agreement       |ECDH                 |P-256 (secp256r1)             |
|Symmetric encryption|AES-GCM              |256-bit key, 96-bit IV        |
|Key derivation      |PBKDF2               |SHA-256, 100K iterations      |
|Forward secrecy     |X3DH + Double Ratchet|Signal Protocol               |
|Message integrity   |SHA-256              |Chained hashes (blockchain)   |
|Backup splitting    |Shamir SSS           |GF(256), 7 shares, threshold 3|
|Identity seed       |BIP39                |128-bit entropy, 12 words     |
|Signing             |ECDSA                |P-256                         |
|File chunks         |AES-GCM              |64KB per chunk, unique IV     |

-----

## Quick Start

### Web (recommended for testing)

The app is live at: **https://kilikpola.github.io/Ghostlink/**

Or run locally:

```bash
git clone https://github.com/kilikpola/Ghostlink.git
cd Ghostlink
python3 -m http.server 8000
# visit http://localhost:8000
```

### Desktop (Electron)

```bash
npm ci                                   # at the repo root (workspaces)
npm run install:gmp && npm run build:gmp # the desktop app loads gmp-core/dist
cd electron
npm start
# Starts the Ghost Mesh node (port 49500) and its local bridge (127.0.0.1:3002)
```

### Mobile (React Native)

```bash
cd mobile
npm install

# Android
npx react-native run-android

# iOS
cd ios && pod install && cd ..
npx react-native run-ios
```

### VPS Deployment

```bash
# Clone on server
git clone https://github.com/kilikpola/Ghostlink.git

# Web app via Nginx (the page needs its bundle and vendor files alongside it)
sudo mkdir -p /var/www/html/ghostlink
sudo cp -r Ghostlink/index.html Ghostlink/app.bundle.js Ghostlink/vendor Ghostlink/src Ghostlink/shared /var/www/html/ghostlink/

# Nginx config
server {
    listen 443 ssl;
    server_name ghostlink.yourdomain.com;
    root /var/www/html/ghostlink;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/ghostlink.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ghostlink.yourdomain.com/privkey.pem;

}
```

> **Note:** Web Crypto API requires HTTPS in production. `localhost` works for testing.

-----

## Project Structure

```
Ghostlink/
├── index.html              # Web app UI (inline React + htm)
├── index-entry.js          # esbuild entry → app.bundle.js
├── src/                    # Browser modules bundled into app.bundle.js
│   ├── core/               # event bus, logger
│   ├── license/            # licensing, feature gates, workspaces
│   ├── markdown/           # parser + sanitizer
│   ├── notifications/      # in-app alerts, sounds
│   ├── p2p/                # encrypted file transfer
│   └── utils/              # BIP-39, QR invites, capability flags
├── shared/wordlist.js      # BIP-39 wordlist shared by web and mobile
├── gmp-core/               # Ghost Mesh Protocol node + local bridge (TypeScript)
│
├── electron/               # Desktop app
│   ├── package.json
│   └── src/
│       ├── main.js         # Window management, IPC, GMP node, deep links, CSP
│       ├── preload.js      # Secure contextBridge (window.ghostlink)
│       ├── titlebar.js     # Custom frameless title bar
│       ├── tray.js         # System tray
│       └── updater.js      # Auto-update
│
├── mobile/                 # React Native app
│   ├── App.js
│   └── src/
│       ├── screens/        # Setup, RestoreIdentity, ChatList, Chat, Call,
│       │                   # Settings, Recovery, QRScanner
│       ├── services/       # CryptoService, WebRTCService,
│       │                   # RecoveryTransport, MobileDistributor
│       ├── components/     # PeerAvatar, ScaledText, GhostMeshSetupModal
│       ├── context/        # AppContext, ThemeContext
│       └── utils/
│
└── test/                   # Root test suite (npm test)
```

-----


## License

GPL-3.0 — see <LICENSE> for details.

-----

<p align="center">
  <strong>👻 GhostLink</strong><br>
  <em>Your conversations. Your keys. Your rules.</em><br><br>
  Built by <a href="https://github.com/kilikpola">kilikpola</a>
</p>