/**
 * P2PConnector — Real WebRTC + WebSocket signaling for GhostLink.
 * - WebSocket connection to signaling server (with auto-discovery)
 * - Hybrid invite: manual signal (QR/paste) + relay fallback
 * - 3 data channels per peer: messages (reliable), files (reliable), presence (unreliable)
 * - Fully encrypted messaging via CryptoEngine
 */
(function(exports) {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const _base64Encode = (str) => {
    try {
      return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        (_, p1) => String.fromCharCode(parseInt(p1, 16))));
    } catch (e) { return btoa(str); }
  };

  const _base64Decode = (str) => {
    try {
      return decodeURIComponent(Array.from(atob(str)).map(c =>
        '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    } catch (e) { return atob(str); }
  };

  // ─── Simple EventEmitter ─────────────────────────────────────────────────

  class EventEmitter {
    constructor() { this._events = {}; }
    on(event, fn) { (this._events[event] = this._events[event] || []).push(fn); return this; }
    off(event, fn) {
      if (!this._events[event]) return this;
      this._events[event] = this._events[event].filter(f => f !== fn);
      return this;
    }
    emit(event, ...args) {
      if (!this._events[event]) return;
      this._events[event].forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
    }
    removeAllListeners(event) {
      if (event === undefined) this._events = {};
      else delete this._events[event];
      return this;
    }
  }

  // ─── P2PConnector ────────────────────────────────────────────────────────

  class P2PConnector extends EventEmitter {
    constructor(identity, options = {}) {
      super();
      this.identity = identity;
      this.options = options;

      // WebSocket
      this.ws = null;
      this.wsOpen = false;
      this.wsUrl = null;
      this.reconnectTimer = null;
      this.wsPingInterval = null;
      // Set by destroy(). The socket's onclose fires after close() returns, so
      // without this flag a torn-down connector reconnects ~3s later.
      this._destroyed = false;

      // WebRTC: peerId -> RTCPeerConnection
      this.pcs = {};
      // peerId -> { messages, files, presence }
      this.dcs = {};
      // peerId -> connection state string
      this.states = {};
      // peerId -> { name, publicKeyHex, lastSeen }
      this.knownPeers = {};

      // ICE servers
      this.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ];

      // Active room
      this.roomId = null;

      // Pending ICE candidates (before remote description is set)
      this.pendingIce = {};

      // Options
      this.trickleIce = true;

      // Peers we have already announced as connected. A peer opens three data
      // channels and may also connect over ICE/mesh, so the raw events fire
      // several times per peer; listeners must see exactly one connect and one
      // disconnect.
      this._announced = new Set();

      // Ghost Mesh (Yggdrasil TCP client/server)
      this.meshConns = {}; // peerId -> { connId, sharedKey, name, publicKey }
      this._meshListeners = [];
      this._initGhostMesh();
    }

    // ─── Signaling discovery & connect ─────────────────────────────────────

    async discoverSignalingUrl() {
      let saved = localStorage.getItem('gl_signal_url');
      const candidates = [];
      if (saved) candidates.push(saved);
      if (typeof GHOSTLINK_SIGNAL_URL !== 'undefined') candidates.push(GHOSTLINK_SIGNAL_URL);
      const { protocol, hostname } = window.location;
      if (hostname) {
        // Match page security: https pages can only reach a wss:// relay
        // (ws:// to a LAN IP is blocked by the browser as mixed content).
        const scheme = protocol === 'https:' ? 'wss://' : 'ws://';
        const port = window.location.port || 3001;
        candidates.push(`${scheme}${hostname}:${port}`);
        candidates.push(`${scheme}${hostname}:3001`);
      }
      candidates.push('ws://localhost:3001');

      for (const url of candidates) {
        try {
          const httpUrl = url.replace('ws://', 'http://').replace('wss://', 'https://');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          const resp = await fetch(httpUrl + '/health', { signal: controller.signal });
          clearTimeout(timer);
          const data = await resp.json();
          if (data.status === 'ok') return url;
        } catch (e) { /* continue */ }
      }
      return candidates[candidates.length - 1];
    }

    async connect() {
      if (this._destroyed || this.ws) return;
      this.wsUrl = await this.discoverSignalingUrl();
      return this._connectWs();
    }

    _connectWs() {
      return new Promise((resolve, reject) => {
        try {
          this.ws = new WebSocket(this.wsUrl);
          this.ws.onopen = () => {
            this.wsOpen = true;
            this.emit('signaling-connected', this.wsUrl);
            this._send({ type: 'join', peerId: this.identity.fingerprint });
            this.wsPingInterval = setInterval(() => {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('__ping__');
            }, 30000);
            resolve();
          };
          this.ws.onmessage = (evt) => this._handleWsMessage(evt.data);
          this.ws.onclose = () => {
            this.wsOpen = false;
            this.emit('signaling-disconnected');
            if (this.wsPingInterval) { clearInterval(this.wsPingInterval); this.wsPingInterval = null; }
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            if (this._destroyed) return;
            this.reconnectTimer = setTimeout(() => {
              if (!this._destroyed && !this.wsOpen) this._connectWs().catch(()=>{});
            }, 3000);
          };
          this.ws.onerror = (err) => { this.emit('signaling-error', err); reject(err); };
        } catch (e) { reject(e); }
      });
    }

    _send(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    // ─── WebSocket message handling ─────────────────────────────────────────

    async _handleWsMessage(raw) {
      if (raw === '__pong__') return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'joined':
          this.emit('registered', msg.peerId);
          break;
        case 'peer-joined': {
          const peerId = msg.peerId;
          this.knownPeers[peerId] = { publicKey: msg.publicKey || '', name: msg.name || `Peer-${peerId.slice(0,6)}` };
          if (!this.pcs[peerId]) await this._createAndSendOffer(peerId, 'relay');
          this.emit('peer-joined', peerId, msg);
          break;
        }
        case 'peer-left': {
          this._cleanupPeer(msg.peerId);
          this._announceDisconnected(msg.peerId);
          this.emit('peer-left', msg.peerId);
          break;
        }
        case 'peer-list': {
          if (msg.peers) {
            for (const p of msg.peers) {
              if (p.peerId !== this.identity.fingerprint) {
                this.knownPeers[p.peerId] = { publicKey: p.publicKey || '' };
                if (!this.pcs[p.peerId]) await this._createAndSendOffer(p.peerId, 'relay');
              }
            }
          }
          break;
        }
        case 'offer':
          await this._handleSignalingOffer(msg);
          break;
        case 'answer':
          await this._handleSignalingAnswer(msg);
          break;
        case 'ice-candidate':
          await this._handleRemoteIce(msg);
          break;
        case 'relay':
          this.emit('relay-message', msg.from, msg.payload);
          break;
        case 'error':
          this.emit('signaling-error', msg.message);
          break;
      }
    }

    // ─── WebRTC: Create offer (relay path) ──────────────────────────────────

    _createDataChannels(peerId, pc) {
      const msgDc = pc.createDataChannel('messages', { ordered: true });
      this._setupDc(peerId, 'messages', msgDc);
      const filesDc = pc.createDataChannel('files', { ordered: true });
      this._setupDc(peerId, 'files', filesDc);
      const presDc = pc.createDataChannel('presence', { ordered: false, maxRetransmits: 0 });
      this._setupDc(peerId, 'presence', presDc);
    }

    async _createAndSendOffer(peerId, mode) {
      const pc = this._createPeerConnection(peerId, mode);
      this.pcs[peerId] = pc;
      this._createDataChannels(peerId, pc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIce(pc);
      this._send({
        type: 'offer', to: peerId, from: this.identity.fingerprint,
        sdp: pc.localDescription.sdp, publicKey: this.identity.publicKeyHex,
        name: this.identity.name
      });
    }

    _createPeerConnection(peerId, mode) {
      const runtime = window.GLLicenseRuntime;
      if (runtime && runtime.featureGate) {
        const isUnlimited = runtime.featureGate.canSync('unlimited_peers');
        if (!isUnlimited) {
          const currentActiveCount = Object.values(this.pcs).filter(p => p.signalingState !== 'closed').length;
          if (currentActiveCount >= 5) {
            runtime.featureGate.triggerUpgradeFlow('peers');
            throw new Error('Connection limit of 5 peers reached on Free tier.');
          }
        }
      }

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      pc.__mode = mode;
      pc.__peerId = peerId;
      pc.onicecandidate = (e) => {
        if (e.candidate) this._send({ type: 'ice-candidate', to: peerId, from: this.identity.fingerprint, candidate: e.candidate });
      };
      pc.oniceconnectionstatechange = () => {
        if (['disconnected','failed','closed'].includes(pc.iceConnectionState)) {
          // Tear the WebRTC path down first, then announce only if no other
          // transport (e.g. Ghost Mesh) is still carrying this peer.
          this._cleanupPeer(peerId);
          this._announceDisconnected(peerId);
        } else if (pc.iceConnectionState === 'connected') {
          // ICE connected but data channel may not be open yet — emit connected state
          this.states[peerId] = 'connected';
        }
      };
      pc.ondatachannel = (e) => { this._setupDc(peerId, e.channel.label, e.channel); };
      return pc;
    }

    _waitForIce(pc, timeout = 4000) {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const check = setInterval(() => {
          if (pc.iceGatheringState === 'complete') { clearInterval(check); clearTimeout(t); resolve(); }
        }, 100);
        const t = setTimeout(() => { clearInterval(check); resolve(); }, timeout);
      });
    }

    /**
     * True while at least one transport to this peer can still carry a message.
     * A peer commonly has three data channels and may also have a Ghost Mesh
     * session, so losing one of them is not losing the peer.
     */
    _isPeerLive(peerId) {
      if (this.meshConns[peerId]) return true;
      const dcs = this.dcs[peerId];
      return !!(dcs && Object.values(dcs).some((ch) => ch && ch.readyState === 'open'));
    }

    /** Emit peer-connected at most once per peer, until it disconnects. */
    _announceConnected(peerId, info) {
      this.states[peerId] = 'connected';
      if (this._announced.has(peerId)) return false;
      this._announced.add(peerId);
      this.emit('peer-connected', peerId, info);
      return true;
    }

    /**
     * Emit peer-disconnected once, and only once the peer is actually
     * unreachable. Pass force for a deliberate teardown (removePeer/disconnect),
     * where remaining transports are being closed on purpose.
     */
    _announceDisconnected(peerId, force = false) {
      if (!force && this._isPeerLive(peerId)) return false;
      if (!this._announced.delete(peerId)) return false;
      this.emit('peer-disconnected', peerId);
      return true;
    }

    _setupDc(peerId, label, ch) {
      if (!this.dcs[peerId]) this.dcs[peerId] = { messages: null, files: null, presence: null };
      this.dcs[peerId][label] = ch;
      ch.onopen = () => {
        this._announceConnected(peerId, { mode: this.pcs[peerId]?.__mode || 'P2P Direct' });
      };
      ch.onclose = () => {
        // Another channel (or a mesh session) may still be usable.
        if (this._isPeerLive(peerId)) return;
        this.states[peerId] = 'disconnected';
        this._announceDisconnected(peerId);
      };
      ch.onmessage = (evt) => {
        if (label === 'messages') this._onMessageChannel(peerId, evt.data);
        else if (label === 'files') {
          try {
            const parsed = JSON.parse(evt.data);
            this.emit('file-chunk', peerId, parsed);
          } catch (e) {
            this.emit('file-data', peerId, evt.data);
          }
        } else if (label === 'presence') {
          try {
            const parsed = JSON.parse(evt.data);
            if (parsed.type === 'typing') this.emit('message', peerId, parsed);
            else this.emit('presence-data', peerId, parsed);
          } catch (e) {
            this.emit('presence-data', peerId, evt.data);
          }
        }
      };
    }

    _onMessageChannel(peerId, data) {
      try {
        const msg = JSON.parse(data);
        this.emit('message', peerId, msg);
      } catch (e) { this.emit('raw-message', peerId, data); }
    }

    async _handleSignalingOffer(msg) {
      const peerId = msg.from;
      let pc = this.pcs[peerId];
      if (!pc) { pc = this._createPeerConnection(peerId, 'relay'); this.pcs[peerId] = pc; }

      // Perfect Negotiation: detect offer collision
      const polite = this.identity.fingerprint < peerId;
      const offerCollision = (pc.signalingState !== 'stable' || pc.remoteDescription);
      
      if (offerCollision) {
        if (!polite) {
          console.debug('[P2P] Glare detected (impolite), ignoring incoming offer from', peerId);
          return;
        }
        console.debug('[P2P] Glare detected (polite), rolling back local offer for', peerId);
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      this.knownPeers[peerId] = { publicKey: msg.publicKey || '', name: msg.name || `Peer-${peerId.slice(0,6)}` };
      if (this.pendingIce[peerId]) {
        for (const c of this.pendingIce[peerId]) { try { await pc.addIceCandidate(c); } catch (e) {} }
        delete this.pendingIce[peerId];
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._waitForIce(pc);
      this._send({
        type: 'answer', to: peerId, from: this.identity.fingerprint,
        sdp: pc.localDescription.sdp, publicKey: this.identity.publicKeyHex,
        name: this.identity.name
      });
      // Deliberately no peer-connected here: SDP is negotiated but ICE and the
      // data channel are not up yet, so isConnected()/sendOnChannel() would both
      // fail. _setupDc's onopen announces once the peer is actually usable.
    }

    async _handleSignalingAnswer(msg) {
      const peerId = msg.from;
      const pc = this.pcs[peerId];
      if (!pc) return;

      if (pc.signalingState === 'stable') {
        console.debug('[P2P] Already stable, ignoring answer from', peerId);
        return;
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      this.knownPeers[peerId] = { publicKey: msg.publicKey || '', name: msg.name || `Peer-${peerId.slice(0,6)}` };

      // Apply pending ICE candidates
      if (this.pendingIce[peerId]) {
        for (const c of this.pendingIce[peerId]) { try { await pc.addIceCandidate(c); } catch (e) {} }
        delete this.pendingIce[peerId];
      }
    }

    async _handleRemoteIce(msg) {
      const peerId = msg.from;
      const pc = this.pcs[peerId];
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(msg.candidate); } catch (e) {}
      } else {
        if (!this.pendingIce[peerId]) this.pendingIce[peerId] = [];
        this.pendingIce[peerId].push(msg.candidate);
      }
    }

    // ─── Manual Signaling (out-of-band) ─────────────────────────────────────

    async createManualOffer() {
      const id = 'manual-' + Math.random().toString(36).slice(2, 10);
      const pc = this._createPeerConnection(id, 'manual');
      this.pcs[id] = pc;
      this._createDataChannels(id, pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIce(pc);
      const bundle = {
        v: 2, s: pc.localDescription.sdp, t: pc.localDescription.type,
        p: this.identity.publicKeyHex, n: this.identity.name,
        f: this.identity.fingerprint, ts: Date.now()
      };
      return { offerBase64: _base64Encode(JSON.stringify(bundle)), pc, peerId: id };
    }

    async processManualOffer(offerBase64) {
      const bundle = JSON.parse(_base64Decode(offerBase64));
      const peerId = bundle.f || 'manual-peer';
      const pc = this._createPeerConnection(peerId, 'manual');
      this.pcs[peerId] = pc;
      await pc.setRemoteDescription({ type: bundle.t, sdp: bundle.s });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._waitForIce(pc);
      // Setup data channel handler BEFORE returning (ondatachannel fires when offerer's DC opens)
      pc.ondatachannel = (e) => { this._setupDc(peerId, e.channel.label, e.channel); };
      const answerBundle = {
        v: 2, s: pc.localDescription.sdp, t: pc.localDescription.type,
        p: this.identity.publicKeyHex, n: this.identity.name,
        f: this.identity.fingerprint, ts: Date.now()
      };
      this.knownPeers[peerId] = { publicKey: bundle.p || '', name: bundle.n || `Peer-${peerId.slice(0,6)}` };
      return { answerBase64: _base64Encode(JSON.stringify(answerBundle)), pc, peerInfo: bundle };
    }

    async processManualAnswer(answerBase64) {
      if (!answerBase64) return false;
      try {
        const decoded = _base64Decode(answerBase64);
        const bundle = JSON.parse(decoded);
        const peerId = bundle.f || 'manual-peer';
        
        // Find the PC. Manual offerers are usually indexed by 'manual-randomId' 
        // while the answer bundle contains the receiver's real fingerprint.
        // We look for a PC that is in 'have-local-offer' state.
        let pc = Object.values(this.pcs).find(p => p.signalingState === 'have-local-offer');
        
        if (!pc) pc = this.pcs[peerId];
        
        if (!pc) {
          console.error('[P2P] No pending PeerConnection found for manual answer');
          return false;
        }
        
        await pc.setRemoteDescription({ type: bundle.t, sdp: bundle.s });
        this.knownPeers[peerId] = { publicKey: bundle.p || '', name: bundle.n || `Peer-${peerId.slice(0,6)}` };
        return true;
      } catch (e) {
        console.error('[P2P] Manual answer processing error:', e);
        return false;
      }
    }

    decodeSignal(b64) {
      return _base64Decode(b64);
    }

    // ─── Send message via data channel ──────────────────────────────────────

    sendMessage(peerId, dataObj) {
      const meshSession = this.meshConns[peerId];
      if (meshSession) {
        const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
        this._encryptPayload(meshSession.sharedKey, payload).then(encrypted => {
          window.ghostlink.ghostMesh.send(meshSession.connId, encrypted);
        }).catch(err => {
          console.error('[GhostMesh] Send message failed:', err);
        });
        return true;
      }
      return this.sendOnChannel(peerId, 'messages', dataObj);
    }

    sendOnChannel(peerId, channelName, dataObj) {
      const dc = this.dcs[peerId]?.[channelName];
      if (dc && dc.readyState === 'open') {
        dc.send(typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj));
        return true;
      }
      return false;
    }

    sendPresence(peerId, dataObj) {
      const dc = this.dcs[peerId]?.presence;
      if (dc && dc.readyState === 'open') {
        dc.send(typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj));
        return true;
      }
      return false;
    }

    // ─── Utils ─────────────────────────────────────────────────────────────

    isConnected(peerId) {
      return !!this.meshConns[peerId] || this.dcs[peerId]?.messages?.readyState === 'open';
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────

    /** Force-drop a single peer (public counterpart of _cleanupPeer). */
    removePeer(peerId) {
      // Close the Ghost Mesh session, not just its lookup entry — dropping the
      // map entry alone leaves the underlying connId open and streaming.
      const mesh = this.meshConns[peerId];
      delete this.meshConns[peerId];
      if (mesh) {
        try { window.ghostlink?.ghostMesh?.close(mesh.connId); } catch (e) {}
      }
      this._cleanupPeer(peerId);
      // Forced: every transport is being closed on purpose. Emitting here also
      // consumes the flag, so the resulting close handlers stay silent.
      this._announceDisconnected(peerId, true);
      return true;
    }

    _cleanupPeer(peerId) {
      if (this.pcs[peerId]) {
        try { this.pcs[peerId].close(); } catch (e) {}
        delete this.pcs[peerId];
      }
      if (this.dcs[peerId]) {
        Object.values(this.dcs[peerId]).forEach(ch => {
          try { ch.close(); } catch (e) {}
        });
        delete this.dcs[peerId];
      }
      if (this.pendingIce[peerId]) delete this.pendingIce[peerId];
      delete this.states[peerId];
    }

    /**
     * Full teardown for when this connector is being replaced. disconnect()
     * already closes every peer transport; this additionally blocks signaling
     * reconnects and drops listeners so nothing can emit into stale handlers
     * afterwards. A destroyed connector cannot be reconnected.
     */
    destroy() {
      this._destroyed = true;
      this.disconnect();
      this.removeAllListeners();
    }

    joinRoom(roomId, publicKey) {
      this.roomId = roomId;
      this._send({ type: 'join-room', room: roomId, peerId: this.identity.fingerprint, publicKey });
    }

    leaveRoom() {
      this._send({ type: 'leave-room', room: this.roomId, peerId: this.identity.fingerprint });
      this.roomId = null;
    }

    disconnect() {
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      if (this.wsPingInterval) { clearInterval(this.wsPingInterval); this.wsPingInterval = null; }
      if (this.ws) { this.ws.close(); this.ws = null; }
      this.wsOpen = false;

      // Cleanup Mesh
      this._meshListeners.forEach(un => { try { un(); } catch (e) {} });
      this._meshListeners = [];
      for (const conn of Object.values(this.meshConns)) {
        try { window.ghostlink?.ghostMesh?.close(conn.connId); } catch (e) {}
      }

      // Every peer we ever announced gets exactly one disconnect, including
      // mesh-only peers that have no entry in this.pcs.
      const peerIds = new Set([
        ...this._announced,
        ...Object.keys(this.pcs),
        ...Object.keys(this.meshConns),
      ]);
      this.meshConns = {};
      peerIds.forEach((id) => {
        this._cleanupPeer(id);
        this._announceDisconnected(id, true);
      });
    }

    _initGhostMesh() {
      if (typeof window !== 'undefined' && window.ghostlink?.ghostMesh) {
        const gm = window.ghostlink.ghostMesh;
        
        const un1 = gm.onPeerConnected(async ({ connId, remoteAddress, type }) => {
          console.debug(`[GhostMesh] Accepted incoming connection ${connId} from ${remoteAddress}`);
        });
        
        const un2 = gm.onData(async ({ connId, data }) => {
          await this._handleMeshData(connId, data);
        });
        
        const un3 = gm.onPeerDisconnected(({ connId }) => {
          this._handleMeshDisconnected(connId);
        });
        
        this._meshListeners = [un1, un2, un3];
        
        if (localStorage.getItem('gl_yggdrasil_enabled') === 'true') {
          gm.startServer()
            .then((res) => {
              // A failed listen resolves as { success: false } rather than rejecting.
              if (res && res.success === false) console.warn('[GhostMesh] Auto-start server failed:', res.error);
            })
            .catch(err => console.warn('[GhostMesh] Auto-start server failed:', err.message));
        }
      }
    }

    /**
     * Strict hex -> bytes. Returns an empty array for anything that is not an
     * even-length run of hex digits, so a malformed key fails ECDH import
     * rather than silently becoming NaN bytes.
     * @private
     */
    _hexToBytes(hex) {
      if (typeof hex !== 'string') return new Uint8Array(0);
      const clean = hex.trim().toLowerCase();
      if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
        return new Uint8Array(0);
      }
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
      }
      return out;
    }

    /**
     * The fingerprint a public key is entitled to claim: the first 16 hex
     * characters of SHA-256 over the lower-cased key hex, upper-cased. This
     * mirrors fingerprintFromPublicKey in index.html — the two must stay
     * identical or peers compute different fingerprints for the same identity.
     * @private
     * @returns {Promise<string|null>} null when the key is unusable.
     */
    async _fingerprintFor(publicKeyHex) {
      if (typeof publicKeyHex !== 'string' || !publicKeyHex.trim()) return null;
      if (this._hexToBytes(publicKeyHex).length === 0) return null;
      const bytes = new TextEncoder().encode(publicKeyHex.trim().toLowerCase());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16)
        .toUpperCase();
    }

    /**
     * Tear down a mesh connection that failed to authenticate.
     * @private
     */
    _closeMeshConn(connId) {
      try {
        window.ghostlink?.ghostMesh?.close(connId);
      } catch (e) {
        console.warn('[GhostMesh] Failed to close connection', connId, e.message);
      }
      for (const [pid, conn] of Object.entries(this.meshConns)) {
        if (conn.connId === connId) delete this.meshConns[pid];
      }
    }

    async _handleMeshData(connId, data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'identity') {
          const peerId = msg.fingerprint;
          console.debug(`[GhostMesh] Received identity from peer ${peerId} (${msg.name})`);

          // The announced fingerprint must be the truncated SHA-256 of the
          // announced key (fingerprintFromPublicKey in index.html), or anyone
          // could claim another identity's fingerprint.
          const boundFingerprint = await this._fingerprintFor(msg.publicKeyHex);
          if (!boundFingerprint || boundFingerprint !== String(peerId || '').trim().toUpperCase()) {
            console.warn(
              `[GhostMesh] Rejecting identity on ${connId}: fingerprint ${peerId} does not match its announced public key.`
            );
            this._closeMeshConn(connId);
            return;
          }

          // ECDH or nothing: no fallback key derived from public values.
          const privKey = this.identity.privateKey || (this.identity.keyPair && this.identity.keyPair.privateKey);
          if (!privKey) {
            console.warn('[GhostMesh] No local ECDH private key — refusing mesh session.');
            this._closeMeshConn(connId);
            return;
          }

          let sharedKey = null;
          try {
            const peerKey = await crypto.subtle.importKey(
              'raw',
              this._hexToBytes(msg.publicKeyHex),
              { name: 'ECDH', namedCurve: 'P-256' },
              false,
              []
            );
            const sharedBits = await crypto.subtle.deriveBits(
              { name: 'ECDH', public: peerKey },
              privKey,
              256
            );
            sharedKey = await crypto.subtle.importKey(
              'raw', sharedBits,
              { name: 'AES-GCM', length: 256 },
              false,
              ['encrypt', 'decrypt']
            );
          } catch (e) {
            console.warn('[GhostMesh] ECDH key derivation failed — refusing mesh session:', e.message);
            this._closeMeshConn(connId);
            return;
          }

          this.meshConns[peerId] = {
            connId,
            sharedKey,
            name: msg.name,
            publicKey: msg.publicKeyHex,
          };
          
          if (!msg.reply) {
            const identMsg = {
              type: 'identity',
              fingerprint: this.identity.fingerprint,
              name: this.identity.name,
              publicKeyHex: this.identity.publicKeyHex,
              yggdrasilAddress: localStorage.getItem('gl_yggdrasil_address') || '',
              reply: true
            };
            await window.ghostlink.ghostMesh.send(connId, JSON.stringify(identMsg));
          }
          
          this._announceConnected(peerId, { mode: 'Ghost Mesh', name: msg.name, publicKey: msg.publicKeyHex });
          
          if (msg.yggdrasilAddress) {
            this.cacheMeshPeer(peerId, msg.yggdrasilAddress, msg.name);
          }
          return;
        }
        
        let peerId = null;
        let session = null;
        for (const [pid, conn] of Object.entries(this.meshConns)) {
          if (conn.connId === connId) {
            peerId = pid;
            session = conn;
            break;
          }
        }
        
        if (!session) {
          console.warn(`[GhostMesh] Data received on unmapped connection ${connId}`);
          return;
        }
        
        const decrypted = await this._decryptPayload(session.sharedKey, data);
        const parsed = JSON.parse(decrypted);
        this.emit('message', peerId, parsed);
        
      } catch (e) {
        console.error('[GhostMesh] Failed to process incoming data:', e);
      }
    }

    _handleMeshDisconnected(connId) {
      let peerId = null;
      for (const [pid, conn] of Object.entries(this.meshConns)) {
        if (conn.connId === connId) {
          peerId = pid;
          break;
        }
      }
      if (peerId) {
        delete this.meshConns[peerId];
        if (this._isPeerLive(peerId)) return; // WebRTC path still usable
        this.states[peerId] = 'disconnected';
        this._announceDisconnected(peerId);
      }
    }

    async _encryptPayload(sharedKey, plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plaintext);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sharedKey,
        encoded
      );
      
      const arrayToBase64 = (bytes) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };
      
      return JSON.stringify({
        iv: arrayToBase64(iv),
        data: arrayToBase64(new Uint8Array(ciphertext))
      });
    }

    async _decryptPayload(sharedKey, encryptedStr) {
      const { iv, data } = JSON.parse(encryptedStr);
      
      const base64ToArray = (b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      
      const ivBytes = base64ToArray(iv);
      const ciphertextBytes = base64ToArray(data);
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        sharedKey,
        ciphertextBytes
      );
      
      return new TextDecoder().decode(decrypted);
    }

    async connectToMeshPeer(peerId, yggdrasilAddress) {
      if (this.meshConns[peerId]) return true;
      if (typeof window === 'undefined' || !window.ghostlink?.ghostMesh) return false;
      
      try {
        const res = await window.ghostlink.ghostMesh.dial(yggdrasilAddress); // main.js supplies GHOSTMESH_PORT
        if (res.success) {
          const connId = res.connId;
          const identMsg = {
            type: 'identity',
            fingerprint: this.identity.fingerprint,
            name: this.identity.name,
            publicKeyHex: this.identity.publicKeyHex,
            yggdrasilAddress: localStorage.getItem('gl_yggdrasil_address') || ''
          };
          
          setTimeout(async () => {
            await window.ghostlink.ghostMesh.send(connId, JSON.stringify(identMsg));
          }, 150);
          
          return true;
        }
      } catch (e) {
        console.warn('[GhostMesh] Dial failed:', e.message);
      }
      return false;
    }

    cacheMeshPeer(peerId, address, name) {
      try {
        const cached = JSON.parse(localStorage.getItem('gl_mesh_peers') || '{}');
        cached[peerId] = {
          yggdrasilAddress: address,
          name: name || `Peer-${peerId.slice(0,6)}`,
          lastConnected: Date.now()
        };
        localStorage.setItem('gl_mesh_peers', JSON.stringify(cached));
        window.dispatchEvent(new CustomEvent('gl-mesh-peers-updated'));
      } catch (e) {
        console.error('[GhostMesh] Failed to cache peer:', e);
      }
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { P2PConnector };
  } else {
    exports.GhostLinkP2P = { P2PConnector };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
