/**
 * GhostLink Mobile — the top bar for pushed screens (Settings, Recovery).
 *
 * Each screen had its own copy with a hard-coded paddingTop (54 on iOS, 48 on
 * Android), which sits under the Dynamic Island on current iPhones and leaves
 * a gap on Android where the status bar is not translucent. The safe-area
 * inset is the real number. The back control is a 44pt target with a label.
 */

import React from 'react';
import {View, StyleSheet, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Text} from './ScaledText';
import Icon from './Icon';
import {useTheme} from '../context/ThemeContext';

export default function ScreenHeader({title, onBack, right = null}) {
  const {theme} = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top + 4,
          backgroundColor: theme.bgSecondary,
          borderBottomColor: theme.border,
        },
      ]}>
      {onBack ? (
        <TouchableOpacity
          style={styles.side}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          activeOpacity={0.6}>
          <Icon name="back" size={24} color={theme.accent} />
        </TouchableOpacity>
      ) : (
        <View style={styles.side} />
      )}
      <Text
        style={[styles.title, {color: theme.text}]}
        numberOfLines={1}
        accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  side: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideRight: {
    alignItems: 'flex-end',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
  },
});
