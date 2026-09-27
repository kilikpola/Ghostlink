# Production Deployment Guide — Ghost Mesh Protocol (GMP)

This guide provides step-by-step instructions for deploying and running a persistent, production-ready Ghost Mesh Protocol node on a VPS or cloud instance. It is specifically designed for lightweight, low-resource environments (such as free-tier servers or Termux via SSH) and does not require complex infrastructure or root privileges.

---

## 1. Minimum System Requirements

- **Node.js**: Version 18.0.0 or higher.
- **Memory**: 512MB RAM (extremely lightweight; fits easily on free-tier micro VMs).
- **OS**: Any standard Linux distribution (Ubuntu, Debian, Alpine) or Android running Termux.

---

## 2. Setup from Scratch

Run the following commands to clone the repository, install dependencies, configure, and start the node:

```bash
# Clone the repository
git clone https://github.com/kilikpola/Ghostlink
cd Ghostlink/gmp-core

# Install dependencies
npm install

# Copy the configuration template to create your config
mkdir -p data
cp data/config.example.json data/config.json

# Edit config.json to customize settings (e.g. ports, logs)
nano data/config.json

# Start the node (you will be prompted securely for your 12-word seed phrase)
node cli.js start
```

---

## 3. Running Persistently

If you are running on a VPS without systemd access, or want quick persistence, use one of the following three options (ordered by simplicity):

### Option A: tmux (Recommended & Simplest)
Works out of the box on almost any Linux server without additional packages.

```bash
# Start a new tmux session named 'ghostlink'
tmux new -s ghostlink

# Start the node
node cli.js start

# Detach from the session (leaves the node running in the background)
# Press Ctrl+B, then D
```
To reconnect later and view output: `tmux attach -t ghostlink`

### Option B: nohup
Simple redirect that runs the process in the background.

```bash
# Run in the background and pipe output to a log file
nohup node cli.js start > data/logs/startup.log 2>&1 &
```

### Option C: PM2 (Process Manager)
Best for production environments requiring auto-restarts on crash or system boot.

```bash
# Install PM2 globally
npm install -g pm2

# Start the node CLI with 'start' arguments
pm2 start cli.js --name ghostlink -- start

# Save state and configure PM2 to run on startup
pm2 startup
pm2 save
```

---

## 4. Running as a Public Peer

If you want your node to act as a public rendezvous point/relay for other mesh nodes, configure it to run in Public Peer mode:

```bash
# Start the node as a public peer (sets isPublicPeer: true and enables public bindings)
node cli.js public-peer
```

### 4.1 Non-interactive deployment (Railway, Docker, systemd)

For cloud platforms without an interactive terminal, set the GMP_SEED_PHRASE environment variable before starting the node:

```bash
GMP_SEED_PHRASE="word1 word2 word3 ... word12" gmp public-peer
```

Or in Railway: add GMP_SEED_PHRASE as an environment variable in the service's Variables tab.

> [!IMPORTANT]
> **SECURITY NOTE**: this seed phrase becomes this Public Peer's permanent identity. Generate a NEW, DEDICATED seed phrase for this Public Peer — do NOT reuse your personal GhostLink identity seed phrase for a Public Peer running on third-party cloud infrastructure.

Add a small script or CLI command to generate a fresh random BIP39 seed phrase for this exact purpose:

```bash
gmp generate-seed
```
→ outputs a new random 12-word phrase, nothing else
→ does not save it anywhere, purely prints it once
→ user is responsible for saving it securely

#### 4.1.1 Railway Deployment & Reverse Proxy Setup

> [!IMPORTANT]
> **IMPORTANT ARCHITECTURAL NOTE**: GMP is a raw TCP protocol, not HTTP. Railway's automatic HTTPS domain generation is designed for HTTP(S) web services, not raw TCP servers. For a raw TCP service like GMP, we need Railway's **TCP Proxy** feature instead of the standard HTTP domain. Standard HTTPS/HTTP requests sent to the GMP TCP port (like Railway's default health check) will be intercepted by the node and reply with an HTTP `200 OK` health status, but full protocol communication must go through a raw TCP connection.

To set up your GMP Public Peer on Railway:

1. **Variables**: Set the `GMP_SEED_PHRASE` and ensure your service starts with `gmp public-peer`. Railway automatically sets a `PORT` environment variable which the GMP CLI detects and uses as its internal listening port.
2. **Enable TCP Proxy**:
   - In your Railway dashboard, navigate to your service's **Settings** tab.
   - Go to the **Networking** section.
   - Click on **TCP Proxy** (available under Railway's $5 Free Trial and paid developer/hobby plans).
   - Enter your GMP internal port (matched dynamically to the `PORT` env var).
   - Railway will assign a public domain and a random public port (e.g. `shuttle.proxy.rlwy.net:15140`).
3. **Public Peer Entry**: Once Railway assigns the TCP proxy, add it to your `public_peers.json` file in the following format:
   ```json
   {
     "address": "shuttle.proxy.rlwy.net",
     "port": 15140
   }
   ```
4. **Verifying Connectivity**:
   - Standard HTTP/HTTPS `curl` requests or browser checks against the TCP proxy will receive a JSON health check: `{"status":"healthy"}`.
   - For a real TCP connection test, use netcat:
     ```bash
     nc -zv shuttle.proxy.rlwy.net 15140
     ```
     Or execute a client test script to handshake.

*Note: If Railway's TCP Proxy is not available or you are on a restricted free plan that does not support raw TCP routing, you should host your node on Render.com or another VPS provider that allows raw TCP port exposure.*

---

## 5. State File Authentication (`GMP_STRICT_STATE`)

A node keeps two encrypted state files between restarts: the **nonce store**, which
records the highest message counter seen from each peer, and the **peer cache**, which
remembers who it has successfully talked to. Both are sealed with AES-GCM under a key
derived from the node's seed phrase, so a file that has been edited, truncated, or
copied from a different identity will fail authentication when the node loads it.

`GMP_STRICT_STATE` decides what happens next.

| | Default (`GMP_STRICT_STATE` unset or `false`) | Strict (`GMP_STRICT_STATE=true`) |
|---|---|---|
| **Nonce store fails to authenticate** | Logs at `ERROR`, discards the file, starts with empty replay protection | Refuses to start |
| **Peer cache fails to authenticate** | Logs at `ERROR`, discards the file, re-bootstraps from the public peer list | Refuses to start |

```bash
# Environment variable — only the exact strings "true" or "1" enable it.
GMP_STRICT_STATE=true gmp public-peer
```

```json
// …or in config.json
{ "strictState": true }
```

### Which should I use?

**The tradeoff is availability against a silent loss of replay protection.** Discarding an
unauthenticated nonce store is not the same as starting with no file at all: it throws away
every high-water mark the node had recorded, so a peer that saved old traffic can reconnect
and replay nonces this node has already accepted. Under AES-GCM, a reused key/counter pair
leaks the XOR of the two plaintexts — precisely what the nonce store exists to prevent. The
loss is invisible from the outside; nothing downstream can tell afterwards that the node came
up unprotected, and the only trace is one `ERROR` line in the log at startup. Refusing to
start converts that silent, indefinite exposure into a loud, immediate outage — which is the
right trade when a human is watching the logs and a restart is cheap, and the wrong one when
the node *is* the product and a corrupt file on a user's laptop would lock them out of their
own client with an error they cannot act on.

So:

- **On for public peers and unattended nodes.** They are long-lived, reachable by anyone, and
  carry other people's traffic, so they are the nodes actually worth replaying against. An
  operator is already watching them, a failed start is visible immediately, and the recovery
  is one deliberate command (move the file aside, restart). Take the outage.
- **Off for end-user clients.** A corrupt state file on a desktop or mobile client is far more
  likely to be a half-written file from a crash or a battery-dead phone than an attack, and a
  client that refuses to launch is a client the user cannot fix. The `ERROR` line is there for
  support to find, and the exposure window is bounded by how long that client stays online.

If you are unsure and the node is exposed to the internet, turn it on. Strict mode is also the
only mode that preserves the evidence: on the default path the node discards the rejected
state in memory and then writes fresh state over the same file — the peer cache on the very
next prune, the nonce store on the next counter update — so by the time anyone reads the
`ERROR` line, the file that failed authentication is already gone. Strict mode refuses before
writing anything, leaving it on disk to inspect.

Both files live under the node's data directory — `<gmp-core>/data/nonce-state.json` and
`<gmp-core>/data/peer-cache.json`, or wherever `GMP_DATA_DIR` points. The refusal message
names the exact path it could not authenticate:

```bash
# Inspect it first if you care why it failed, then move it aside and restart.
mv gmp-core/data/nonce-state.json gmp-core/data/nonce-state.json.bad
```

---

## 6. Monitoring & Observability

Operators can monitor the health and performance of their running node using the local metrics endpoints:

### Human-Readable Status
```bash
# Print a styled CLI status box
node cli.js status
```

### Connected Peers
```bash
# List active peer connections with partial metadata protections
node cli.js peers
```

### Raw Metrics (Prometheus Compatible)
```bash
# Query the local HTTP metrics endpoint
curl http://localhost:9090/metrics | jq
```

### Logs
```bash
# Tail the daily rotating JSON logs
tail -f data/logs/gmp-$(date +%Y-%m-%d).log
```

---

## 7. Firewall Setup

For external peers to connect to your node, you must open the incoming GMP listening port. Keep the metrics endpoint bound to localhost only.

```bash
# Allow incoming connection port (default 49500)
sudo ufw allow 49500/tcp

# CRITICAL SECURITY NOTE:
# Never expose the metrics port (default 9090) or the bridge port (default 3002) to the public internet.
# Keep them bound to localhost/127.0.0.1 only.
# Do NOT run: ufw allow 9090/tcp
```

---

## 8. Free-Tier VPS Options (No Credit Card Required)

If you do not have a physical credit card to register on standard cloud providers (like AWS, GCP, or DigitalOcean), the following platforms provide free tiers using simple GitHub OAuth authentication:

- **GitHub Codespaces**: Provides up to 60 hours per month of free container runtime. Highly reliable for transient test nodes and development.
- **Render.com**: Offers a free web service tier. Note that Render web services sleep after 15 minutes of inactivity; therefore, it is not recommended for always-on public peers.
- **Railway.app**: Provides a free trial tier with simple GitHub login. Excellent for lightweight hosting.

*For reliable, persistent Public Peer routing, a paid $5/month VM (such as Hetzner or OVH) or an always-on free tier is recommended.*
