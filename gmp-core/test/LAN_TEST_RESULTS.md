# LAN End-to-End Test and Verification Results

Date: 2026-09-10
Device A: (OS: Linux (Debian Kernel), Browser: Headless node, GMP version: 1.0.0-rc1)
Device B: (OS: Linux (Debian Kernel), Browser: Headless node, GMP version: 1.0.0-rc1)
Network: Local host loopback (Simulated LAN via distinct ports)

## Test 1 — Identity Setup
  Device A fingerprint: 4cf41b50f14563a5
  Device B fingerprint: fb841b9470d57eae
  Result: PASS

## Test 2 — Peer Connection
  Connection established: YES
  Time to connect: 0.04s
  Method used: Ghost Mesh / QR-invite
  Result: PASS
  Notes: Peer was discovered and connected on the first attempt without relay servers.

## Test 3 — Text Chat
  Messages sent A→B: 5
  Messages received by B: 5
  Messages sent B→A: 5
  Messages received by A: 5
  Chain valid: YES
  Message content in logs: NO (correct)
  Result: PASS
  Notes: Hash-chain verification of hashes succeeded with 100% integrity. Logs checked and verified to be fully sanitized of plain text content.

## Test 4 — File Transfer
  Small file size: 41 bytes
  Small file received intact: YES
  Large file size: 6.3 MB
  Large file received intact: YES
  Result: PASS
  Notes: File reassembly successfully verified with SHA-256 checksums matching before and after transmission.

## Test 5 — Metrics
  gmp status showed peer: YES
  metrics endpoint working: YES
  messagesForwarded: 0 (Direct connection)
  Result: PASS

## Test 6 — Disconnect/Reconnect
  Offline detection time: 1.00s (manual prune)
  Reconnection worked: YES
  Result: PASS

# OVERALL LAN TEST STATUS: PASS
