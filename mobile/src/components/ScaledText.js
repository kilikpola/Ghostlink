/**
 * GhostLink Mobile — text that honours the user's chosen size. Font sizes stay
 * written at their design value in StyleSheets and are scaled here:
 *
 *   -import {Text, TextInput} from 'react-native';
 *   +import {Text, TextInput} from '../components/ScaledText';
 *
 * Styles without a fontSize pass through untouched.
 */

import React, {useMemo} from 'react';
import {Text as RNText, TextInput as RNTextInput} from 'react-native';
import {useTheme} from '../context/ThemeContext';
import {scaleStyle} from '../utils/scale-style';

export function Text({style, ...props}) {
  const {fontScale} = useTheme();
  const scaled = useMemo(() => scaleStyle(style, fontScale), [style, fontScale]);
  return <RNText {...props} style={scaled} />;
}

export function TextInput({style, ...props}) {
  const {fontScale} = useTheme();
  const scaled = useMemo(() => scaleStyle(style, fontScale), [style, fontScale]);
  return <RNTextInput {...props} style={scaled} />;
}

export {scaleStyle};
