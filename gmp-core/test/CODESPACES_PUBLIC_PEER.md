# Testing Cross-Network NAT Traversal with GitHub Codespaces

Because real-network NAT hole punching requires a public rendezvous peer, testing is often bottlenecked by access to a public VPS. This guide outlines how to use **GitHub Codespaces** as a free, temporary Public Peer to verify Carrier-Grade NAT (CGNAT) and cellular traversal.

---

## Step 1: Spin up a Codespace

1. Go to your repository on GitHub: `https://github.com/kilikpola/Ghostlink`.
2. Click the green **Code** button.
3. Select the **Codespaces** tab, then click **Create codespace on main**.

---

## Step 2: Start the Public Peer Daemon

Once the Codespace environment loads:
1. In the terminal panel, navigate to the `gmp-core` directory:
   ```bash
   cd gmp-core
   npm install
   ```
2. Run the node as a public peer:
   ```bash
   node cli.js public-peer --port 49500
   ```

---

## Step 3: Configure Port Forwarding

1. In the Codespace bottom panel, click on the **Ports** tab (next to Terminal/Output).
2. Click **Forward a Port** and enter `49500`.
3. Right-click the forwarded port `49500` in the list:
   - Select **Port Visibility** → Change to **Public**.
4. Copy the **Forwarded Address** (it will look like `https://uuid-49500.app.github.dev`).

---

## Step 4: Map HTTPS/WSS Tunnel to TCP

Codespaces forwards traffic over an HTTPS/WSS proxy. Because of this, standard raw TCP connects to port `49500` will fail. We map this tunnel back to TCP using TLS wrapping:

1. **Host**: `<uuid>-49500.app.github.dev` (from the forwarded URL).
2. **Port**: `443` (HTTPS default).
3. **Configuration**: Set `"tls": true` or use port `443` in your `public-peers.json`. The GMP node will wrap the connection in TLS/HTTPS proxy format automatically.

Add the peer to `gmp-core/data/public-peers.json` on your local machine:

```json
[
  {
    "address": "uuid-49500.app.github.dev",
    "port": 443,
    "tls": true,
    "nodeId": "your-codespace-peer-node-id"
  }
]
```

---

## Step 5: Run the Cellular NAT Test

1. Connect a test mobile phone to cellular data.
2. Enable mobile hotspot on the phone.
3. Connect your test laptop to the phone's hotspot.
4. On the laptop, run:
   ```bash
   node test/run-manual-nat-test.js
   ```
5. Confirm hole punching succeeds and paste results into `PHASE2B_REPORT.md` inside the "Manual Test Results" section.
