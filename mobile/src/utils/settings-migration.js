/** GhostLink Mobile — settings schema and migration (separate from AppContext for testing). */

export const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  /**
   * Ghost Mesh bridge, e.g. ws://192.168.1.15:3002. Empty means no mesh. Must
   * be a bridge started with this phone's own seed. For interop testing; see
   * MOBILE_BUILD.md.
   */
  meshBridgeUrl: '',
  /** Base text size; drives the whole UI through ThemeContext. */
  fontSize: 16,
};


/**
 * Settings schema version. Bump when the shape or meaning of a stored value
 * changes, and add a step to SETTINGS_MIGRATIONS.
 *
 *   1 — original: theme, fontSize, notifications, sounds, readReceipts,
 *       encLevel, p2pRelay
 *   2 — meshBridgeUrl added; encLevel removed
 *   3 — single product palette; readReceipts, sounds, notifications and
 *       p2pRelay dropped (nothing implemented them)
 */
export const SETTINGS_VERSION = 3;

/**
 * One function per version step, applied in order. Steps must be total: they
 * run on whatever is on the device and must not throw on unexpected keys.
 */
export const SETTINGS_MIGRATIONS = {
  // v1 → v2
  2: prev => {
    const {encLevel, ...rest} = prev;
    return {...rest, meshBridgeUrl: typeof prev.meshBridgeUrl === 'string' ? prev.meshBridgeUrl : ''};
  },

  /** v2 → v3: drop the theme choice and the unimplemented toggles. */
  3: prev => {
    const {theme, readReceipts, sounds, notifications, p2pRelay, ...rest} = prev;
    return rest;
  },
};

/**
 * Bring stored settings up to the current schema. Unrecognised keys are kept
 * (they may belong to a newer build).
 */
export function migrateSettings(stored) {
  if (!stored || typeof stored !== 'object') return {...DEFAULT_SETTINGS};

  let working = {...stored};
  const from = Number.isInteger(working.settingsVersion) ? working.settingsVersion : 1;

  if (from > SETTINGS_VERSION) {
    // Downgrade: this build cannot know what a newer key means. Merge over
    // defaults and keep everything, rather than discarding the user's state.
    console.warn(
      `[AppContext] settings are version ${from}, this build understands ${SETTINGS_VERSION}. ` +
      'Keeping the stored values and filling in anything missing.',
    );
    return {...DEFAULT_SETTINGS, ...working, settingsVersion: from};
  }

  for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
    const step = SETTINGS_MIGRATIONS[v];
    if (!step) continue;
    try {
      working = step(working);
    } catch (err) {
      // Non-destructive: the stored copy on disk is untouched, and the next
      // launch will try again. Better to run on defaults for this session than
      // to write a half-migrated object back over good data.
      console.error(`[AppContext] settings migration to v${v} failed; using defaults this session:`, err);
      return {...DEFAULT_SETTINGS};
    }
  }

  return {...DEFAULT_SETTINGS, ...working, settingsVersion: SETTINGS_VERSION};
}


/**
 * Parse the five raw storage values independently, so one bad value does not
 * cost the others. Returns what could be read and names what could not;
 * nothing is deleted.
 *
 * @param {{identity?: string, messages?: string, settings?: string, peers?: string, ghostMesh?: string}} raw
 * @param {(obj: object) => Map} toMap how the caller turns a plain object back into a Map
 * @returns {{restored: object, lost: string[]}}
 */
export function parseStoredState(raw, toMap) {
  const restored = {};
  const lost = [];

  const take = (key, value, parse) => {
    if (!value) return;
    try {
      restored[key] = parse(value);
    } catch (err) {
      lost.push(key);
      console.error(`[AppContext] could not restore ${key}; the stored copy is left untouched:`, err);
    }
  };

  take('identity', raw.identity, JSON.parse);
  take('messages', raw.messages, v => toMap(JSON.parse(v)));
  take('settings', raw.settings, v => migrateSettings(JSON.parse(v)));
  take('peers', raw.peers, v => toMap(JSON.parse(v)));
  take('ghostMesh', raw.ghostMesh, JSON.parse);

  return {restored, lost};
}
