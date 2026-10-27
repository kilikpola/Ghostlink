# Ghost Mesh Mode — Yggdrasil Integration

Ghost Mesh is an advanced, decentralized transport layer for GhostLink built directly on top of the **Yggdrasil** network. It provides direct, metadata-minimizing P2P transport.

---

## 🌐 The Philosophy & Cryptographic Fit

In standard mode, GhostLink uses public signaling servers to perform WebRTC handshakes and coordinate peer connections. 

**Ghost Mesh Mode eliminates signaling servers completely.** 

Yggdrasil is a decentralized IPv6 overlay network where IPv6 addresses are cryptographically derived from the node's Curve25519 (X25519) public key. This perfectly matches GhostLink's identity model (where your profile fingerprint is derived from your BIP39 master seed phrase). 

By generating your Yggdrasil Node identity directly from your GhostLink recovery phrase, **your network address becomes your cryptographic identity.**

---

## 🛠️ Step-by-Step Setup Guide

To use Ghost Mesh Mode, you need to run a local Yggdrasil daemon on your system and configure it to use keys derived from your GhostLink master recovery phrase.

### Step 1: Install Yggdrasil
Download and install the Yggdrasil daemon for your platform from the official repository:
- **Linux/macOS/Windows:** [Yggdrasil Installation Guides](https://yggdrasil-network.github.io/installation.html)

Ensure the daemon is running locally and you can access the CLI tools:
```bash
yggdrasilctl getSelf
```

### Step 2: Run the Setup Modal
1. Open GhostLink **Settings** (⚙️).
2. Find the **Ghost Mesh (Advanced)** section.
3. Click **Configure** to open the Setup Modal.
4. Paste your **12-word recovery phrase** and your local **Yggdrasil IPv6 address** (obtained from the `getSelf` command).
5. Click **Verify & Continue**. GhostLink will verify that the address AND public key derived from the seed match your pasted IP and public key.
6. **Important:** After derivation, GhostLink will display the computed public key hex. Run `yggdrasilctl getSelf` on your configured test node and compare the full public key hex — not just the address — to confirm a match. This guards against hash collision edge cases.

### Step 3: Update Local Yggdrasil Configuration
Once verified, GhostLink will display the derived configuration parameters. You must copy these into your local Yggdrasil config file (usually `/etc/yggdrasil.conf` on Linux/macOS, or via the Yggdrasil system tray UI on Windows):

1. Find the configuration block for `NodePriv` and `NodePub`:
   ```json
   {
     "NodePriv": "YOUR_DERIVED_NODE_PRIV_HEX",
     "NodePub": "YOUR_DERIVED_NODE_PUB_HEX"
   }
   ```
2. Replace them with the hex strings copied from the GhostLink Setup Modal.
3. **Restart the Yggdrasil daemon** to apply changes:
   ```bash
   # Systemd Linux example
   sudo systemctl restart yggdrasil
   ```

---

## ⚠️ Important Warnings & Advisories

> [!WARNING]
> **Yggdrasil Alpha Status:**
> Yggdrasil is early-stage, experimental routing software. While the cryptography used is standard (Curve25519/X25519, SHA-512), the routing protocol is subject to protocol-level updates and bugs. Do not rely solely on Ghost Mesh for critical high-availability systems.

> [!IMPORTANT]
> **Host Firewall Rules:**
> Direct TCP dialing in Electron runs over port `49500` (both listening and connecting). Make sure your local and network firewall configurations permit incoming and outgoing IPv6 traffic on port `49500` over the `yggdrasil` interface.

---

## ⚙️ Technical Specifications

### Electron Desktop App vs Web App
Due to browser sandbox restrictions, direct raw TCP sockets cannot be opened or accepted from standard web pages:

| Feature | Electron Desktop App | Web App (Browsers) |
| :--- | :--- | :--- |
| **TCP Bridge Listener** | ✅ Yes (`[::]:49500`) | ❌ No (blocked by sandbox) |
| **Direct Socket Dialing** | ✅ Yes | ❌ No |
| **WebRTC over Yggdrasil** | ✅ Yes (as fallback) | ✅ Yes (uses WebRTC ICE candidates) |
| **Signaling-Free Handshake** | ✅ Yes (Direct TCP) | ❌ No (requires standard QR/paste) |

### Cryptographic Derivation Flow
1. **Mnemonic to Seed:**
   PBKDF2 is run against the 12 words with salt `"ghostlink-yggdrasil-v1"` for 100,000 iterations to derive a 32-byte seed.
2. **Seed to X25519 (Curve25519) Keypair:**
   The 32-byte seed is used as a raw Curve25519 private key. A pure-JS X25519 implementation computes the corresponding 32-byte public key by scalar multiplication of the base point. (Note: Web Crypto API's X25519 support is used when available, with a pure-JS fallback for browsers/platforms with incomplete X25519 JWK export support.)
3. **Keypair to Yggdrasil IP Address:**
   Yggdrasil IPv6 addresses occupy the `0200::/7` range. The second byte is the number of leading 1-bits in the SHA-512 hash of the X25519 public key. The remaining bits are shifted to skip the sequence of leading 1s and the first following 0 bit.
4. **Verification:**
   After deriving the keypair, run `yggdrasilctl getSelf` on a test node configured with the derived `NodePriv`. Compare both the **address** AND the **public key hex** against what GhostLink computed — address collisions are theoretically possible with truncated hashes, so comparing the full public key is a stronger verification.
