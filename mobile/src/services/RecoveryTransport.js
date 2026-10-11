/**
 * GhostLink Mobile — Recovery Transport
 *
 * Implements the ITransport interface for the recovery/distributor.js module
 * using the mobile's WebRTCService for actual P2P fragment distribution.
 *
 * This enables real P2P backup fragment distribution instead of clipboard-only.
 */

const DEFAULT_TIMEOUT = 6000;

class RecoveryTransport {
  constructor(webrtcService) {
    this._webrtc = webrtcService;
    this._handler = null;
    this._pendingRequests = new Map();
    this._messageIdCounter = 0;

    this._webrtc.on('message', ({peerId, data}) => this._handleMessage(peerId, data));
  }

  _generateMsgId() {
    return `m${Date.now()}-${++this._messageIdCounter}`;
  }

  _handleMessage(peerId, msg) {
    if (!msg?.type) return;

    // Only the peer the request went to may answer it (ids are guessable).
    const pending = msg.id ? this._pendingRequests.get(msg.id) : null;
    if (pending && pending.peerId === peerId) {
      clearTimeout(pending.timer);
      this._pendingRequests.delete(msg.id);
      pending.resolve(msg);
      return;
    }
    if (pending) return;

    if (this._handler) {
      try {
        const response = this._handler(peerId, msg);
        if (response && msg.id) {
          this.send(peerId, response);
        }
      } catch (err) {
        console.error('[RecoveryTransport] Handler error:', err);
      }
    }
  }

  onMessage(handler) {
    this._handler = handler;
  }

  async send(peerId, message) {
    const connected = this._webrtc.getConnectedPeers();
    if (!connected.includes(peerId)) {
      throw new Error(`Peer ${peerId} not connected`);
    }

    const sent = this._webrtc.sendMessage(peerId, message);
    if (!sent) {
      throw new Error(`Failed to send message to ${peerId}`);
    }
  }

  async request(peerId, message, timeoutMs = DEFAULT_TIMEOUT) {
    const msgId = message.id || this._generateMsgId();
    const fullMessage = { ...message, id: msgId };

    const connected = this._webrtc.getConnectedPeers();
    if (!connected.includes(peerId)) {
      throw new Error(`Peer ${peerId} not connected`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(msgId);
        reject(new Error(`Request to ${peerId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(msgId, { resolve, timer, peerId });

      const sent = this._webrtc.sendMessage(peerId, fullMessage);
      if (!sent) {
        clearTimeout(timer);
        this._pendingRequests.delete(msgId);
        reject(new Error(`Failed to send message to ${peerId}`));
      }
    });
  }

  getConnectedPeers() {
    return this._webrtc.getConnectedPeers().map(peerId => ({
      id: peerId,
      name: peerId,
      connected: true,
    }));
  }

  destroy() {
    this._pendingRequests.forEach(({ timer }) => clearTimeout(timer));
    this._pendingRequests.clear();
    this._handler = null;
  }
}

export default RecoveryTransport;
