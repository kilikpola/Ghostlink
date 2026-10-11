# Ghost Mesh — Cryptographic Verification Test Plan

This document defines the verification procedure to confirm that GhostLink's Ghost Mesh X25519 key derivation produces results that match what a real Yggdrasil node computes internally.

---

## Cryptographic Stack Summary

| Component | Algorithm | Notes |
| :--- | :--- | :--- |
| **Seed derivation** | PBKDF2-SHA256, 100K iterations | Salt: `ghostlink-yggdrasil-v1` |
| **Keypair** | X25519 (Curve25519) | Private key = 32-byte PBKDF2 output; Public key = scalar multiplication against base point 9 |
| **NodeID** | SHA-512(X25519 public key) | Yggdrasil's standard identity hash |
| **IPv6 Address** | `0200::/7` prefix + leading-ones encoding of SHA-512 hash | Matches Yggdrasil's `address.go` derivation |

> [!IMPORTANT]
> Previous versions of this codebase incorrectly used Ed25519 (Edwards curve, OID 1.3.101.112) for the Yggdrasil keypair. Yggdrasil defines `NodeID = SHA-512(Curve25519_public_key)` — it uses X25519 (Montgomery form, OID 1.3.101.110), which produces different public key bytes. The fix was applied across all code, documentation, and UI strings.

---

## Verification Procedure

### Prerequisites
- A working Yggdrasil installation (`yggdrasil` daemon + `yggdrasilctl` CLI)
- A browser with the GhostLink app loaded
- (Optional) Node.js for scripting verification

### Step 1: Choose a Test Seed Phrase

Use any valid 12-word BIP39 mnemonic. Example test seed: the BIP-39 all-zero-entropy
test vector — the word `abandon` eleven times, then `about`. (Written out here as
prose on purpose: no file in this repository holds a phrase-shaped string, so
the seed-leak test needs no exceptions.)

> [!WARNING]
> This is a well-known test vector. **Never** use this seed phrase for real identity or funds.

### Step 2: Derive Keys in GhostLink

1. Open GhostLink → Settings → Ghost Mesh (Advanced) → Configure
2. Enter the test seed phrase
3. Enter a placeholder address (e.g. `200::1`) — or leave it to be corrected after
4. Observe the derived values:
   - **X25519 Public Key (hex)**: Record this value
   - **X25519 Private Key (hex)**: Record this value  
   - **Computed Yggdrasil IPv6 Address**: Record this value

### Step 3: Configure a Local Yggdrasil Test Node

1. Generate a default config if you don't have one:
   ```bash
   yggdrasil -genconf > /tmp/ygg-test.conf
   ```

2. Edit `/tmp/ygg-test.conf` and replace the `PrivateKey` field with the derived private key hex (64 hex chars = privkey + pubkey concatenated, which is what GhostLink outputs as NodePrivHex):
   ```json
   {
     "PrivateKey": "<PRIVATE_KEY_HEX><PUBLIC_KEY_HEX>"
   }
   ```

3. Start a test Yggdrasil instance:
   ```bash
   sudo yggdrasil -useconffile /tmp/ygg-test.conf
   ```

### Step 4: Compare Results

Run `yggdrasilctl getSelf` and compare:

```bash
yggdrasilctl getSelf
```

Expected output format:
```
{
  "address": "2XX:XXXX:...",
  "key": "<public_key_hex>",
  ...
}
```

| Field | GhostLink Output | Yggdrasil Output | Must Match? |
| :--- | :--- | :--- | :--- |
| **Public Key (hex)** | From derivation step | `key` field from `getSelf` | ✅ **YES — exact match required** |
| **IPv6 Address** | From derivation step | `address` field from `getSelf` | ✅ **YES — exact match required** |

> [!CAUTION]
> If the addresses match but the public keys do NOT, this indicates a hash collision — an extremely unlikely but theoretically possible scenario. In this case, the derivation is **NOT** verified. Both values must match exactly.

### Step 5: Document Results

Record the test output below (fill in after running the test):

```
Test Seed:     [your test seed phrase]
Derived PubKey: [hex from GhostLink]
Derived Address: [IPv6 from GhostLink]
Yggdrasil PubKey: [hex from yggdrasilctl getSelf]
Yggdrasil Address: [IPv6 from yggdrasilctl getSelf]
Match: [YES/NO]
Date Tested: [YYYY-MM-DD]
Yggdrasil Version: [output of yggdrasil -version]
Browser: [browser name and version]
```

---

## Implementation Details

### Primary X25519 Path (tweetnacl / nacl-fast.min.js)

GhostLink uses `nacl.box.keyPair.fromSecretKey(seed)` from the tweetnacl library (loaded as `nacl-fast.min.js`, which exports as `window.nacl`). This function performs the standard X25519 scalar-basepoint multiplication to derive the Curve25519 public key from the 32-byte private key seed.

### Fallback Path (Web Crypto API)

If tweetnacl is unavailable, GhostLink falls back to the Web Crypto API:

1. Wraps the 32-byte seed in a PKCS#8 envelope with the X25519 OID header:
   ```
   302e020100300506032b656e04220420 (OID 1.3.101.110 = X25519)
   ```
2. Imports via `crypto.subtle.importKey("pkcs8", ..., { name: "X25519" }, true, ["deriveBits"])`
3. Exports as JWK to extract the `x` field (base64url-encoded public key)

> [!NOTE]
> Web Crypto X25519 support was added in Chrome 133+ and may not be available in all browsers. The tweetnacl path is the primary and most widely compatible method.

### PKCS#8 OID Reference

| Algorithm | OID | PKCS#8 Header (hex) |
| :--- | :--- | :--- |
| ~~Ed25519~~ (WRONG — do not use for Yggdrasil) | 1.3.101.112 | `302e020100300506032b657004220420` |
| **X25519** (CORRECT for Yggdrasil) | 1.3.101.110 | `302e020100300506032b656e04220420` |

---

## Status

- [x] Code updated: `tweetnacl` → `nacl` global reference fixed
- [x] Code updated: Web Crypto fallback uses proper JWK export instead of broken dummy-DH approach
- [x] Code updated: PKCS#8 header uses X25519 OID (1.3.101.110)
- [x] Documentation updated: GHOST_MESH.md references X25519/Curve25519 throughout
- [x] UI updated: Setup modal verifies both address AND public key
- [x] UI updated: Post-setup verification instructions added
- [ ] **Live test against real Yggdrasil node**: Must be performed manually by the developer/maintainer (fill in Step 5 above)
