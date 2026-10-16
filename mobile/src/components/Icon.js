/**
 * GhostLink Mobile — one icon family for every control.
 *
 * The screens used a letter ("S" for settings, "?" for search, "[QR]"), an
 * emoji, or a Unicode arrow, depending on who wrote the row. Emoji render in
 * the OS's colour font, so the same button looked different on every phone
 * and never matched the text beside it. These are 24×24 strokes at one weight,
 * tinted like text.
 *
 * Icons are decorative to screen readers: the control that holds one carries
 * the accessibilityLabel.
 */

import React from 'react';
import Svg, {Path, Circle, Rect} from 'react-native-svg';

const SHAPES = {
  back: <Path d="M15 5l-7 7 7 7" />,
  chevronRight: <Path d="M9 5l7 7-7 7" />,
  close: <Path d="M6 6l12 12M18 6L6 18" />,
  plus: <Path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <Circle cx="11" cy="11" r="6.5" />
      <Path d="M16 16l4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  pin: <Path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7" />,
  bellOff: (
    <>
      <Path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H7.5" />
      <Path d="M10 21h4M3 3l18 18" />
    </>
  ),
  bell: <Path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 21h4" />,
  trash: <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  qr: (
    <>
      <Rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <Rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <Rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <Path d="M14.5 14.5h2v2h-2zM18.5 18.5h2v2h-2zM14.5 20.5h2M20.5 14.5v2" />
    </>
  ),
  copy: (
    <>
      <Rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <Path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  reply: <Path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6v1" />,
  send: <Path d="M12 19V5M6 11l6-6 6 6" />,
  smile: (
    <>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  keyboard: (
    <>
      <Rect x="2.5" y="6" width="19" height="12" rx="2" />
      <Path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </>
  ),
  phone: (
    <Path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />
  ),
  video: (
    <>
      <Rect x="2.5" y="6.5" width="13" height="11" rx="2" />
      <Path d="M15.5 10.5l6-3.5v10l-6-3.5" />
    </>
  ),
  lock: (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="2" />
      <Path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  lockOpen: (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="2" />
      <Path d="M8 10.5V7a4 4 0 0 1 7.7-1.5" />
    </>
  ),
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkDouble: <Path d="M2.5 12.5L7 17l9.5-9.5M11 16l1 1 9.5-9.5" />,
  clock: (
    <>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M12 7.5V12l3 2" />
    </>
  ),
  alert: (
    <>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M12 7.5v5.5M12 16.5h.01" />
    </>
  ),
  warning: <Path d="M12 3.5L2.5 20h19L12 3.5zM12 10v4.5M12 17.5h.01" />,
  download: <Path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  file: <Path d="M6 3h8l5 5v13H6V3zM14 3v5h5" />,
  play: <Path d="M8 5l11 7-11 7V5z" />,
};

export default function Icon({name, size = 22, color, strokeWidth = 2, style}) {
  const shape = SHAPES[name];
  if (!shape) return null;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      {shape}
    </Svg>
  );
}

export const ICON_NAMES = Object.keys(SHAPES);
