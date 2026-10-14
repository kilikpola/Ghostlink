// Logger — GhostLink production structured logger
(function(exports) {
  'use strict';

  /** @type {Object.<string, number>} Log level priorities */
  const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, critical: 5 };
  /** @type {number} Maximum buffered log entries */
  const MAX_BUFFER = 5000;

  /**
   * Production structured logger with levels and JSON output. Console + in-memory
   * only — it has no off-device transport.
   * @class
   */
  class Logger {
    /**
     * Creates a new Logger instance
     * @param {string} namespace - Logger namespace/category identifier
     * @param {Object} [options={}] - Configuration options
     * @param {string} [options.minLevel='info'] - Minimum log level to output
     * @param {boolean} [options.json=false] - Output as JSON format
     */
    constructor(namespace, options = {}) {
      /** @type {string} Logger namespace */
      this.namespace = namespace;
      /** @type {string} Minimum log level */
      this.minLevel = options.minLevel || 'info';
      /** @type {boolean} Output as JSON */
      this.json = options.json || false;
      // NOTE: no remote/off-device transport. A structured logger must never be
      // able to ship logs off the device in a packaged build; the sink was dead
      // code (no caller set it) and is removed so it cannot be wired up. Logs go
      // to the console and an in-memory buffer only. (RC1 audit, Round-final.)
      /** @type {Array} Internal buffer for recent entries */
      this._buffer = [];
      /** @type {Array} Output log entries */
      this._out = [];
    }

    /**
     * Determines if a level should be logged based on minLevel
     * @param {string} level - Log level to check
     * @returns {boolean} True if level should be logged
     * @private
     */
    _should(level) {
      return LEVELS[level] >= LEVELS[this.minLevel];
    }

    /**
     * Formats a log entry
     * @param {Object} meta - Metadata object including level
     * @param {string} msg - Log message
     * @returns {string} Formatted log entry
     * @private
     */
    _fmt(meta, msg) {
      const entry = {
        ts: new Date().toISOString(),
        level: meta.level,
        namespace: this.namespace,
        msg,
        ...(Object.keys(meta).length ? { meta } : {}),
        _pid: typeof process !== 'undefined' ? process.pid : 0,
      };
      if (this.json) return JSON.stringify(entry);
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${entry.ts}] [${meta.level.toUpperCase()}] [${this.namespace}] ${msg}${metaStr}`;
    }

    /**
     * Internal emit method that handles formatting, output, and transport
     * @param {string} level - Log level
     * @param {string} msg - Log message
     * @param {Object} [meta={}] - Additional metadata
     * @private
     */
    _emit(level, msg, meta = {}) {
      if (!this._should(level)) return;

      const out = this._fmt({ ...meta, level }, msg);
      this._out.push(out);
      if (this._out.length > MAX_BUFFER) this._out.shift();

      // Console output only — logs never leave the device.
      if (level === 'error' || level === 'critical') console.error(out);
      else if (level === 'warn') console.warn(out);
      else console.log(out);
    }

    /**
     * Log a trace level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    trace(msg, meta) { this._emit('trace', msg, meta); }

    /**
     * Log a debug level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    debug(msg, meta) { this._emit('debug', msg, meta); }

    /**
     * Log an info level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    info(msg, meta) { this._emit('info', msg, meta); }

    /**
     * Log a warning level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    warn(msg, meta) { this._emit('warn', msg, meta); }

    /**
     * Log an error level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    error(msg, meta) { this._emit('error', msg, meta); }

    /**
     * Log a critical level message
     * @param {string} msg - Log message
     * @param {Object} [meta] - Additional metadata
     */
    critical(msg, meta) { this._emit('critical', msg, meta); }

    /**
     * Creates a scoped child logger
     * @param {string} ns - Child namespace suffix
     * @returns {Logger} New scoped child logger
     */
    child(ns) {
      return new Logger(`${this.namespace}:${ns}`, {
        minLevel: this.minLevel,
        json: this.json
      });
    }

    /**
     * Returns a copy of recent log entries
     * @returns {string[]} Array of log entries
     */
    out() { return [...this._out]; }

    /**
     * Clears the log buffer
     */
    clear() { this._out = []; }

    /**
     * Static factory to create a new logger
     * @param {string} ns - Logger namespace
     * @param {Object} [opts] - Logger options
     * @returns {Logger} New Logger instance
     */
    static createLogger(ns, opts) {
      return new Logger(ns, opts);
    }
  }

  // Root logger singleton
  const rootLogger = new Logger('ghostlink', { minLevel: 'debug', json: false });

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.Logger = Logger;
  exports.GhostLink.log = rootLogger;
  exports.GhostLink.createLogger = Logger.createLogger;
})(typeof globalThis !== 'undefined' ? globalThis : this);
