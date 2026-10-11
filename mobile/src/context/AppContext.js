/**
 * GhostLink Mobile — Global Application Context
 *
 * Centralized state for identity, peers, messages, settings,
 * and connection status. Persistent state goes through utils/storage.js:
 * secret values are sealed before they reach AsyncStorage.
 * Peers and messages use Map for O(1) lookups.
 */

import WebRTCService from '../services/WebRTCService';
import {DEFAULT_SETTINGS, parseStoredState} from '../utils/settings-migration';
import {BUNDLE_STORAGE_KEY, FRAGMENTS_STORAGE_KEY, assessLegacyRecovery, finishLegacyMigration} from '../utils/recovery';
import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {storage} from '../utils/storage';

// ─── Storage Keys ────────────────────────────────────────────
const STORAGE_KEYS = {
  IDENTITY: '@ghostlink/identity',
  MESSAGES: '@ghostlink/messages',
  SETTINGS: '@ghostlink/settings',
  PEERS: '@ghostlink/peers',
  GHOST_MESH: '@ghostlink/ghost_mesh',
};

/**
 * Everything else this identity writes to AsyncStorage outside the reducer
 * (the recovery bundle and fragments), cleared on wipe and restore.
 */
const IDENTITY_SCOPED_EXTRA_KEYS = [
  BUNDLE_STORAGE_KEY,
  FRAGMENTS_STORAGE_KEY,
  'gl_invite_code', // SetupScreen
  'gl_wrapped_privkey', // 0.0.0-0.0.2
  'gl_seed_check', // 0.0.0-0.0.2
];

/** Shares other people asked this device to hold (MobileDistributor). */
const HELD_FRAGMENTS_KEY = '@ghostlink/recovery-fragments';

/** What "Wipe All Data" removes from AsyncStorage. */
const WIPE_KEYS = [
  ...Object.values(STORAGE_KEYS),
  ...IDENTITY_SCOPED_EXTRA_KEYS,
  HELD_FRAGMENTS_KEY,
];

/** What installing a different identity removes; settings stay. */
const IDENTITY_SCOPED_KEYS = [
  STORAGE_KEYS.MESSAGES,
  STORAGE_KEYS.PEERS,
  STORAGE_KEYS.GHOST_MESH,
  ...IDENTITY_SCOPED_EXTRA_KEYS,
];

// ─── Initial State ───────────────────────────────────────────
const INITIAL_STATE = {
  identity: null, // { name, publicKeyHex, fingerprint, ghostAddress, ... } — never a private key
  peers: new Map(), // peerId -> { id, name, publicKeyHex, fingerprint, online, lastSeen }
  messages: new Map(), // roomId -> [{ id, sender, text, timestamp, type, status }]
  settings: {...DEFAULT_SETTINGS},
  connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
  ghostMesh: {
    enabled: false,
    address: '',       // Yggdrasil IPv6 address
    publicKeyHex: '',  // X25519 public key hex
    status: 'not_configured', // 'not_configured' | 'configured' | 'active'
  },
  /**
   * Older recovery data kept until the user confirms their phrase:
   * {state: 'none' | 'resolved' | 'needs-phrase', present?: string[]}.
   */
  legacyRecovery: {state: 'none'},
};

// ─── Action Types ────────────────────────────────────────────
const Actions = {
  SET_IDENTITY: 'SET_IDENTITY',
  ADD_PEER: 'ADD_PEER',
  UPDATE_PEER: 'UPDATE_PEER',
  REMOVE_PEER: 'REMOVE_PEER',
  ADD_MESSAGE: 'ADD_MESSAGE',
  UPDATE_MESSAGE: 'UPDATE_MESSAGE',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  SET_CONNECTION_STATUS: 'SET_CONNECTION_STATUS',
  SET_GHOST_MESH: 'SET_GHOST_MESH',
  CLEAR_GHOST_MESH: 'CLEAR_GHOST_MESH',
  RESTORE_STATE: 'RESTORE_STATE',
  WIPE_ALL: 'WIPE_ALL',
  CLEAR_IDENTITY_DATA: 'CLEAR_IDENTITY_DATA',
  SET_LEGACY_RECOVERY: 'SET_LEGACY_RECOVERY',
};

// ─── Map Serialisation Helpers ───────────────────────────────

function mapToObject(map) {
  const obj = {};
  for (const [key, value] of map.entries()) {
    obj[key] = value;
  }
  return obj;
}

function objectToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      map.set(key, obj[key]);
    }
  }
  return map;
}

/**
 * The identity as app state may hold it: no private key.
 *
 * The key lives in the keystore. Restore paths hand setIdentity an object
 * carrying privateKeyRaw, so it is stripped before the identity is persisted.
 * Hydration re-persists through here, scrubbing copies older builds saved.
 */
function withoutSecrets(identity) {
  if (!identity || typeof identity !== 'object') return identity;
  const {keyPair, privateKeyRaw, privateKey, seedPhrase, ...rest} = identity;
  return rest;
}

// ─── Reducer ─────────────────────────────────────────────────

function appReducer(state, action) {
  switch (action.type) {
    case Actions.SET_IDENTITY:
      return {...state, identity: withoutSecrets(action.payload)};

    case Actions.ADD_PEER: {
      const nextPeers = new Map(state.peers);
      nextPeers.set(action.payload.id, action.payload);
      return {...state, peers: nextPeers};
    }

    case Actions.UPDATE_PEER: {
      // Pin and mute dispatch this. Without a case here the reducer fell
      // through to `default` and returned state unchanged, so both buttons
      // animated and then did nothing.
      const existing = state.peers.get(action.payload.id);
      if (!existing) return state;
      const nextPeers = new Map(state.peers);
      nextPeers.set(action.payload.id, {...existing, ...action.payload});
      return {...state, peers: nextPeers};
    }

    case Actions.REMOVE_PEER: {
      // The conversation (and its persisted history) goes with the peer.
      const removed = state.peers.get(action.payload);
      const nextPeers = new Map(state.peers);
      nextPeers.delete(action.payload);
      const nextMessages = new Map(state.messages);
      nextMessages.delete(action.payload);
      if (removed?.roomId) nextMessages.delete(removed.roomId);
      return {...state, peers: nextPeers, messages: nextMessages};
    }

    case Actions.ADD_MESSAGE: {
      const {roomId, message} = action.payload;
      const nextMessages = new Map(state.messages);
      const existing = nextMessages.get(roomId) || [];
      nextMessages.set(roomId, [...existing, message]);
      return {...state, messages: nextMessages};
    }

    /** Amend a message already in the list (mostly its delivery status). */
    case Actions.UPDATE_MESSAGE: {
      const {roomId, messageId, patch} = action.payload;
      const existing = state.messages.get(roomId);
      if (!existing) return state;
      let changed = false;
      const updated = existing.map(m => {
        if (m.id !== messageId) return m;
        changed = true;
        return {...m, ...patch};
      });
      if (!changed) return state;
      const nextMessages = new Map(state.messages);
      nextMessages.set(roomId, updated);
      return {...state, messages: nextMessages};
    }

    case Actions.UPDATE_SETTINGS:
      return {
        ...state,
        settings: {...state.settings, ...action.payload},
      };

    case Actions.SET_CONNECTION_STATUS:
      return {...state, connectionStatus: action.payload};

    case Actions.SET_GHOST_MESH:
      return {
        ...state,
        ghostMesh: {...state.ghostMesh, ...action.payload},
      };

    case Actions.CLEAR_GHOST_MESH:
      return {
        ...state,
        ghostMesh: {
          enabled: false,
          address: '',
          publicKeyHex: '',
          status: 'not_configured',
        },
      };

    case Actions.RESTORE_STATE: {
      const next = {...state, ...action.payload};
      if ('identity' in action.payload) next.identity = withoutSecrets(action.payload.identity);
      return next;
    }

    // Everything the previous identity owned, without touching the
    // preferences that belong to the person holding the phone.
    case Actions.CLEAR_IDENTITY_DATA:
      return {
        ...state,
        peers: new Map(),
        messages: new Map(),
        ghostMesh: {enabled: false, address: '', publicKeyHex: '', status: 'not_configured'},
      };

    case Actions.SET_LEGACY_RECOVERY:
      return {...state, legacyRecovery: action.payload};

    case Actions.WIPE_ALL:
      return {
        ...INITIAL_STATE,
        settings: {...DEFAULT_SETTINGS},
        peers: new Map(),
        messages: new Map(),
        ghostMesh: {
          enabled: false,
          address: '',
          publicKeyHex: '',
          status: 'not_configured',
        },
      };

    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────────
const AppContext = createContext(null);

function AppProvider({children}) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const hydrated = useRef(false);

  // ── Hydrate from AsyncStorage on mount ──
  /**
   * Point the transport at this device's identity (needed to derive direct-path
   * session keys) and, if configured, a Ghost Mesh bridge.
   */
  useEffect(() => {
    const localId = state.identity?.fingerprint || state.identity?.publicKeyHex || null;
    if (localId) WebRTCService.setLocalPeerId(localId);
  }, [state.identity]);

  useEffect(() => {
    const url = (state.settings?.meshBridgeUrl || '').trim();
    // No seed is available here: the recovery phrase is kept out of app state.
    // Until an explicit unlock supplies it, the transport reports 'needs-unlock'.
    WebRTCService.setMeshBridge(url || null, null);
  }, [state.settings?.meshBridgeUrl]);

  useEffect(() => {
    (async () => {
      // Upgrade first: seal plaintext secrets, delete the retired
      // Shamir fragments and invite code. Restartable; a failure here is
      // logged and the reads below still seal lazily.
      try {
        const report = await storage.migrate();
        if (report.sealed.length || report.deleted.length) {
          console.log(`[AppContext] storage upgraded: sealed ${report.sealed.join(', ') || 'nothing'}; deleted ${report.deleted.join(', ') || 'nothing'}`);
        }
      } catch (err) {
        console.error('[AppContext] storage upgrade did not complete:', err && err.message);
      }

      // Older recovery copies: deleted only when nothing depends on them;
      // otherwise kept (sealed) and the user is asked for the phrase.
      try {
        const legacy = await assessLegacyRecovery();
        if (legacy.state !== 'none') {
          console.log(`[AppContext] older recovery data: ${legacy.state}${legacy.how ? ` (${legacy.how})` : ''}`);
          dispatch({type: Actions.SET_LEGACY_RECOVERY, payload: legacy});
        }
      } catch (err) {
        console.error('[AppContext] could not assess older recovery data (kept):', err && err.message);
      }

      // Each key on its own: one unreadable value must not blank the others.
      const read = async key => {
        try {
          return await storage.getItem(key);
        } catch (err) {
          console.error(`[AppContext] ${key} could not be read:`, err && err.message);
          return null;
        }
      };
      const raw = {
        rawIdentity: await read(STORAGE_KEYS.IDENTITY),
        rawMessages: await read(STORAGE_KEYS.MESSAGES),
        rawSettings: await read(STORAGE_KEYS.SETTINGS),
        rawPeers: await read(STORAGE_KEYS.PEERS),
        rawGhostMesh: await read(STORAGE_KEYS.GHOST_MESH),
      };

      const {restored, lost} = parseStoredState(
        {
          identity: raw.rawIdentity,
          messages: raw.rawMessages,
          settings: raw.rawSettings,
          peers: raw.rawPeers,
          ghostMesh: raw.rawGhostMesh,
        },
        objectToMap,
      );

      if (lost.length > 0) {
        console.error(
          `[AppContext] ${lost.join(', ')} could not be read and were skipped. ` +
          'The stored data has been left untouched.',
        );
      }

      if (Object.keys(restored).length > 0) {
        dispatch({type: Actions.RESTORE_STATE, payload: restored});
      }
      hydrated.current = true;
    })();
  }, []);

  // ── Persist identity ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    if (state.identity) {
      storage.setItem(
        STORAGE_KEYS.IDENTITY,
        JSON.stringify(withoutSecrets(state.identity)),
      ).catch(() => {});
    } else {
      storage.removeItem(STORAGE_KEYS.IDENTITY).catch(() => {});
    }
  }, [state.identity]);

  // ── Persist messages ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    storage.setItem(
      STORAGE_KEYS.MESSAGES,
      JSON.stringify(mapToObject(state.messages)),
    ).catch(() => {});
  }, [state.messages]);

  // ── Persist settings ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    storage.setItem(
      STORAGE_KEYS.SETTINGS,
      JSON.stringify(state.settings),
    ).catch(() => {});
  }, [state.settings]);

  // ── Persist peers ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    storage.setItem(
      STORAGE_KEYS.PEERS,
      JSON.stringify(mapToObject(state.peers)),
    ).catch(() => {});
  }, [state.peers]);

  // ── Persist ghostMesh ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    storage.setItem(
      STORAGE_KEYS.GHOST_MESH,
      JSON.stringify(state.ghostMesh),
    ).catch(() => {});
  }, [state.ghostMesh]);

  // ── Bound Actions ──

  const setIdentity = useCallback(identity => {
    dispatch({type: Actions.SET_IDENTITY, payload: identity});
  }, []);

  const addPeer = useCallback(peer => {
    dispatch({type: Actions.ADD_PEER, payload: peer});
  }, []);

  const removePeer = useCallback(peerId => {
    dispatch({type: Actions.REMOVE_PEER, payload: peerId});
  }, []);

  const addMessage = useCallback((roomId, message) => {
    dispatch({
      type: Actions.ADD_MESSAGE,
      payload: {roomId, message},
    });
  }, []);

  const updateMessage = useCallback((roomId, messageId, patch) => {
    dispatch({
      type: Actions.UPDATE_MESSAGE,
      payload: {roomId, messageId, patch},
    });
  }, []);

  const updateSettings = useCallback(partial => {
    dispatch({type: Actions.UPDATE_SETTINGS, payload: partial});
  }, []);

  const setConnectionStatus = useCallback(status => {
    dispatch({type: Actions.SET_CONNECTION_STATUS, payload: status});
  }, []);

  /**
   * Remove this identity and everything derived from it from this device,
   * including the keystore key (CryptoEngine.clearKeys). Reports what was and
   * was not removed.
   *
   * @returns {Promise<{ok: boolean, cleared: string[], failed: string[]}>}
   */
  const wipeAll = useCallback(async () => {
    const cleared = [];
    const failed = [];

    try {
      await storage.multiRemove(WIPE_KEYS);
      cleared.push('messages', 'settings', 'peer cache', 'mesh state', 'recovery backup');
    } catch (err) {
      console.warn('[AppContext] wipe: local store failed:', err);
      failed.push('local store');
    }

    // Forget the data key, separately: if the removal above failed, this is
    // what still makes the sealed values left behind unreadable.
    try {
      await storage.forgetKey();
      cleared.push('storage key');
    } catch (err) {
      console.warn('[AppContext] wipe: storage key failed:', err);
      failed.push('storage key');
    }

    // The part that actually matters.
    try {
      // clearKeys is a member of CryptoEngine (the default export), not a
      // named export — destructuring it off the module gives undefined.
      const {default: CryptoEngine} = await import('../utils/crypto');
      const gone = await CryptoEngine.clearKeys();
      if (gone) cleared.push('identity key');
      else failed.push('identity key');
    } catch (err) {
      console.warn('[AppContext] wipe: keystore failed:', err);
      failed.push('identity key');
    }

    dispatch({type: Actions.WIPE_ALL});
    return {ok: failed.length === 0, cleared, failed};
  }, []);

  /**
   * Drop everything tied to the previous identity before a restore, keeping
   * only app preferences (text size, theme).
   *
   * @returns {Promise<void>}
   */
  const clearIdentityScopedData = useCallback(async () => {
    try {
      await storage.multiRemove(IDENTITY_SCOPED_KEYS);
    } catch (err) {
      // Non-fatal: the restore still has to complete, and leaving stale rows
      // is better than refusing to restore the identity at all. Say so.
      console.warn('[AppContext] could not clear prior identity data:', err);
    }
    dispatch({type: Actions.CLEAR_IDENTITY_DATA});
  }, []);

  /**
   * The user confirms their recovery phrase: verified, re-wrapped into a
   * modern bundle, and only then are the older copies deleted.
   * Throws (with a RecoveryError code) and deletes nothing on a wrong phrase.
   */
  const confirmRecoveryPhrase = useCallback(async words => {
    const result = await finishLegacyMigration(words, {
      name: state.identity?.name || '',
      ghostAddress: state.identity?.ghostAddress || '',
    });
    dispatch({type: Actions.SET_LEGACY_RECOVERY, payload: {state: 'resolved', how: 'phrase-confirmed', deleted: result.deleted}});
    return result;
  }, [state.identity]);

  const setGhostMesh = useCallback(meshData => {
    dispatch({type: Actions.SET_GHOST_MESH, payload: meshData});
  }, []);

  const clearGhostMesh = useCallback(() => {
    dispatch({type: Actions.CLEAR_GHOST_MESH});
  }, []);

  const value = {
    // Both shapes are exposed: some screens read the flattened fields, others
    // destructure `{state, dispatch}`.
    state,
    dispatch,

    // State
    identity: state.identity,
    peers: state.peers,
    messages: state.messages,
    settings: state.settings,
    connectionStatus: state.connectionStatus,
    ghostMesh: state.ghostMesh,
    legacyRecovery: state.legacyRecovery,

    // Actions
    setIdentity,
    addPeer,
    removePeer,
    addMessage,
    updateMessage,
    updateSettings,
    setConnectionStatus,
    setGhostMesh,
    clearGhostMesh,
    wipeAll,
    clearIdentityScopedData,
    confirmRecoveryPhrase,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside <AppProvider>');
  }
  return ctx;
}

export {AppProvider, useApp, DEFAULT_SETTINGS, STORAGE_KEYS, WIPE_KEYS, IDENTITY_SCOPED_KEYS};
export default AppContext;
