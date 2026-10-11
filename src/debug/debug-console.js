// GhostLinkDebug — Production debug console (ENHANCED)
// Accessible via window.GhostLinkDebug
(function(exports) {
  'use strict';

  // ── Console interception (module-level singleton) ────────────────────────
  // Exactly one set of wrappers is installed however many GhostLinkDebug
  // instances exist, so messages are not duplicated and restoreConsole()
  // reinstates the native methods.

  const CONSOLE_LEVELS = { log: 'info', error: 'error', warn: 'warn', debug: 'debug' };

  // Every live instance, so ownership can be handed over instead of the
  // wrappers being torn out from under instances that are still running.
  const _instances = new Set();
  let _consoleOwner = null;
  let _nativeConsole = null;
  let _consoleWrappers = null;
  let _logging = false;

  // Serialize each argument independently, fully guarded, so one hostile
  // value (circular ref, throwing getter, Proxy, BigInt) cannot drop the message.
  const _fmtOne = (a) => {
    if (typeof a === 'string') return a;
    try {
      if (a === null || typeof a !== 'object') return String(a);
      // Stringify inside the guard: `stack` is a writable property and may hold
      // an object whose toString throws, which would otherwise blow up later in
      // _fmt's join() — outside this try — and drop the whole message.
      if (a instanceof Error) return a.stack ? String(a.stack) : `${a.name}: ${a.message}`;
      const seen = new WeakSet();
      return JSON.stringify(a, (k, v) => {
        if (typeof v === 'bigint') return `${v}n`;
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      }, 2);
    } catch (e) {
      try { return String(a); } catch (e2) { return '[unserializable]'; }
    }
  };

  const _fmt = (args) => `[GhostLink Debug] ${args.map(_fmtOne).join(' ')}`;

  function _installWrappers() {
    _nativeConsole = {};
    _consoleWrappers = {};
    Object.keys(CONSOLE_LEVELS).forEach((name) => {
      const orig = console[name];
      const level = CONSOLE_LEVELS[name];
      _nativeConsole[name] = orig;
      const wrapper = (...args) => {
        orig.apply(console, args);
        const log = _consoleOwner && _consoleOwner._log;
        // With no GhostLink logger configured, _log falls back to console
        // itself — forwarding there would print every message a second time.
        if (!log || log === console) return;
        if (_logging) return;
        _logging = true;
        try { log[level](_fmt(args)); } catch (e) { } finally { _logging = false; }
      };
      _consoleWrappers[name] = wrapper;
      console[name] = wrapper;
    });
  }

  function _uninstallWrappers() {
    if (!_nativeConsole) return;
    Object.keys(_nativeConsole).forEach((name) => {
      // Only restore where our wrapper is still the installed method; something
      // else may have patched console after us.
      if (console[name] === _consoleWrappers[name]) console[name] = _nativeConsole[name];
    });
    _nativeConsole = null;
    _consoleWrappers = null;
  }

  /** Register an instance; the first one installs the wrappers. */
  function _attachInstance(inst) {
    _instances.add(inst);
    if (!_consoleOwner) {
      _consoleOwner = inst;
      _installWrappers();
    }
    return _consoleOwner === inst;
  }

  /**
   * Unregister an instance, handing console ownership to a remaining one.
   * Native methods return only when the last instance is gone.
   */
  function _detachInstance(inst) {
    if (!_instances.delete(inst)) return;
    if (_consoleOwner !== inst) return;
    const next = _instances.values().next().value || null;
    if (next) {
      _consoleOwner = next;
      next._ownsConsole = true;
      return;
    }
    _uninstallWrappers();
    _consoleOwner = null;
  }

  class GhostLinkDebug {
    constructor() {
      this._peers = {};
      this._channels = {};
      this._events = [];
      this._maxEvents = 500;
      this._startTime = Date.now();
      this._connMgr = null;
      this._sigMgr = null;
      this._peerMgr = null;
      this._msgRouter = null;
      this._ftMgr = null;
      this._relayMgr = null;
      this._bus = (window.GhostLink && window.GhostLink.globalBus) || null;
      this._log = (window.GhostLink && window.GhostLink.log) || console;
      this._floatable = false;
      this._floatWindow = null;

      if (this._bus) {
        this._bus.wiretap((topic, data) => {
          this._events.push({ topic, data, ts: Date.now() });
          if (this._events.length > this._maxEvents) this._events.shift();
        });
      }

      this._installConsole();
    }

    setConnectionManager(cm) { this._connMgr = cm; }
    setSignalManager(sm) { this._sigMgr = sm; }
    setPeerManager(pm) { this._peerMgr = pm; }
    setMessageRouter(mr) { this._msgRouter = mr; }
    setFileTransferManager(ftm) { this._ftMgr = ftm; }
    setRelayManager(rm) { this._relayMgr = rm; }

    // ── Floatable UI ──────────────────────────────────────────────────────

    isFloatable() { return this._floatable; }

    attach() {
      if (this._floatWindow && !this._floatWindow.closed) {
        this._floatWindow.focus();
        return;
      }
      this._floatable = true;
      this._openFloatWindow();
    }

    detach() {
      this._floatable = false;
      if (this._floatWindow && !this._floatWindow.closed) {
        this._floatWindow.close();
      }
      this._floatWindow = null;
    }

    _openFloatWindow() {
      if (typeof window === 'undefined') return;
      const w = window.open('', 'GhostLinkDebug', 'width=600,height=700,resizable=yes,scrollbars=yes');
      if (!w) return;
      this._floatWindow = w;
      this._renderFloatWindow(w);
      this._floatInterval = setInterval(() => this._renderFloatWindow(w), 2000);
      w.addEventListener('beforeunload', () => this.detach());
    }

    _renderFloatWindow(w) {
      if (!w || w.closed) return;
      const state = this.dumpFullState();
      // Topics, payloads and peer names come from off-device and this document
      // is written into a same-origin window: escape every interpolated value.
      const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]
      ));
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>GhostLink Debug</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 10px; margin: 0; }
    h2 { color: #00d4ff; margin-top: 20px; border-bottom: 1px solid #333; }
    .panel { background: #16213e; padding: 10px; margin: 5px 0; border-radius: 4px; }
    .stat { display: flex; justify-content: space-between; padding: 2px 0; }
    .label { color: #aaa; }
    .value { color: #00ff88; }
    .warn { color: #ff6b6b; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 4px; text-align: left; border-bottom: 1px solid #333; }
    th { color: #00d4ff; }
    button { background: #0f3460; color: #fff; border: none; padding: 8px 12px; cursor: pointer; margin: 2px; border-radius: 4px; }
    button:hover { background: #165a96; }
    pre { overflow-x: auto; max-height: 200px; background: #0d1b2a; padding: 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>GhostLink Debug Console</h1>
  <button onclick="window.debug.detach()">Detach</button>
  <button onclick="window.debug.refreshFloat()">Refresh</button>

  <h2>Network</h2>
  <div class="panel">
    <div class="stat"><span class="label">Signal Connected:</span><span class="value">${state.network.signalConnected}</span></div>
    <div class="stat"><span class="label">Room:</span><span class="value">${esc(state.network.myRoom || 'none')}</span></div>
    <div class="stat"><span class="label">Uptime:</span><span class="value">${Math.floor(state.uptime / 1000)}s</span></div>
  </div>

  <h2>Peers (${state.networkStats.totalPeers})</h2>
  <div class="panel">
    <div class="stat"><span class="label">Connected:</span><span class="value">${state.networkStats.connectedPeers}</span></div>
    <div class="stat"><span class="label">Relay Mode:</span><span class="value">${state.networkStats.relayModeCount}</span></div>
    <div class="stat"><span class="label">Known:</span><span class="value">${state.network.knownPeers.length}</span></div>
  </div>

  <h2>Memory</h2>
  <div class="panel">
    ${state.memory ? `
    <div class="stat"><span class="label">JS Heap:</span><span class="value">${(state.memory.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB</span></div>
    <div class="stat"><span class="label">Total Heap:</span><span class="value">${(state.memory.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB</span></div>
    ` : '<span class="warn">Memory API not available</span>'}
  </div>

  <h2>Message Router</h2>
  <div class="panel">
    <div class="stat"><span class="label">In-Flight:</span><span class="value">${state.messageRouter?.inFlightCount || 0}</span></div>
    <div class="stat"><span class="label">Offline Queue:</span><span class="value">${state.messageRouter?.offlineCount || 0}</span></div>
    <div class="stat"><span class="label">Delivered:</span><span class="value">${state.messageRouter?.deliveredCount || 0}</span></div>
  </div>

  <h2>Recent Events</h2>
  <table>
    <tr><th>Time</th><th>Topic</th><th>Data</th></tr>
    ${state.eventTimeline.slice(0, 20).map(e => `<tr><td>${esc(new Date(e.ts).toLocaleTimeString())}</td><td>${esc(e.topic)}</td><td>${esc(JSON.stringify(e.data || {}).slice(0, 40))}...</td></tr>`).join('')}
  </table>

  <h2>Connection States</h2>
  <pre>${esc(JSON.stringify(state.connectionStates, null, 2))}</pre>

  <script>window.debug = window.opener?.GhostLinkDebug;</script>
</body>
</html>`;
      w.document.write(html);
      w.document.close();
    }

    refreshFloat() {
      if (this._floatWindow && !this._floatWindow.closed) {
        this._renderFloatWindow(this._floatWindow);
      }
    }

    // ── Peer Inspection (requested API) ───────────────────────────────────

    inspectPeers() {
      const result = [];
      if (this._peerMgr) {
        const info = this._peerMgr.getAllPeerInfo?.() || {};
        Object.entries(info).forEach(([id, p]) => {
          const pc = this._connMgr?.getPeerConnection(id);
          const quality = this._connMgr?.getQuality(id);
          const mode = pc?.__mode || 'unknown';
          const lastSeen = pc?.__createdAt ? Date.now() - pc.__createdAt : null;
          result.push({
            id,
            state: this._peerMgr.getPeerState?.(id) || 'unknown',
            mode,
            quality: quality || 0,
            lastSeen,
            pcState: pc?.iceConnectionState || 'unknown',
          });
        });
      }
      return result;
    }

    // ── Channel Inspection (requested API) ────────────────────────────────

    inspectChannels(peerId) {
      if (!this._connMgr) return {};
      const dcs = this._connMgr.getDataChannels(peerId);
      if (!dcs) return {};
      return Object.fromEntries(
        Object.entries(dcs).map(([label, dc]) => [label, {
          readyState: dc?.readyState || 'unknown',
          bufferedAmount: dc?.bufferedAmount || 0,
          label: dc?.label || label,
          ordered: dc?.ordered,
          maxRetransmits: dc?.maxRetransmits,
          protocol: dc?.protocol || '',
        }])
      );
    }

    // ── Connection States (requested API) ────────────────────────────────

    dumpConnectionStates() {
      if (!this._connMgr) return {};
      const pcs = this._connMgr._pcs || {};
      return Object.fromEntries(
        Object.entries(pcs).map(([id, pc]) => [id, {
          iceState: pc.iceConnectionState,
          signalingState: pc.signalingState,
          iceGatheringState: pc.iceGatheringState,
          localDescription: pc.localDescription?.type || null,
          remoteDescription: pc.remoteDescription?.type || null,
          createdAt: pc.__createdAt || null,
          mode: pc.__mode || 'unknown',
        }])
      );
    }

    // ── Network Stats (requested API) ────────────────────────────────────

    getNetworkStats() {
      const peers = this.inspectPeers();
      const connStates = this.dumpConnectionStates();
      return {
        totalPeers: peers.length,
        connectedPeers: peers.filter(p => p.pcState === 'connected').length,
        relayModeCount: peers.filter(p => p.mode === 'relay').length,
        knownPeers: this._sigMgr?.peers?.() || [],
        signalConnected: this._sigMgr?.isConnected?.() || false,
        reconnectAttempts: this._sigMgr?._reconnectAttempt || 0,
      };
    }

    // ── Event Timeline (requested API) ────────────────────────────────────

    getEventTimeline(count = 100) {
      return this._events.slice(-count).map(e => ({
        topic: e.topic,
        data: e.data,
        timestamp: e.ts,
        age: Date.now() - e.ts,
      }));
    }

    // ── Memory Snapshot (requested API) ───────────────────────────────────

    getMemorySnapshot() {
      const perf = typeof performance !== 'undefined' ? performance.memory : null;
      if (!perf) return { available: false };
      return {
        available: true,
        usedJSHeapSize: perf.usedJSHeapSize,
        totalJSHeapSize: perf.totalJSHeapSize,
        jsHeapSizeLimit: perf.jsHeapSizeLimit,
        usedMB: (perf.usedJSHeapSize / 1024 / 1024).toFixed(2),
        totalMB: (perf.totalJSHeapSize / 1024 / 1024).toFixed(2),
        usagePercent: ((perf.usedJSHeapSize / perf.jsHeapSizeLimit) * 100).toFixed(1),
      };
    }

    // ── Full State Dump (requested API) ──────────────────────────────────

    dumpFullState() {
      const connStates = this.dumpConnectionStates();
      const msgRouter = this.messageRouter();
      const ftState = this.fileTransfers();
      const evtStats = this.eventStats();

      return {
        timestamp: new Date().toISOString(),
        uptime: this.uptime(),
        memory: this.getMemorySnapshot(),
        network: this.network(),
        networkStats: this.getNetworkStats(),
        peers: this.peers(),
        inspectPeers: this.inspectPeers(),
        connectionStates: connStates,
        inspectChannels: this._peerMgr ? Object.fromEntries(
          this.inspectPeers().map(p => [p.id, this.inspectChannels(p.id)])
        ) : {},
        messageRouter: msgRouter,
        fileTransfers: ftState,
        eventStats: evtStats,
        eventTimeline: this.getEventTimeline(100),
        relayManager: this._relayMgr ? {
          queueSize: this._relayMgr.queueSize || 0,
          relayPeers: Object.keys(this._relayMgr._relayPeers || {}),
        } : null,
      };
    }

    // ── Existing methods (preserved) ──────────────────────────────────────

    peers() {
      const result = {};
      if (this._peerMgr) {
        const info = this._peerMgr.getAllPeerInfo?.() || {};
        Object.entries(info).forEach(([id, p]) => {
          const pc = this._connMgr?.getPeerConnection(id);
          const quality = this._connMgr?.getQuality(id);
          const dcs = this._connMgr?.getDataChannels(id);
          result[id] = {
            ...p,
            pcState: pc?.iceConnectionState || 'unknown',
            signalingState: pc?.signalingState || 'unknown',
            quality,
            dataChannels: dcs ? Object.fromEntries(Object.entries(dcs).map(([k, v]) => [k, v?.readyState || 'unknown'])) : {},
            peerState: this._peerMgr.getPeerState?.(id) || 'unknown',
          };
        });
      }
      return result;
    }

    peer(id) {
      const all = this.peers();
      return all[id] || null;
    }

    channels(peerId) {
      if (!this._connMgr) return {};
      const dcs = this._connMgr.getDataChannels(peerId);
      if (!dcs) return {};
      return Object.fromEntries(
        Object.entries(dcs).map(([label, dc]) => [label, {
          readyState: dc?.readyState,
          bufferedAmount: dc?.bufferedAmount,
          bufferedAmountLowThreshold: dc?.bufferedAmountLowThreshold,
          label: dc?.label,
          ordered: dc?.ordered,
          maxRetransmits: dc?.maxRetransmits,
        }])
      );
    }

    allChannels() {
      const peers = this._connMgr ? Object.keys(this._connMgr._pcs || {}) : [];
      const result = {};
      peers.forEach(pid => { result[pid] = this.channels(pid); });
      return result;
    }

    connectionStates() {
      if (!this._connMgr) return {};
      const pcs = this._connMgr._pcs || {};
      return Object.fromEntries(
        Object.entries(pcs).map(([id, pc]) => [id, {
          iceState: pc.iceConnectionState,
          signalingState: pc.signalingState,
          iceGatheringState: pc.iceGatheringState,
          localDescription: pc.localDescription?.type,
          remoteDescription: pc.remoteDescription?.type,
          createdAt: pc.__createdAt,
          mode: pc.__mode,
        }])
      );
    }

    async stats(peerId) {
      if (!this._connMgr) return null;
      return this._connMgr.getStats?.(peerId) || null;
    }

    allStats() {
      const pcs = this._connMgr?._pcs || {};
      const result = {};
      Object.keys(pcs).forEach(async id => {
        result[id] = await this.stats(id);
      });
      return result;
    }

    messageRouter() {
      if (!this._msgRouter) return null;
      return {
        inFlight: this._msgRouter.inFlight || [],
        inFlightCount: this._msgRouter.inFlight?.size || 0,
        offlineCount: this._msgRouter.offlineCount || 0,
        deliveredCount: this._msgRouter.deliveredCount || 0,
      };
    }

    fileTransfers() {
      if (!this._ftMgr) return { active: [], pending: [] };
      return {
        active: this._ftMgr.getActiveTransfers?.() || [],
        pending: this._ftMgr.getPendingFiles?.() || [],
      };
    }

    events(limit = 100) {
      return this._events.slice(-limit).map(e => ({
        ...e,
        age: Date.now() - e.ts,
      }));
    }

    eventStats() {
      const counts = {};
      this._events.forEach(e => { counts[e.topic] = (counts[e.topic] || 0) + 1; });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([topic, count]) => ({ topic, count }));
    }

    network() {
      const sig = this._sigMgr;
      return {
        signalConnected: sig?.isConnected?.() || false,
        signalUrl: sig?._wsUrl || null,
        myRoom: sig?._myRoom || null,
        knownPeers: sig?.peers?.() || [],
        reconnectAttempt: sig?._reconnectAttempt || 0,
        open: sig?._open || false,
      };
    }

    memory() {
      const perf = typeof performance !== 'undefined' ? performance.memory : null;
      if (perf) return { usedJSHeapSize: perf.usedJSHeapSize, totalJSHeapSize: perf.totalJSHeapSize, jsHeapSizeLimit: perf.jsHeapSizeLimit };
      return null;
    }

    uptime() { return Date.now() - this._startTime; }

    simulateDisconnect(peerId) {
      const pc = this._connMgr?.getPeerConnection(peerId);
      if (pc) {
        pc._dispatchEvent(new Event('iceconnectionstatechange'));
        Object.defineProperty(pc, 'iceConnectionState', { value: 'failed', writable: true });
        pc.oniceconnectionstatechange?.();
        return true;
      }
      return false;
    }

    dump() {
      return {
        timestamp: new Date().toISOString(),
        uptime: this.uptime(),
        memory: this.memory(),
        network: this.network(),
        peers: this.peers(),
        connectionStates: this.connectionStates(),
        messageRouter: this.messageRouter(),
        fileTransfers: this.fileTransfers(),
        eventStats: this.eventStats(),
        recentEvents: this.events(50),
      };
    }

    _installConsole() {
      this._ownsConsole = _attachInstance(this);
    }

    restoreConsole() {
      _detachInstance(this);
      this._ownsConsole = false;
    }

    destroy() {
      this.restoreConsole();
      this.detach();
      if (this._floatInterval) clearInterval(this._floatInterval);
    }
  }

  const debug = new GhostLinkDebug();
  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.GhostLinkDebug = GhostLinkDebug;
  exports.GhostLinkDebug = debug;
  window.GhostLinkDebug = debug;
})(typeof globalThis !== 'undefined' ? globalThis : this);