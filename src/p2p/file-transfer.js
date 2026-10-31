/**
 * GhostLink Encrypted Chunked File Transfer
 *
 * Sends and receives files over a peer manager's 'files' channel: the WebRTC
 * data channel when one is open, otherwise GMP DATA through the bridge
 * (GMPBridgeConnector.sendOnChannel). Each transfer is under its own
 * AES-256-GCM key sealed to the recipient.
 *
 * Protocol (v2):
 *   sender   -> file-meta  {transferId, sealed}
 *   receiver -> file-ack   {stage: 'accepted', v: 2}   or file-refused {reason}
 *   sender   -> file-chunk ...   at most sendWindowChunks unacknowledged
 *   receiver -> file-ack   {stage: 'progress', received}   every ackEveryChunks, and on the last
 *   sender   -> file-done
 *   receiver -> file-ack   {stage: 'complete'}   or file-refused {reason}
 * Either side may end a transfer early: the receiver with file-refused, the
 * sender with file-cancel. The sender reports 'sent' only on the complete ack.
 *
 * @module file-transfer
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Size of each raw chunk before encryption (64 KB). */
const CHUNK_SIZE = 64 * 1024;

const MiB = 1024 * 1024;

/**
 * Limits. An incoming file is reassembled in memory until it completes, so the
 * byte quotas bound what peers can make this device hold, and also cap the
 * largest file (streaming to disk is the BULK-circuit rewrite, not this).
 * Every limit is enforced when the header arrives, before any chunk.
 */
const DEFAULT_LIMITS = Object.freeze({
  /** Largest file sent or accepted. Equal to the per-peer byte quota: the whole file is held in memory until it completes. */
  maxFileBytes: 256 * MiB,
  /** Incoming transfers open at once, all peers together. */
  maxIncoming: 16,
  /** Incoming transfers open at once from one peer: one peer cannot take the shared slots. */
  maxIncomingPerPeer: 2,
  /** Declared bytes of one peer's open incoming transfers, reserved when its header is accepted. */
  maxIncomingBytesPerPeer: 256 * MiB,
  /** Declared bytes of all open incoming transfers. Two peers at their quota fill it. */
  maxIncomingBytes: 512 * MiB,
  /** Header accepted -> first chunk. */
  firstChunkTimeoutMs: 30 * 1000,
  /** Silence between chunks, and after the last one until file-done. */
  idleTimeoutMs: 30 * 1000,
  /** Absolute lifetime of one incoming transfer: 30 min carries 256 MiB at ~150 KB/s. */
  transferLifetimeMs: 30 * 60 * 1000,
  /** Frames from one peer waiting to be processed. An honest sender has at most sendWindowChunks chunks and a few control frames in flight. */
  maxQueuedFramesPerPeer: 64,
  /** Unacknowledged chunks a sender keeps in flight (2 MiB of plaintext). */
  sendWindowChunks: 32,
  /** The receiver acknowledges every this many chunks, and the last one. */
  ackEveryChunks: 8,
  /** Sender: longest wait for the receiver's next acknowledgement (accepted, progress or complete). */
  ackTimeoutMs: 30 * 1000,
});

/** Transfer ids remembered after they end, so late frames are not reported as unknown. */
const CLOSED_REMEMBERED = 256;

/**
 * Types a received blob may keep. Anything else is served as an opaque
 * download: a peer-chosen text/html or image/svg+xml blob is a same-origin
 * document the moment it is opened in a tab, with the page's keys in reach.
 */
const SAFE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain|application\/(pdf|zip))$/i;

const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (str) => new Uint8Array(str.match(/.{2}/g).map(b => parseInt(b, 16)));
const aad = (transferId, chunkIndex) => new TextEncoder().encode(`${transferId}:${chunkIndex}`);
const mib = (n) => `${(n / MiB).toFixed(n % MiB ? 2 : 0)} MiB`;
const secs = (ms) => `${ms / 1000} s`;
/** A reason a peer sent us: printable, short. */
const peerReason = (r) => (typeof r === 'string' ? r : '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || 'no reason given';
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

// ─── Transfer State ──────────────────────────────────────────────────────────

/**
 * One incoming transfer.
 * @private
 */
class TransferState {
  constructor(id, direction, peerId, meta, key) {
    this.id = id;
    this.direction = direction;
    this.peerId = peerId;
    this.fileName = meta.name || 'unknown';
    this.fileSize = meta.size || 0;
    this.totalChunks = meta.totalChunks || 0;
    this.mimeType = meta.type || 'application/octet-stream';
    this.key = key;
    this.chunks = new Map(); // chunkIndex -> ArrayBuffer
    this.receivedChunks = 0;
    this.receivedBytes = 0;
    this.startTime = Date.now();
    this.timer = null; // first-chunk, then idle
    this.lifetimeTimer = null;
    this.ignored = {}; // kind -> count of frames ignored (logged once per kind)
  }
}

// ─── Simple EventEmitter ─────────────────────────────────────────────────────

if (typeof window.EventEmitter === 'undefined') {
  window.EventEmitter = class EventEmitter {
    constructor() {
      this._listeners = new Map();
    }

    on(event, callback) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(callback);
    }

    off(event, callback) {
      const set = this._listeners.get(event);
      if (set) set.delete(callback);
    }

    emit(event, ...args) {
      const set = this._listeners.get(event);
      if (set) {
        for (const fn of set) {
          try { fn(...args); } catch (e) {
            console.error(`[FileTransfer] Event handler error (${event}):`, e);
          }
        }
      }
    }
  };
}

// ─── FileTransfer ───────────────────────────────────────────────────────────

/**
 * Manages encrypted file transfers over WebRTC data channels or the mesh.
 *
 * Every transfer gets a fresh random AES-256-GCM key, sent with the file's
 * metadata sealed to the recipient's public key in `file-meta`. Each chunk is
 * bound to its transfer and position through the GCM additional data.
 *
 * Events: 'incoming', 'progress', 'complete' (a file arrived), 'error' (an
 * accepted incoming transfer failed), 'refused' (an incoming header was turned
 * down), 'status' ({direction: 'send', status: 'sending' | 'sent' | 'failed',
 * reason}), 'sent' (the receiver confirmed the whole file).
 *
 * @param {object} peerManager - sendOnChannel(peerId, channel, obj); on('file-chunk'), on('peer-disconnected')
 * @param {object} cryptoEngine - encryptWithPublicKey(), decryptWithPrivateKey()
 * @param {{getPeerPublicKey: function(string): ?string, getPrivateKey: function(): ?CryptoKey}} keys
 * @param {{limits?: object, log?: {warn: function}}} [options] - limits override DEFAULT_LIMITS; log defaults to console
 */
class FileTransfer extends EventEmitter {
  constructor(peerManager, cryptoEngine, keys = {}, options = {}) {
    super();
    this._pm = peerManager;
    this._crypto = cryptoEngine;
    this._keys = keys;
    this._limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
    this._log = options.log || console;
    this._transfers = new Map(); // `${peerId}\n${transferId}` -> TransferState (incoming)
    this._outgoing = new Map(); // `${peerId}\n${transferId}` -> outgoing state
    this._closed = new Map(); // key -> why it ended, for late frames (bounded)
    this._inbox = new Map(); // peerId -> tail of that peer's processing chain
    this._queued = new Map(); // peerId -> frames waiting in that chain
    this._dropping = new Set(); // peers whose frames are being dropped (logged once per episode)
    this._peerCount = new Map(); // peerId -> open incoming transfers
    this._peerBytes = new Map(); // peerId -> declared bytes reserved
    this._bytes = 0; // declared bytes reserved, all peers
    this._pm.on('file-chunk', (peerId, data) => this._enqueue(peerId, data));
    this._pm.on('peer-disconnected', (peerId) => this._onPeerGone(peerId));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Send a file to a peer. Resolves only when the receiver confirms it has the
   * whole file; rejects with the reason on refusal, timeout or disconnect.
   * @param {string} peerId
   * @param {File|Blob} file
   * @returns {Promise<string>} transferId
   */
  async sendFile(peerId, file) {
    const L = this._limits;
    const id = 'tx-' + hex(crypto.getRandomValues(new Uint8Array(16)));
    const status = (s, reason) => this.emit('status', { transferId: id, peerId, direction: 'send', status: s, ...(reason ? { reason } : {}) });
    const failed = (reason, code) => {
      this._warn('send-failed', { peerId, transferId: id, reason });
      status('failed', reason);
      return Object.assign(new Error(reason), { code });
    };

    // Size first, before anything is read.
    const size = file ? file.size : NaN;
    if (!Number.isInteger(size) || size < 0 || typeof file.slice !== 'function') throw failed('not a readable file', 'NOT_A_FILE');
    if (size > L.maxFileBytes) throw failed(`file too large: ${mib(size)} (limit ${mib(L.maxFileBytes)})`, 'FILE_TOO_LARGE');
    const pubKey = this._keys.getPeerPublicKey?.(peerId);
    if (!pubKey) throw failed('No public key for this peer — the file cannot be encrypted to them', 'NO_KEY');

    const meta = {
      name: file.name || 'file',
      size,
      type: file.type || 'application/octet-stream',
      totalChunks: Math.ceil(size / CHUNK_SIZE),
    };
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const sealed = await this._crypto.encryptWithPublicKey(JSON.stringify({ key: hex(rawKey), meta }), pubKey);
    rawKey.fill(0);

    const mapKey = peerId + '\n' + id;
    const out = { id, peerId, total: meta.totalChunks, accepted: false, acked: 0, complete: false, failed: null, failedCode: null, remoteEnded: false, wake: null };
    this._outgoing.set(mapKey, out);
    try {
      status('sending');
      await this._push(out, { type: 'file-meta', transferId: id, sealed });
      await this._until(out, () => out.accepted, 'the receiver did not accept the file');
      for (let chunkIndex = 0; chunkIndex < meta.totalChunks; chunkIndex++) {
        // Bounded window: never more than sendWindowChunks unacknowledged.
        await this._until(out, () => chunkIndex - out.acked < L.sendWindowChunks, 'the receiver stopped acknowledging chunks');
        const start = chunkIndex * CHUNK_SIZE;
        const chunk = await file.slice(start, Math.min(size, start + CHUNK_SIZE)).arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad(id, chunkIndex) }, key, chunk);
        await this._push(out, {
          type: 'file-chunk',
          transferId: id,
          chunkIndex,
          iv: hex(iv),
          data: hex(new Uint8Array(encrypted)),
        });
      }
      await this._push(out, { type: 'file-done', transferId: id });
      await this._until(out, () => out.complete, 'the receiver did not confirm the file');
    } catch (e) {
      this._outgoing.delete(mapKey);
      const reason = out.failed || (e && e.message) || 'send failed';
      // Tell the receiver to free its slot now rather than at its timeout.
      if (!out.remoteEnded) this._reply(peerId, { type: 'file-cancel', transferId: id, reason });
      throw failed(reason, out.failedCode || 'SEND_FAILED');
    }
    this._outgoing.delete(mapKey);

    // 'sent', not 'complete': 'complete' means a file *arrived*, and the app
    // files it under received transfers with a "File received" toast.
    status('sent');
    this.emit('sent', { transferId: id, peerId, file: { name: meta.name, size: meta.size, type: meta.type } });
    return id;
  }

  // ── Sending helpers ─────────────────────────────────────────────────────

  async _push(out, frame) {
    if (out.failed) throw new Error(out.failed);
    // sendOnChannel reports a transport with nowhere to send by returning
    // false. true only means it was handed over; acks are the confirmation.
    if (await this._pm.sendOnChannel(out.peerId, 'files', frame) === false) {
      out.failed = out.failed || 'connection to the peer lost during the transfer';
      throw new Error(out.failed);
    }
  }

  /** Wait until pred() holds, the transfer fails, or ackTimeoutMs passes without it. */
  _until(out, pred, what) {
    if (out.failed) return Promise.reject(new Error(out.failed));
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        out.wake = null;
        out.failed = out.failed || `${what} within ${secs(this._limits.ackTimeoutMs)}`;
        out.failedCode = out.failedCode || 'TIMEOUT';
        reject(new Error(out.failed));
      }, this._limits.ackTimeoutMs);
      out.wake = () => {
        if (out.failed) { clearTimeout(t); out.wake = null; reject(new Error(out.failed)); }
        else if (pred()) { clearTimeout(t); out.wake = null; resolve(); }
      };
    });
  }

  _endOutgoing(out, reason, code) {
    if (out.failed) return;
    out.failed = reason;
    out.failedCode = code;
    out.remoteEnded = true;
    if (out.wake) out.wake();
  }

  _onReply(peerId, transferId, key, data) {
    const out = this._outgoing.get(key);
    if (!out) {
      this._warn('reply-ignored', { peerId, transferId, type: data.type, reason: 'no transfer of ours to this peer with that id' });
      return;
    }
    if (data.type === 'file-refused') {
      this._endOutgoing(out, `refused by the receiver: ${peerReason(data.reason)}`, 'REFUSED');
      return;
    }
    if (data.stage === 'accepted' || data.stage === undefined) {
      // An untagged ack is what receivers before v2 send after the header.
      // They never confirm the whole file, so nothing could honestly say "sent".
      if (data.v !== 2) {
        this._endOutgoing(out, 'the receiver runs an older GhostLink that cannot confirm delivery', 'OLD_RECEIVER');
        return;
      }
      out.accepted = true;
    } else if (data.stage === 'progress') {
      const n = data.received;
      if (!Number.isInteger(n) || n < out.acked || n > out.total) {
        this._warn('reply-ignored', { peerId, transferId, type: 'file-ack', reason: `progress ${n} outside ${out.acked}..${out.total}` });
        return;
      }
      out.acked = n;
      this.emit('progress', { transferId, peerId, progress: out.total ? (n / out.total) * 100 : 100 });
    } else if (data.stage === 'complete') {
      out.complete = true;
    } else {
      this._warn('reply-ignored', { peerId, transferId, type: 'file-ack', reason: 'unknown stage' });
      return;
    }
    if (out.wake) out.wake();
  }

  // ── Incoming ────────────────────────────────────────────────────────────

  _warn(event, details) {
    try { this._log.warn(`[FileTransfer] ${event}`, details); } catch { /* logging must not break a transfer */ }
  }

  _reply(peerId, frame) {
    Promise.resolve()
      .then(() => this._pm.sendOnChannel(peerId, 'files', frame))
      .then((r) => { if (r === false) this._warn('reply-not-sent', { peerId, transferId: frame.transferId, type: frame.type }); })
      .catch((e) => this._warn('reply-not-sent', { peerId, transferId: frame.transferId, type: frame.type, error: e && e.message }));
  }

  _remember(key, reason) {
    this._closed.delete(key);
    this._closed.set(key, reason);
    if (this._closed.size > CLOSED_REMEMBERED) this._closed.delete(this._closed.keys().next().value);
  }

  _enqueue(peerId, data) {
    const queued = this._queued.get(peerId) || 0;
    if (queued >= this._limits.maxQueuedFramesPerPeer) {
      // Faster than any honest sender's window allows. Drop the frame, end that
      // peer's incoming transfers, and say so once per episode.
      if (!this._dropping.has(peerId)) {
        this._dropping.add(peerId);
        this._warn('frames-dropped', { peerId, reason: `more than ${this._limits.maxQueuedFramesPerPeer} frames queued from this peer` });
      }
      this._closePeer(peerId, `sent more than ${this._limits.maxQueuedFramesPerPeer} frames ahead of the receiver`, true);
      return;
    }
    this._queued.set(peerId, queued + 1);
    // Strictly in arrival order per peer: opening file-meta is async, and
    // chunks must not reach a transfer that does not exist yet.
    const run = () => this._handleFileChunk(peerId, data).catch((e) => {
      this._warn('receive-failed', { peerId, error: e && e.message });
    });
    const next = (this._inbox.get(peerId) || Promise.resolve()).then(run).then(() => {
      const left = (this._queued.get(peerId) || 1) - 1;
      if (left > 0) this._queued.set(peerId, left);
      else { this._queued.delete(peerId); this._dropping.delete(peerId); }
    });
    this._inbox.set(peerId, next);
    next.then(() => { if (this._inbox.get(peerId) === next) this._inbox.delete(peerId); });
  }

  _onPeerGone(peerId) {
    this._closePeer(peerId, 'peer disconnected', false);
    for (const out of this._outgoing.values()) {
      if (out.peerId === peerId) this._endOutgoing(out, 'peer disconnected', 'DISCONNECTED');
    }
  }

  _closePeer(peerId, reason, notify) {
    for (const st of [...this._transfers.values()]) {
      if (st.peerId === peerId) this._closeIncoming(st, reason, { notify });
    }
  }

  /** Refuse a header: logged, reported to the sender, nothing kept. */
  _refuse(peerId, transferId, key, reason, code) {
    this._warn('refused', { peerId, transferId, code, reason });
    this._remember(key, `refused: ${reason}`);
    this.emit('refused', { transferId, peerId, code, reason });
    this._reply(peerId, { type: 'file-refused', transferId, code, reason });
  }

  /** End an accepted incoming transfer: free its slot, quota and chunks. */
  _closeIncoming(st, reason, { notify = true, error = true } = {}) {
    const key = st.peerId + '\n' + st.id;
    if (this._transfers.get(key) !== st) return;
    clearTimeout(st.timer);
    clearTimeout(st.lifetimeTimer);
    this._transfers.delete(key);
    this._release(st);
    st.chunks.clear();
    this._remember(key, reason);
    this._warn('incoming-closed', { peerId: st.peerId, transferId: st.id, reason, receivedBytes: st.receivedBytes, size: st.fileSize, ignored: st.ignored });
    if (notify) this._reply(st.peerId, { type: 'file-refused', transferId: st.id, reason });
    if (error) this.emit('error', { transferId: st.id, peerId: st.peerId, error: reason });
  }

  _reserve(st) {
    this._peerCount.set(st.peerId, (this._peerCount.get(st.peerId) || 0) + 1);
    this._peerBytes.set(st.peerId, (this._peerBytes.get(st.peerId) || 0) + st.fileSize);
    this._bytes += st.fileSize;
  }

  _release(st) {
    const count = (this._peerCount.get(st.peerId) || 1) - 1;
    if (count > 0) this._peerCount.set(st.peerId, count); else this._peerCount.delete(st.peerId);
    const bytes = (this._peerBytes.get(st.peerId) || 0) - st.fileSize;
    if (bytes > 0) this._peerBytes.set(st.peerId, bytes); else this._peerBytes.delete(st.peerId);
    this._bytes -= st.fileSize;
  }

  /** Why a header for `size` bytes from this peer cannot be accepted now, or null. */
  _quotaRefusal(peerId, size) {
    const L = this._limits;
    if ((this._peerCount.get(peerId) || 0) >= L.maxIncomingPerPeer) {
      return ['PEER_TRANSFERS', `too many transfers from this peer at once (limit ${L.maxIncomingPerPeer})`];
    }
    if (this._transfers.size >= L.maxIncoming) return ['BUSY', `receiver busy: ${L.maxIncoming} transfers already open`];
    if (size === null) return null;
    if (size > L.maxFileBytes) return ['FILE_TOO_LARGE', `file too large: ${mib(size)} (limit ${mib(L.maxFileBytes)})`];
    if ((this._peerBytes.get(peerId) || 0) + size > L.maxIncomingBytesPerPeer) {
      return ['PEER_BYTES', `this peer's open transfers would exceed ${mib(L.maxIncomingBytesPerPeer)}`];
    }
    if (this._bytes + size > L.maxIncomingBytes) return ['BYTES', `open transfers would exceed ${mib(L.maxIncomingBytes)}`];
    return null;
  }

  /** (Re)arm the first-chunk or idle timer. */
  _arm(st) {
    clearTimeout(st.timer);
    const first = st.receivedChunks === 0;
    const ms = first ? this._limits.firstChunkTimeoutMs : this._limits.idleTimeoutMs;
    st.timer = unref(setTimeout(() => this._closeIncoming(st,
      first ? `no data within ${secs(ms)} of the header` : `stalled: nothing for ${secs(ms)}`), ms));
  }

  /** A frame that is ignored, not fatal: logged the first time per kind, counted after. */
  _ignore(st, kind, details) {
    st.ignored[kind] = (st.ignored[kind] || 0) + 1;
    if (st.ignored[kind] === 1) this._warn('frame-ignored', { peerId: st.peerId, transferId: st.id, kind, ...details });
  }

  async _handleFileChunk(peerId, data) {
    if (!data || typeof data !== 'object') {
      this._warn('frame-ignored', { peerId, kind: 'not an object' });
      return;
    }
    const transferId = data.transferId;
    if (typeof transferId !== 'string' || !transferId || transferId.length > 64) {
      this._warn('frame-ignored', { peerId, kind: 'bad transfer id', type: data.type });
      return;
    }
    // Keyed by sender too: one peer must not be able to write into, or
    // replace, a transfer another peer has open.
    const key = peerId + '\n' + transferId;

    if (data.type === 'file-ack' || data.type === 'file-refused') {
      this._onReply(peerId, transferId, key, data);
    } else if (data.type === 'file-meta') {
      if (this._transfers.has(key)) {
        this._ignore(this._transfers.get(key), 'duplicate header', {});
        return;
      }
      // Count limits need no decryption: refuse those before spending any.
      const early = this._quotaRefusal(peerId, null);
      if (early) { this._refuse(peerId, transferId, key, early[1], early[0]); return; }
      let opened;
      try {
        const privKey = this._keys.getPrivateKey?.();
        if (!privKey) throw new Error('private key unavailable');
        opened = JSON.parse(await this._crypto.decryptWithPrivateKey(data.sealed, privKey));
      } catch (e) {
        this.emit('error', { transferId, peerId, error: 'could not decrypt the file header' });
        this._refuse(peerId, transferId, key, 'could not decrypt the file header', 'BAD_HEADER');
        return;
      }
      const m = opened && opened.meta;
      if (!m || !Number.isInteger(m.size) || m.size < 0 ||
          m.totalChunks !== Math.ceil(m.size / CHUNK_SIZE) ||
          typeof opened.key !== 'string' || !/^[0-9a-f]{64}$/.test(opened.key)) {
        this.emit('error', { transferId, peerId, error: 'malformed file header' });
        this._refuse(peerId, transferId, key, 'malformed file header', 'BAD_HEADER');
        return;
      }
      const name = (typeof m.name === 'string' ? m.name : '')
        .replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255) || 'file';
      const type = typeof m.type === 'string' && SAFE_MIME.test(m.type) ? m.type : 'application/octet-stream';
      const aesKey = await crypto.subtle.importKey('raw', unhex(opened.key), 'AES-GCM', false, ['decrypt']);
      // Checked again after the awaits: other peers' headers may have been accepted meanwhile.
      const refusal = this._transfers.has(key) ? ['DUPLICATE', 'duplicate transfer id'] : this._quotaRefusal(peerId, m.size);
      if (refusal) { this._refuse(peerId, transferId, key, refusal[1], refusal[0]); return; }
      const meta = { name, size: m.size, type, totalChunks: m.totalChunks };
      const st = new TransferState(transferId, 'receive', peerId, meta, aesKey);
      this._transfers.set(key, st);
      this._reserve(st);
      this._arm(st);
      st.lifetimeTimer = unref(setTimeout(() => this._closeIncoming(st,
        `exceeded the ${secs(this._limits.transferLifetimeMs)} transfer lifetime`), this._limits.transferLifetimeMs));
      this.emit('incoming', { transferId, peerId, meta });
      this._reply(peerId, { type: 'file-ack', transferId, stage: 'accepted', v: 2 });
    } else if (data.type === 'file-chunk') {
      const state = this._transfers.get(key);
      if (!state) { this._lateOrUnknown(peerId, transferId, key, data.type); return; }
      const idx = data.chunkIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.totalChunks) { this._ignore(state, 'chunk index out of range', { chunkIndex: String(idx).slice(0, 20) }); return; }
      if (state.chunks.has(idx)) { this._ignore(state, 'duplicate chunk', { chunkIndex: idx }); return; }
      if (typeof data.iv !== 'string' || !/^[0-9a-f]{24}$/.test(data.iv) ||
          typeof data.data !== 'string' || data.data.length % 2 !== 0 ||
          data.data.length > (CHUNK_SIZE + 16) * 2 || !/^[0-9a-f]*$/.test(data.data)) {
        this._closeIncoming(state, 'malformed chunk');
        return;
      }
      let decrypted;
      try {
        decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unhex(data.iv), additionalData: aad(transferId, idx) },
          state.key, unhex(data.data));
      } catch (e) {
        this._closeIncoming(state, 'chunk failed authentication');
        return;
      }
      // Closed (timeout, disconnect) while decrypting: already logged and freed.
      if (this._transfers.get(key) !== state) return;
      if (state.chunks.has(idx)) { this._ignore(state, 'duplicate chunk', { chunkIndex: idx }); return; }
      state.receivedBytes += decrypted.byteLength;
      if (state.receivedBytes > state.fileSize) {
        this._closeIncoming(state, 'more data than the header declared');
        return;
      }
      state.chunks.set(idx, decrypted);
      state.receivedChunks++;
      this._arm(state);
      this.emit('progress', { transferId, peerId, progress: Math.min(100, (state.receivedChunks / state.totalChunks) * 100) });
      if (state.receivedChunks % this._limits.ackEveryChunks === 0 || state.receivedChunks === state.totalChunks) {
        this._reply(peerId, { type: 'file-ack', transferId, stage: 'progress', received: state.receivedChunks });
      }
    } else if (data.type === 'file-done') {
      const state = this._transfers.get(key);
      if (!state) { this._lateOrUnknown(peerId, transferId, key, data.type); return; }
      if (state.receivedChunks !== state.totalChunks || state.receivedBytes !== state.fileSize) {
        this._closeIncoming(state, `incomplete transfer (${state.receivedChunks}/${state.totalChunks} chunks)`);
        return;
      }
      const chunks = [];
      for (let i = 0; i < state.totalChunks; i++) chunks.push(state.chunks.get(i));
      // Drop the state (and the plaintext chunks it holds) now that the blob owns the bytes.
      clearTimeout(state.timer);
      clearTimeout(state.lifetimeTimer);
      this._transfers.delete(key);
      this._release(state);
      this._remember(key, 'complete');
      const url = URL.createObjectURL(new Blob(chunks, { type: state.mimeType }));
      state.chunks.clear();
      this.emit('complete', {
        transferId,
        peerId,
        file: { name: state.fileName, size: state.fileSize, type: state.mimeType, url },
      });
      this._reply(peerId, { type: 'file-ack', transferId, stage: 'complete' });
    } else if (data.type === 'file-cancel') {
      const state = this._transfers.get(key);
      if (!state) { this._lateOrUnknown(peerId, transferId, key, data.type); return; }
      this._closeIncoming(state, `cancelled by the sender: ${peerReason(data.reason)}`, { notify: false });
    } else {
      this._warn('frame-ignored', { peerId, transferId, kind: 'unknown type', type: String(data.type).slice(0, 32) });
    }
  }

  /** A frame for no open transfer: expected after one ends (already logged then); otherwise logged and answered once. */
  _lateOrUnknown(peerId, transferId, key, type) {
    if (this._closed.has(key)) return;
    this._remember(key, 'unknown transfer');
    this._warn('frame-ignored', { peerId, transferId, kind: 'unknown transfer', type });
    if (type !== 'file-cancel') this._reply(peerId, { type: 'file-refused', transferId, code: 'UNKNOWN', reason: 'unknown transfer' });
  }
}

FileTransfer.LIMITS = DEFAULT_LIMITS;
FileTransfer.CHUNK_SIZE = CHUNK_SIZE;

if (typeof globalThis !== 'undefined') {
  globalThis.FileTransfer = FileTransfer;
  globalThis.GhostLinkP2P = globalThis.GhostLinkP2P || {};
  globalThis.GhostLinkP2P.FileTransfer = FileTransfer;
}
