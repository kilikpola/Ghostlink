import React, {useEffect} from 'react';
import {View, StyleSheet} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getGradientColors(name, accent) {
  const h = hashCode(name || 'ghost');
  const hue1 = h % 360;
  const hue2 = (hue1 + 40) % 360;
  // Dark enough that the white initial clears 3:1 at every hue; at 70%/50%
  // a yellow or cyan avatar put white text at 1.4:1.
  return {
    color1: `hsl(${hue1}, 55%, 34%)`,
    color2: `hsl(${hue2}, 50%, 28%)`,
    accent,
  };
}

export default function PeerAvatar({name, size = 44, online = false, typing = false}) {
  const {theme} = useTheme();
  const typingScale = useSharedValue(1);

  useEffect(() => {
    if (typing) {
      typingScale.value = withRepeat(
        withSequence(
          withTiming(1.15, {duration: 400, easing: Easing.inOut(Easing.ease)}),
          withTiming(1, {duration: 400, easing: Easing.inOut(Easing.ease)}),
        ),
        -1,
        true,
      );
    } else {
      typingScale.value = withTiming(1, {duration: 200});
    }
  }, [typing, typingScale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: typingScale.value}],
  }));

  const colors = getGradientColors(name, theme.accent);
  const initial = (name || 'G').charAt(0).toUpperCase();
  const fontSize = size * 0.42;

  return (
    <Animated.View
      style={[styles.container, {width: size, height: size}, animatedStyle]}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <View
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: colors.color1,
            borderWidth: typing ? 2 : 0,
            borderColor: typing ? theme.accent : 'transparent',
          },
        ]}>
        <View
          style={[
            styles.innerGradient,
            {
              width: size * 0.9,
              height: size * 0.9,
              borderRadius: (size * 0.9) / 2,
              backgroundColor: colors.color2,
            },
          ]}
        />
        <Animated.Text
          style={[
            styles.initial,
            {
              fontSize,
              lineHeight: size,
              color: '#fff',
            },
          ]}>
          {initial}
        </Animated.Text>
      </View>
      {online !== undefined && (
        <View
          style={[
            styles.statusDot,
            {
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: size * 0.14,
              backgroundColor: online ? theme.success : theme.textMuted,
              borderColor: theme.bg,
              borderWidth: 2,
              right: 0,
              bottom: 0,
            },
          ]}
        />
      )}
      {typing && (
        <View style={[styles.typingIndicator, {bottom: -4}]}>
          <TypingDots color={theme.accent} />
        </View>
      )}
    </Animated.View>
  );
}

function TypingDots({color}) {
  const dot1 = useSharedValue(0);
  const dot2 = useSharedValue(0);
  const dot3 = useSharedValue(0);

  useEffect(() => {
    dot1.value = withRepeat(
      withSequence(
        withTiming(-3, {duration: 300}),
        withTiming(0, {duration: 300}),
      ),
      -1,
    );
    setTimeout(() => {
      dot2.value = withRepeat(
        withSequence(
          withTiming(-3, {duration: 300}),
          withTiming(0, {duration: 300}),
        ),
        -1,
      );
    }, 100);
    setTimeout(() => {
      dot3.value = withRepeat(
        withSequence(
          withTiming(-3, {duration: 300}),
          withTiming(0, {duration: 300}),
        ),
        -1,
      );
    }, 200);
  }, [dot1, dot2, dot3]);

  const anim1 = useAnimatedStyle(() => ({transform: [{translateY: dot1.value}]}));
  const anim2 = useAnimatedStyle(() => ({transform: [{translateY: dot2.value}]}));
  const anim3 = useAnimatedStyle(() => ({transform: [{translateY: dot3.value}]}));

  const dotStyle = {width: 4, height: 4, borderRadius: 2, backgroundColor: color, marginHorizontal: 1};

  return (
    <View style={styles.dotsRow}>
      <Animated.View style={[dotStyle, anim1]} />
      <Animated.View style={[dotStyle, anim2]} />
      <Animated.View style={[dotStyle, anim3]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  avatar: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  innerGradient: {
    position: 'absolute',
    opacity: 0.7,
  },
  initial: {
    fontWeight: '700',
    textAlign: 'center',
    position: 'absolute',
  },
  statusDot: {
    position: 'absolute',
  },
  typingIndicator: {
    position: 'absolute',
    alignSelf: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
