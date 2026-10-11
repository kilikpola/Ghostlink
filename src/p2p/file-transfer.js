/**
 * GhostLink Encrypted Chunked File Transfer over WebRTC
 *
 * Sends and receives files over WebRTC data channels or the mesh, each
 * transfer under its own AES-256-GCM key sealed to the recipient.
 *
 * @module file-transfer
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Size of each raw chunk before encryption (64 KB). */
const CHUNK_SIZE = 64 * 1024;

/** Chunks sent between pauses that let the channel buffer drain. */
const WINDOW_SIZE = 16;

// ─── Limits on what a peer may claim ─────────────────────────────────────────

/** Largest file accepted (matches the Pro transfer ceiling in index.html). */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Incoming transfers held open at once, across all peers. */
const MAX_INCOMING = 16;

/**
 * Types a received blob may keep. Anything else is served as an opaque
 * download: a peer-chosen text/html or image/svg+xml blob is a same-origin
 * document the moment it is opened in a tab, with the page's keys in reach.
 */
const SAFE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain|application\/(pdf|zip))$/i;

const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (str) => new Uint8Array(str.match(/.{2}/g).map(b => parseInt(b, 16)));
const aad = (transferId, chunkIndex) => new TextEncoder().encode(`${transferId}:${chunkIndex}`);

// ─── Transfer State ──────────────────────────────────────────────────────────

/**
 * Tracks the state of a single file transfer (send or receive).
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
 * @param {object} peerManager - sendOnChannel(peerId, channel, obj) + on('file-chunk')
 * @param {object} cryptoEngine - encryptWithPublicKey(), decryptWithPrivateKey()
 * @param {{getPeerPublicKey: function(string): ?string, getPrivateKey: function(): ?CryptoKey}} keys
 */
class FileTransfer extends EventEmitter {
  constructor(peerManager, cryptoEngine, keys = {}) {
    super();
    this._pm = peerManager;
    this._crypto = cryptoEngine;
    this._keys = keys;
    this._transfers = new Map(); // `${peerId}\n${transferId}` -> TransferState
    this._inbox = new Map(); // peerId -> tail of that peer's processing chain
    this._pm.on('file-chunk', (peerId, data) => {
      // Strictly in arrival order per peer: opening file-meta is async, and
      // chunks must not reach a transfer that does not exist yet.
      const run = () => this._handleFileChunk(peerId, data).catch((e) => {
        console.error('[FileTransfer] receive failed:', e);
      });
      const next = (this._inbox.get(peerId) || Promise.resolve()).then(run);
      this._inbox.set(peerId, next);
      next.then(() => { if (this._inbox.get(peerId) === next) this._inbox.delete(peerId); });
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Send a file to a peer.
   * @param {string} peerId
   * @param {File|Blob} file
   * @returns {Promise<string>} transferId
   */
  async sendFile(peerId, file) {
    const pubKey = this._keys.getPeerPublicKey?.(peerId);
    if (!pubKey) throw new Error('No public key for this peer — the file cannot be encrypted to them');

    const id = 'tx-' + hex(crypto.getRandomValues(new Uint8Array(16)));
    const buffer = await file.arrayBuffer();
    const meta = {
      name: file.name || 'file',
      size: buffer.byteLength,
      type: file.type || 'application/octet-stream',
      totalChunks: Math.ceil(buffer.byteLength / CHUNK_SIZE),
    };
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const sealed = await this._crypto.encryptWithPublicKey(JSON.stringify({ key: hex(rawKey), meta }), pubKey);
    rawKey.fill(0);

    const send = async (payload) => {
      // sendOnChannel reports a transport with nowhere to send by returning
      // false; carrying on would announce a transfer that never left.
      if (await this._pm.sendOnChannel(peerId, 'files', payload) === false) {
        throw new Error('Connection to peer lost during file transfer');
      }
    };

    await send({ type: 'file-meta', transferId: id, sealed });

    for (let chunkIndex = 0; chunkIndex < meta.totalChunks; chunkIndex++) {
      const chunk = buffer.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(id, chunkIndex) }, key, chunk);
      await send({
        type: 'file-chunk',
        transferId: id,
        chunkIndex,
        iv: hex(iv),
        data: hex(new Uint8Array(encrypted)),
      });

      // Flow control: yield so the channel buffer can drain.
      if ((chunkIndex + 1) % WINDOW_SIZE === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      this.emit('progress', { transferId: id, peerId, progress: Math.min(100, ((chunkIndex + 1) / meta.totalChunks) * 100) });
    }

    await send({ type: 'file-done', transferId: id });

    // 'sent', not 'complete': 'complete' means a file *arrived*, and the app
    // files it under received transfers with a "File received" toast.
    this.emit('sent', { transferId: id, peerId, file: { name: meta.name, size: meta.size, type: meta.type } });
    return id;
  }

  // ── Incoming handlers ─────────────────────────────────────────────────────

  _fail(key, peerId, transferId, error) {
    this._transfers.delete(key);
    this.emit('error', { transferId, peerId, error });
  }

  async _handleFileChunk(peerId, data) {
    if (!data || typeof data !== 'object') return;
    const transferId = data.transferId;
    if (typeof transferId !== 'string' || !transferId || transferId.length > 64) return;
    // Keyed by sender too: one peer must not be able to write into, or
    // replace, a transfer another peer has open.
    const key = peerId + '\n' + transferId;

    if (data.type === 'file-meta') {
      if (this._transfers.has(key) || this._transfers.size >= MAX_INCOMING) return;
      let opened;
      try {
        const privKey = this._keys.getPrivateKey?.();
        if (!privKey) throw new Error('private key unavailable');
        opened = JSON.parse(await this._crypto.decryptWithPrivateKey(data.sealed, privKey));
      } catch (e) {
        this.emit('error', { transferId, peerId, error: 'could not decrypt the file header' });
        return;
      }
      const m = opened && opened.meta;
      if (!m || !Number.isInteger(m.size) || m.size < 0 || m.size > MAX_FILE_BYTES ||
          m.totalChunks !== Math.ceil(m.size / CHUNK_SIZE) ||
          typeof opened.key !== 'string' || !/^[0-9a-f]{64}$/.test(opened.key)) {
        this.emit('error', { transferId, peerId, error: 'malformed file header' });
        return;
      }
      const name = (typeof m.name === 'string' ? m.name : '')
        .replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255) || 'file';
      const type = typeof m.type === 'string' && SAFE_MIME.test(m.type) ? m.type : 'application/octet-stream';
      const aesKey = await crypto.subtle.importKey('raw', unhex(opened.key), 'AES-GCM', false, ['decrypt']);
      const meta = { name, size: m.size, type, totalChunks: m.totalChunks };
      this._transfers.set(key, new TransferState(transferId, 'receive', peerId, meta, aesKey));
      this.emit('incoming', { transferId, peerId, meta });
      await this._pm.sendOnChannel(peerId, 'files', { type: 'file-ack', transferId });
    } else if (data.type === 'file-chunk') {
      const state = this._transfers.get(key);
      if (!state) return;
      const idx = data.chunkIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.totalChunks || state.chunks.has(idx)) return;
      if (typeof data.iv !== 'string' || !/^[0-9a-f]{24}$/.test(data.iv) ||
          typeof data.data !== 'string' || data.data.length % 2 !== 0 ||
          data.data.length > (CHUNK_SIZE + 16) * 2 || !/^[0-9a-f]*$/.test(data.data)) {
        this._fail(key, peerId, transferId, 'malformed chunk');
        return;
      }
      let decrypted;
      try {
        decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unhex(data.iv), additionalData: aad(transferId, idx) },
          state.key, unhex(data.data));
      } catch (e) {
        this._fail(key, peerId, transferId, 'chunk failed authentication');
        return;
      }
      if (this._transfers.get(key) !== state || state.chunks.has(idx)) return;
      state.receivedBytes += decrypted.byteLength;
      if (state.receivedBytes > state.fileSize) {
        this._fail(key, peerId, transferId, 'more data than the header declared');
        return;
      }
      state.chunks.set(idx, decrypted);
      state.receivedChunks++;
      this.emit('progress', { transferId, peerId, progress: Math.min(100, (state.receivedChunks / state.totalChunks) * 100) });
    } else if (data.type === 'file-done') {
      const state = this._transfers.get(key);
      if (!state) return;
      if (state.receivedChunks !== state.totalChunks || state.receivedBytes !== state.fileSize) {
        this._fail(key, peerId, transferId, `incomplete transfer (${state.receivedChunks}/${state.totalChunks} chunks)`);
        return;
      }
      const chunks = [];
      for (let i = 0; i < state.totalChunks; i++) chunks.push(state.chunks.get(i));
      // Drop the state (and the plaintext chunks it holds) now that the blob owns the bytes.
      this._transfers.delete(key);
      const url = URL.createObjectURL(new Blob(chunks, { type: state.mimeType }));
      this.emit('complete', {
        transferId,
        peerId,
        file: { name: state.fileName, size: state.fileSize, type: state.mimeType, url },
      });
    }
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.FileTransfer = FileTransfer;
  globalThis.GhostLinkP2P = globalThis.GhostLinkP2P || {};
  globalThis.GhostLinkP2P.FileTransfer = FileTransfer;
}
