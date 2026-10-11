/**
 * GhostLink Mobile — Fragment Distributor
 *
 * Mobile implementation of fragment distribution using Shamir Secret Sharing.
 * This module provides the same interface as recovery/distributor.js but
 * adapted for mobile with local storage and P2P transport.
 */

import {storage} from '../utils/storage';
import RecoveryTransport from './RecoveryTransport';
import {CryptoEngine} from '../utils/crypto';
import {
  GUARDIAN_RECOVERY_AVAILABLE,
  GUARDIAN_RECOVERY_UNAVAILABLE_REASON,
} from '../utils/capabilities';

const STORAGE_KEY = '@ghostlink/recovery-fragments';
const DEFAULT_TIMEOUT = 6000;

const MSG = Object.freeze({
  STORE: 'gl:store',
  STORE_ACK: 'gl:store:ack',
  FETCH: 'gl:fetch',
  FETCH_RES: 'gl:fetch:res',
  EXISTS: 'gl:exists',
  EXISTS_RES: 'gl:exists:res',
  REVOKE: 'gl:revoke',
  REVOKE_ACK: 'gl:revoke:ack',
});

class FragmentStore {
  constructor() {
    this._fragments = new Map();
    this._load();
  }

  async _load() {
    try {
      const data = await storage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        for (const [key, value] of Object.entries(parsed)) {
          if (Date.now() < value.expiresAt) {
            this._fragments.set(key, value);
          }
        }
      }
    } catch (e) {
      console.warn('[FragmentStore] Load failed:', e);
    }
  }

  async _persist() {
    try {
      const obj = Object.fromEntries(this._fragments);
      await storage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('[FragmentStore] Persist failed:', e);
    }
  }

  store(tag, encodedFragment, ttl = 30 * 24 * 60 * 60 * 1000) {
    const xCoord = parseInt(encodedFragment.slice(2, 4), 16);
    const key = `${tag}:${xCoord}`;
    const entry = {
      encodedFragment,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    this._fragments.set(key, entry);
    this._persist();
    return true;
  }

  fetchAll(tag) {
    return [...this._fragments.entries()]
      .filter(([k]) => k.startsWith(`${tag}:`))
      .filter(([, v]) => Date.now() < v.expiresAt)
      .map(([, v]) => v.encodedFragment);
  }

  has(tag) {
    return [...this._fragments.entries()]
      .some(([k, v]) => k.startsWith(`${tag}:`) && Date.now() < v.expiresAt);
  }

  revoke(tag) {
    let count = 0;
    for (const key of [...this._fragments.keys()]) {
      if (key.startsWith(`${tag}:`)) {
        this._fragments.delete(key);
        count++;
      }
    }
    this._persist();
    return count;
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, val] of [...this._fragments.entries()]) {
      if (now >= val.expiresAt) {
        this._fragments.delete(key);
        changed = true;
      }
    }
    if (changed) this._persist();
  }
}

class MobileDistributor {
  constructor() {
    this._transport = null;
    this._store = new FragmentStore();
    this._webrtc = null;
  }

  useWebRTC(webrtcService) {
    this._webrtc = webrtcService;
    this._transport = new RecoveryTransport(webrtcService);
    this._transport.onMessage((peerId, msg) => this._handleIncoming(peerId, msg));
  }

  _handleIncoming(peerId, msg) {
    if (!msg?.type) return null;

    switch (msg.type) {
      case MSG.STORE: {
        // Never acknowledge holding a fragment this build does not keep for
        // guardian recovery: the sender would count it as a safe backup.
        if (!GUARDIAN_RECOVERY_AVAILABLE) {
          return {type: MSG.STORE_ACK, id: msg.id, payload: {ok: false}};
        }
        const {tag, fragment, ttl} = msg.payload;
        this._store.store(tag, fragment, ttl);
        return {type: MSG.STORE_ACK, id: msg.id, payload: {ok: true}};
      }
      case MSG.FETCH: {
        const {tag} = msg.payload;
        const fragments = this._store.fetchAll(tag);
        return {
          type: MSG.FETCH_RES,
          id: msg.id,
          payload: {fragment: fragments[0] ?? null},
        };
      }
      case MSG.EXISTS: {
        const {tag} = msg.payload;
        return {
          type: MSG.EXISTS_RES,
          id: msg.id,
          payload: {exists: this._store.has(tag)},
        };
      }
      case MSG.REVOKE: {
        const {tag} = msg.payload;
        const count = this._store.revoke(tag);
        return {type: MSG.REVOKE_ACK, id: msg.id, payload: {deleted: count}};
      }
      default:
        return null;
    }
  }

  async distribute(encryptedBlob, peers, opts = {}) {
    if (!GUARDIAN_RECOVERY_AVAILABLE) {
      throw new Error(GUARDIAN_RECOVERY_UNAVAILABLE_REASON);
    }
    if (!this._transport) {
      throw new Error('WebRTC not configured. Call useWebRTC() first.');
    }

    const {n = 5, k = 3, ttl = 30 * 24 * 60 * 60 * 1000, timeout = DEFAULT_TIMEOUT} = opts;

    if (peers.length < n) {
      throw new RangeError(`Need ${n} peers but only ${peers.length} provided.`);
    }
    if (k > n) throw new RangeError(`k (${k}) cannot exceed n (${n})`);

    const tag = encryptedBlob.tag;
    const dataBytes = new TextEncoder().encode(JSON.stringify(encryptedBlob));
    const fragments = CryptoEngine.ShamirSSS.split(dataBytes, n, k);

    const chosen = peers.slice(0, n);
    const results = await Promise.allSettled(
      chosen.map(async (peer, i) => {
        const encoded = this._encodeFragment(fragments[i]);
        const ack = await this._transport.request(
          peer.id,
          {type: MSG.STORE, id: this._generateMsgId(), payload: {tag, fragment: encoded, ttl}},
          timeout,
        );
        // A reply is not a store: only an explicit ok counts as held.
        if (ack?.type !== MSG.STORE_ACK || ack.payload?.ok !== true) {
          throw new Error('peer did not store the fragment');
        }
        return peer.id;
      }),
    );

    const stored = results.filter(r => r.status === 'fulfilled');
    const failed = results
      .map((r, i) =>
        r.status === 'rejected'
          ? {peerId: chosen[i].id, reason: r.reason?.message || 'unknown'}
          : null,
      )
      .filter(Boolean);

    return {
      ok: stored.length >= k,
      stored: stored.length,
      needed: k,
      failed,
    };
  }

  async recover(tag, peers, opts = {}) {
    if (!GUARDIAN_RECOVERY_AVAILABLE) {
      throw new Error(GUARDIAN_RECOVERY_UNAVAILABLE_REASON);
    }
    if (!this._transport) {
      throw new Error('WebRTC not configured. Call useWebRTC() first.');
    }

    const {k = 3, timeout = DEFAULT_TIMEOUT} = opts;
    const fragments = [];

    await Promise.allSettled(
      peers.map(async peer => {
        try {
          const res = await this._transport.request(
            peer.id,
            {type: MSG.FETCH, id: this._generateMsgId(), payload: {tag}},
            timeout,
          );
          if (res?.payload?.fragment) {
            fragments.push(this._decodeFragment(res.payload.fragment));
          }
        } catch (_) {}
      }),
    );

    if (fragments.length < k) {
      throw new Error(
        `Recovery failed: collected ${fragments.length} fragment(s), need ${k}.`,
      );
    }

    const reconstructed = CryptoEngine.ShamirSSS.combine(fragments.slice(0, k));
    return JSON.parse(new TextDecoder().decode(reconstructed));
  }

  async probe(tag, peers, opts = {}) {
    if (!this._transport) {
      throw new Error('WebRTC not configured. Call useWebRTC() first.');
    }

    const {timeout = DEFAULT_TIMEOUT} = opts;
    return Promise.all(
      peers.map(async peer => {
        const start = Date.now();
        try {
          const res = await this._transport.request(
            peer.id,
            {type: MSG.EXISTS, id: this._generateMsgId(), payload: {tag}},
            timeout,
          );
          return {
            peerId: peer.id,
            reachable: true,
            hasFragment: !!res?.payload?.exists,
            latencyMs: Date.now() - start,
          };
        } catch (_) {
          return {
            peerId: peer.id,
            reachable: false,
            hasFragment: false,
            latencyMs: Date.now() - start,
          };
        }
      }),
    );
  }

  _generateMsgId() {
    return `m${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  _encodeFragment(share) {
    const {x, y} = share;
    const yHex = Array.from(y).map(b => b.toString(16).padStart(2, '0')).join('');
    return `01${x.toString(16).padStart(2, '0')}${yHex}`;
  }

  _decodeFragment(encoded) {
    const bytes = encoded.match(/.{2}/g).map(b => parseInt(b, 16));
    return {x: bytes[1], y: new Uint8Array(bytes.slice(2))};
  }
}

const distributor = new MobileDistributor();

export {distributor, MobileDistributor, FragmentStore};
export default distributor;
