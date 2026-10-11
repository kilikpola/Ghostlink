/**
 * GhostLink Mobile — Theme Context
 *
 * One palette, shared with the web and PC clients. Also owns the text scale:
 * `fontSize` is the base size and `scale()` derives every other size from it,
 * so changing it moves the whole UI rather than one screen.
 */

import React, {createContext, useContext, useCallback, useMemo} from 'react';
import {useApp} from './AppContext';

// ═══════════════════════════════════════════════════════════════
//  THEME DEFINITIONS — match web app exactly
// ═══════════════════════════════════════════════════════════════

/**
 * The GhostLink palette, shared with the web and PC clients (values from the
 * web client's PALETTE in index.html; web names noted beside each).
 */
const PALETTE = {
  name: 'GhostLink',

  bg: '#0B0F17',            // obsidian  — app background, never pure black
  bgSecondary: '#151B26',   // slate     — cards, panels, surfaces
  bgTertiary: '#1F2733',    // graphite  — elevated surfaces, inputs
  border: '#2B3543',        // divider   — borders, separators

  text: '#E8EDF4',          // frost
  textSecondary: '#8B95A5', // mist
  textMuted: '#5A6577',     // fade

  accent: '#4FE3B0',        // spectral  — secure, verified, connected, send
  accent2: '#8CFFD4',       // signal    — links, info, encryption tags
  accent3: '#2FA37D',       // spectralDim — pressed / active
  accentDim: 'rgba(79,227,176,0.12)', // spectralGlow

  success: '#4FE3B0',       // spectral
  warning: '#FFB84D',       // amber     — warning, Pro tier, locked
  danger: '#FF5F6D',        // crimson   — danger, errors, end call
};

/** Text scale: `fontSize` is the base size in points; everything derives from it. */
const FONT_SCALE = {
  small: 14,
  default: 16,
  large: 19,
  extraLarge: 22,
};

const DEFAULT_FONT_SIZE = FONT_SCALE.default;

const ThemeContext = createContext(null);

function ThemeProvider({children}) {
  const {settings, updateSettings} = useApp();

  // One palette. Kept as a stable reference so a settings change does not
  // re-render every consumer that only reads colours.
  const theme = PALETTE;

  const fontSize = useMemo(() => {
    const stored = Number(settings?.fontSize);
    return Number.isFinite(stored) && stored >= 10 && stored <= 32
      ? stored
      : DEFAULT_FONT_SIZE;
  }, [settings?.fontSize]);

  /**
   * Scale a design size (written against a 16pt base) by the user's choice,
   * rounded for consistent rendering across densities.
   */
  const scale = useCallback(
    size => Math.round((size * fontSize) / DEFAULT_FONT_SIZE),
    [fontSize],
  );

  const setFontSize = useCallback(
    next => {
      const value = Number(next);
      if (Number.isFinite(value) && value >= 10 && value <= 32) {
        updateSettings({fontSize: value});
      }
    },
    [updateSettings],
  );

  /** The user's size as a multiple of the 16pt base. */
  const fontScale = fontSize / DEFAULT_FONT_SIZE;

  const value = useMemo(
    () => ({theme, fontSize, fontScale, scale, setFontSize, FONT_SCALE}),
    [theme, fontSize, fontScale, scale, setFontSize],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

export {ThemeProvider, useTheme, PALETTE, FONT_SCALE};
export default ThemeContext;
