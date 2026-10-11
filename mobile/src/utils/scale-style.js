/** Multiply the text sizes in a style by the user's chosen scale (react-native free, for testing). */

/** Collapse a style value (nested arrays/objects) to a single object; other shapes pass through. */
function flatten(style) {
  if (!style) return null;
  if (Array.isArray(style)) {
    return style.reduce((acc, item) => {
      const part = flatten(item);
      return part ? {...acc, ...part} : acc;
    }, {});
  }
  return typeof style === 'object' ? style : null;
}

/**
 * @param {object|Array|undefined} style any RN style value
 * @param {number} ratio chosen size ÷ the 16pt base the app was written against
 * @returns the style with its text sizes scaled, or the original if there are none
 */
export function scaleStyle(style, ratio) {
  if (ratio === 1 || !style) return style;

  const flat = flatten(style);
  if (!flat || typeof flat.fontSize !== 'number') return style;

  const next = {...flat, fontSize: Math.round(flat.fontSize * ratio)};
  // lineHeight has to move with the text, or larger sizes crowd their own
  // rows — which is exactly how a long string in a taller script breaks a row.
  if (typeof flat.lineHeight === 'number') {
    next.lineHeight = Math.round(flat.lineHeight * ratio);
  }
  return next;
}
