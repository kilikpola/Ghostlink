/**
 * GhostLink Mobile — WebRTC Service
 *
 * Manages WebRTC peer connections on React Native using `react-native-webrtc`,
 * mirroring the web RTCPeerManager lifecycle:
 *   createConnection -> offer/answer exchange -> ICE negotiation -> data channel open
 *
 * @module WebRTCService
 */

import {
  generateSessionKeyPair,
  deriveSessionKeys,
  encryptMessage,
  decryptMessage,
  isEncryptedEnvelope,
} from '../utils/session-crypto';
import {
  RTCPeerConnection,
  mediaDevices,
} from 'react-native-webrtc';

// ─── ICE Configuration ──────────────────────────────────────────────────────

const DEFAULT_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DATA_CHANNEL_LABEL = 'ghostlink-data';
const DATA_CHANNEL_CONFIG = { ordered: true };

// ─── Connection State ───────────────────────────────────────────────────────

export const PeerState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

// ─── Event Emitter (lightweight) ────────────────────────────────────────────

class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this._listeners.delete(event);
    }
    return this;
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[GhostLink:WebRTC] Event error (${event}):`, err);
        }
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

// ─── PeerSession ────────────────────────────────────────────────────────────

/**
 * Encapsulates a single RTCPeerConnection, its data channel, and media streams.
 * @private
 */
class PeerSession {
  /**
   * @param {string} peerId
   * @param {RTCPeerConnection} pc
   */
  constructor(peerId, pc) {
    this.peerId = peerId;
    this.pc = pc;
    /** @type {RTCDataChannel|null} */
    this.dataChannel = null;
    /** @type {string} */
    this.state = PeerState.NEW;
    /** @type {MediaStream|null} */
    this.localStream = null;
    /** @type {MediaStream|null} */
    this.remoteStream = null;
  }

  close() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (_) {
        /* ignore */
      }
      this.dataChannel = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    try {
      this.pc.close();
    } catch (_) {
      /* ignore */
    }
    this.state = PeerState.CLOSED;
  }
}

// ─── WebRTCService ──────────────────────────────────────────────────────────

class WebRTCService extends Emitter {
  /**
   * @param {object} [options]
   * @param {object} [options.iceConfig] Override default ICE configuration.
   */
  constructor(options = {}) {
    super();
    /** @private */ this._iceConfig = {
      ...DEFAULT_ICE_CONFIG,
      ...(options.iceConfig || {}),
    };
    /** @private @type {Map<string, PeerSession>} */
    this._peers = new Map();
    this._gmpActive = false;
    this._gmpWs = null;
    /**
     * Our X25519 keypair for direct-path sessions, and the derived keys per
     * peer. WebRTC's DTLS only protects each hop, so anything relaying the
     * connection sees plaintext; this is what makes the direct path end to end.
     * @private
     */
    this._sessionKeyPair = null;
    /** @private @type {Map<string, {sendKey: Uint8Array, recvKey: Uint8Array}>} */
    this._sessionKeys = new Map();
    /** @private Our own id, needed to derive symmetric keys. */
    this._localPeerId = options.localPeerId || null;
    /**
     * The Ghost Mesh bridge URL (no embedded GMP in this build). One bridge
     * serves one identity, so point it at a bridge started with this phone's
     * own seed, not the desktop's.
     */
    this._gmpBridgeUrl = options.gmpBridgeUrl || null;
    this._gmpSeedPhrase = options.gmpSeedPhrase || null;
    /** @type {'disabled'|'connecting'|'connected'|'needs-unlock'|'failed'} */
    this._gmpStatus = 'disabled';
    if (this._gmpBridgeUrl) this._initGMPConnection();
  }

  /**
   * How the mesh transport is doing, so the UI can say so rather than leaving
   * the user to guess why a message went out over a different path.
   * @returns {{status: string, url: string|null, active: boolean}}
   */
  getMeshStatus() {
    return {status: this._gmpStatus, url: this._gmpBridgeUrl, active: this._gmpActive};
  }

  /**
   * Point the mesh transport at a bridge, or at nothing.
   * @param {string|null} url e.g. ws://192.168.1.15:3002
   * @param {string|null} [seedPhrase] Identity for this node; the bridge starts it.
   */
  setMeshBridge(url, seedPhrase = null) {
    if (this._gmpWs) {
      try { this._gmpWs.close(); } catch (e) { /* already gone */ }
      this._gmpWs = null;
    }
    this._gmpActive = false;
    this._gmpBridgeUrl = url || null;
    if (seedPhrase !== null) this._gmpSeedPhrase = seedPhrase;
    this._gmpStatus = this._gmpBridgeUrl ? 'connecting' : 'disabled';
    this.emit('mesh-status', this.getMeshStatus());
    if (this._gmpBridgeUrl) this._initGMPConnection();
  }

  _initGMPConnection() {
    try {
      this._gmpStatus = 'connecting';
      this._gmpWs = new WebSocket(this._gmpBridgeUrl);
      this._gmpWs.onopen = () => {
        this._gmpActive = true;
        this._gmpStatus = 'connected';
        // The bridge does not bring a node up on its own: without a `start` it
        // has no identity and `send` has nothing to send from. The web client's
        // host sends this; on mobile there is no host, so we send it ourselves.
        if (this._gmpSeedPhrase) {
          try {
            this._gmpWs.send(JSON.stringify({type: 'start', seedPhrase: this._gmpSeedPhrase}));
          } catch (e) {
            console.warn('[Mobile GMP] could not start the node:', e && e.message);
          }
        } else {
          // Connected, but with nothing to start a node with. Saying so beats
          // sitting on an open socket that will never carry a message: the
          // bridge has no identity until it is given one.
          this._gmpStatus = 'needs-unlock';
          this._gmpActive = false;
          console.warn(
            '[Mobile GMP] bridge reachable but no recovery phrase was supplied, ' +
            'so no node was started. Unlock the identity to start the mesh.',
          );
        }
        this.emit('mesh-status', this.getMeshStatus());
        console.log('[Mobile GMP] Connected to GMP bridge, using Ghost Mesh transport');
      };
      
      this._gmpWs.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch (e) {
          return;
        }
        
        if (msg.type === 'started') {
          this._gmpNodeId = msg.nodeId || null;
          this._gmpGhostAddress = msg.ghostAddress || null;
          this.emit('mesh-status', {
            ...this.getMeshStatus(),
            nodeId: this._gmpNodeId,
            ghostAddress: this._gmpGhostAddress,
          });
          return;
        }

        if (msg.type === 'peer-connected') {
          this.emit('peer-state', { peerId: msg.nodeId, state: PeerState.CONNECTED });
          this.emit('datachannel-open', { peerId: msg.nodeId });
        } else if (msg.type === 'peer-disconnected') {
          this.emit('peer-state', { peerId: msg.nodeId, state: PeerState.DISCONNECTED });
          this.emit('datachannel-close', { peerId: msg.nodeId });
        } else if (msg.type === 'message') {
          try {
            const parsed = JSON.parse(msg.payload);
            this.emit('message', { peerId: msg.fromNodeId, data: parsed, transport: 'gmp', encrypted: true });
          } catch (e) {
            this.emit('message', { peerId: msg.fromNodeId, data: msg.payload, transport: 'gmp', encrypted: true });
          }
        }
      };
      
      this._gmpWs.onerror = () => {
        this._gmpActive = false;
        this._gmpStatus = 'failed';
        this.emit('mesh-status', this.getMeshStatus());
      };

      this._gmpWs.onclose = () => {
        this._gmpActive = false;
        if (this._gmpStatus !== 'failed') this._gmpStatus = 'disabled';
        this.emit('mesh-status', this.getMeshStatus());
      };
    } catch (e) {
      this._gmpActive = false;
      this._gmpStatus = 'failed';
      this.emit('mesh-status', this.getMeshStatus());
    }
  }

  // ── Connection Creation ─────────────────────────────────────────────────

  /**
   * Create a new RTCPeerConnection to a remote peer and initiate the
   * offer/answer exchange via the attached signaling service.
   *
   * @param {string} peerId Remote peer identifier.
   * @param {object} [options]
   * @param {boolean} [options.initiator=true] If true, create and send an offer.
   * @returns {Promise<PeerSession>}
   */
  async createConnection(peerId, { initiator = true } = {}) {
    if (this._gmpActive && this._gmpWs && this._gmpWs.readyState === 1) {
      this.emit('peer-state', { peerId, state: PeerState.CONNECTING });
      const session = new PeerSession(peerId, { close: () => {} });
      this._peers.set(peerId, session);
      return session;
    }

    if (this._peers.has(peerId)) {
      return this._peers.get(peerId);
    }

    const pc = new RTCPeerConnection(this._iceConfig);
    const session = new PeerSession(peerId, pc);
    this._peers.set(peerId, session);

    session.state = PeerState.CONNECTING;
    this.emit('peer-state', { peerId, state: PeerState.CONNECTING });

    // ── ICE Candidate Handling ──────────────────────────────────────────

    pc.onicecandidateerror = (event) => {
      console.warn(
        `[GhostLink:WebRTC] ICE candidate error for ${peerId}:`,
        event,
      );
    };

    // ── Connection State ────────────────────────────────────────────────

    pc.onconnectionstatechange = () => {
      const csState = pc.connectionState;
      let mapped;
      switch (csState) {
        case 'connected':
          mapped = PeerState.CONNECTED;
          break;
        case 'disconnected':
          mapped = PeerState.DISCONNECTED;
          break;
        case 'failed':
          mapped = PeerState.FAILED;
          break;
        case 'closed':
          mapped = PeerState.CLOSED;
          break;
        default:
          mapped = PeerState.CONNECTING;
      }
      session.state = mapped;
      this.emit('peer-state', { peerId, state: mapped });

      if (mapped === PeerState.FAILED || mapped === PeerState.CLOSED) {
        this._cleanupPeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.emit('ice-state', {
        peerId,
        state: pc.iceConnectionState,
      });
    };

    // ── Data Channel ────────────────────────────────────────────────────

    if (initiator) {
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_CONFIG);
      this._setupDataChannel(session, dc);
    }

    pc.ondatachannel = (event) => {
      this._setupDataChannel(session, event.channel);
    };

    // ── Remote Media Stream ─────────────────────────────────────────────

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        session.remoteStream = event.streams[0];
        this.emit('remote-stream', {
          peerId,
          stream: event.streams[0],
        });
      }
    };

    // ── Create Offer (if initiator) ─────────────────────────────────────

    if (initiator) {
      // There is no rendezvous to carry this offer to the peer (no signaling
      // server exists), so a direct connection cannot complete yet.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    }

    return session;
  }

  // ── Data Channel ──────────────────────────────────────────────────────

  /**
   * Wire up data channel event handlers.
   * @private
   * @param {PeerSession} session
   * @param {RTCDataChannel} dc
   */
  _setupDataChannel(session, dc) {
    session.dataChannel = dc;

    dc.onopen = () => {
      // Offer our half of the session before anything else crosses the wire.
      // Until the peer answers there is no key, and sendMessage refuses rather
      // than falling back to plaintext.
      try {
        if (!this._sessionKeyPair) this._sessionKeyPair = generateSessionKeyPair();
        dc.send(JSON.stringify({
          __gl: 'key-exchange',
          peerId: this._localPeerId,
          publicKey: this._sessionKeyPair.publicKeyHex,
        }));
      } catch (err) {
        console.warn('[GhostLink:WebRTC] could not offer a session key:', err && err.message);
      }
      this.emit('datachannel-open', { peerId: session.peerId });
    };

    dc.onclose = () => {
      this.emit('datachannel-close', { peerId: session.peerId });
    };

    dc.onerror = (err) => {
      console.error(
        `[GhostLink:WebRTC] DataChannel error for ${session.peerId}:`,
        err,
      );
      this.emit('datachannel-error', { peerId: session.peerId, error: err });
    };

    dc.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        payload = event.data;
      }

      // The key-exchange frame is transport plumbing, not a message.
      if (payload && payload.__gl === 'key-exchange') {
        this._acceptSessionKey(session.peerId, payload).catch(err => {
          console.warn('[GhostLink:WebRTC] session key exchange failed:', err && err.message);
        });
        return;
      }

      if (isEncryptedEnvelope(payload)) {
        const keys = this._sessionKeys.get(session.peerId);
        let plaintext;
        try {
          plaintext = decryptMessage(payload, keys && keys.recvKey);
        } catch (err) {
          // A frame that will not authenticate is tampered with or from a
          // session we do not hold. Surfacing it as a message would be worse
          // than dropping it.
          console.warn('[GhostLink:WebRTC] dropping an unreadable frame:', err && err.message);
          this.emit('message-error', { peerId: session.peerId, error: err });
          return;
        }
        let data;
        try {
          data = JSON.parse(plaintext);
        } catch (_) {
          data = plaintext;
        }
        this.emit('message', { peerId: session.peerId, data, transport: 'webrtc-e2e', encrypted: true });
        return;
      }

      // Anything else arrived without app-layer encryption. It is passed on so
      // control traffic still works, but it is explicitly marked so the UI
      // never shows it under a padlock.
      this.emit('message', { peerId: session.peerId, data: payload, transport: 'webrtc-plain', encrypted: false });
    };
  }

  /**
   * Take the peer's half of the session and derive the pair of keys.
   * @private
   */
  async _acceptSessionKey(peerId, frame) {
    if (!frame || typeof frame.publicKey !== 'string') throw new Error('malformed key-exchange frame');
    if (!this._sessionKeyPair) this._sessionKeyPair = generateSessionKeyPair();

    // Both sides must agree on which id is which, so fall back to the channel's
    // peer id if we were never told our own.
    const theirId = frame.peerId || peerId;
    const ourId = this._localPeerId;
    if (!ourId) throw new Error('local peer id unknown; cannot derive a session');

    const keys = await deriveSessionKeys(this._sessionKeyPair.privateKey, frame.publicKey, ourId, theirId);
    this._sessionKeys.set(peerId, keys);
    this.emit('session-established', { peerId, transport: 'webrtc-e2e' });
  }

  /** Tell the caller whether this peer can be written to end-to-end yet. */
  getPeerSecurity(peerId) {
    if (this._gmpActive && this._gmpWs && this._gmpWs.readyState === 1) {
      return { transport: 'gmp', encrypted: true, ready: true };
    }
    const session = this._peers.get(peerId);
    const open = !!(session && session.dataChannel && session.dataChannel.readyState === 'open');
    return {
      transport: 'webrtc',
      encrypted: this._sessionKeys.has(peerId),
      ready: open && this._sessionKeys.has(peerId),
    };
  }

  /** Our own id, used as one half of the session key derivation. */
  setLocalPeerId(peerId) {
    this._localPeerId = peerId || null;
  }

  /**
   * Send a message to a specific peer over the data channel.
   *
   * @param {string} peerId
   * @param {object|string} data Will be JSON-stringified if an object.
   * @returns {boolean} True if sent, false if channel not ready.
   */
  sendMessage(peerId, data) {
    if (this._gmpActive && this._gmpWs && this._gmpWs.readyState === 1) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this._gmpWs.send(JSON.stringify({
        type: 'send',
        destinationNodeId: peerId,
        payload
      }));
      return true;
    }

    const session = this._peers.get(peerId);
    if (!session || !session.dataChannel) return false;

    const dc = session.dataChannel;
    if (dc.readyState !== 'open') return false;

    // Direct path: DTLS protects only the hop, so the payload is sealed here or
    // not sent at all.
    const keys = this._sessionKeys.get(peerId);
    if (!keys) {
      console.warn(`[GhostLink:WebRTC] no session with ${peerId} yet; holding the message`);
      return false;
    }

    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    try {
      dc.send(JSON.stringify(encryptMessage(plaintext, keys.sendKey)));
    } catch (err) {
      console.warn('[GhostLink:WebRTC] send failed:', err && err.message);
      return false;
    }
    return true;
  }

  // ── Media Streams ─────────────────────────────────────────────────────

  /**
   * Add a local media stream (audio/video) to a peer connection.
   *
   * @param {string} peerId
   * @param {{ audio?: boolean, video?: boolean }} [constraints]
   * @returns {Promise<MediaStream>} The local stream that was added.
   */
  async addMediaStream(peerId, constraints = { audio: true, video: true }) {
    const session = this._peers.get(peerId);
    if (!session) throw new Error(`No session for peer ${peerId}`);

    const stream = await mediaDevices.getUserMedia(constraints);
    session.localStream = stream;

    for (const track of stream.getTracks()) {
      session.pc.addTrack(track, stream);
    }

    this.emit('local-stream', { peerId, stream });
    return stream;
  }

  /**
   * Remove the local media stream from a peer connection and stop all tracks.
   *
   * @param {string} peerId
   */
  removeMediaStream(peerId) {
    const session = this._peers.get(peerId);
    if (!session || !session.localStream) return;

    session.localStream.getTracks().forEach((track) => {
      track.stop();
      const senders = session.pc.getSenders();
      const sender = senders.find((s) => s.track === track);
      if (sender) {
        session.pc.removeTrack(sender);
      }
    });

    session.localStream = null;
    this.emit('local-stream-removed', { peerId });
  }

  // ── Peer Queries ──────────────────────────────────────────────────────

  /**
   * Get all connected peer IDs.
   * @returns {string[]}
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, session] of this._peers) {
      if (session.state === PeerState.CONNECTED) {
        connected.push(peerId);
      }
    }
    return connected;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Disconnect from a single peer and clean up resources.
   * @param {string} peerId
   */
  disconnectPeer(peerId) {
    this._cleanupPeer(peerId);
  }

  /**
   * Disconnect from all peers and release all resources.
   */
  disconnectAll() {
    for (const [peerId] of this._peers) {
      this._cleanupPeer(peerId);
    }
  }

  /**
   * Internal cleanup for a single peer.
   * @private
   * @param {string} peerId
   */
  _cleanupPeer(peerId) {
    const session = this._peers.get(peerId);
    if (!session) return;

    session.close();
    this._peers.delete(peerId);
    this.emit('peer-closed', { peerId });
  }

  /**
   * Full teardown — disconnect all peers and remove all event listeners.
   */
  destroy() {
    this.disconnectAll();
    this.removeAllListeners();
  }
}

export {WebRTCService};

/**
 * The app's single transport instance. The class is also exported for
 * RecoveryScreen's throwaway connection.
 */
export default new WebRTCService();
