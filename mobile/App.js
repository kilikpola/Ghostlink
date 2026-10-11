/**
 * GhostLink Mobile — Root App Entry Point
 *
 * React Navigation native stack with conditional auth flow, ghostlink:// deep
 * links, global state via AppContext, and push notification setup.
 */

import React, {useEffect, useMemo} from 'react';
import {StyleSheet, StatusBar, Platform} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {GestureHandlerRootView} from 'react-native-gesture-handler';

import {AppProvider} from './src/context/AppContext';
import {ThemeProvider, useTheme} from './src/context/ThemeContext';
import RootNavigator from './src/navigation/MainNavigator';

// ═══════════════════════════════════════════════════════════════
//  DEEP LINKING — ghostlink:// URL scheme
// ═══════════════════════════════════════════════════════════════

/**
 * Any page or app can fire a ghostlink:// URL with arbitrary params, so no
 * deep link may act on its own. Calls start only from inside a conversation.
 */
const DEEP_LINK_CONFIG = {
  prefixes: ['ghostlink://', 'https://ghostlink.app'],
  config: {
    screens: {
      Setup: 'setup',
      ChatList: 'chats',
      Chat: {
        path: 'chat/:roomId',
        parse: {
          roomId: String,
        },
      },
      Settings: 'settings',
      Recovery: 'recovery',
    },
  },
};

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS — placeholder setup
// ═══════════════════════════════════════════════════════════════

/**
 * Best-effort push notification setup, required lazily: without a Firebase
 * config the module throws at configure() and would crash the app on launch.
 */
function configurePushNotifications() {
  let PushNotification;
  try {
    PushNotification = require('react-native-push-notification');
    PushNotification = PushNotification.default ?? PushNotification;
    if (!PushNotification || typeof PushNotification.configure !== 'function') {
      throw new Error('native module unavailable');
    }
  } catch (err) {
    console.warn('[Push] notifications unavailable, continuing without them:', err?.message);
    return;
  }

  PushNotification.configure({
    onRegister(token) {
      // TODO: send token to signaling server for push relay
      console.log('[Push] registered:', token);
    },

    onNotification(notification) {
      // TODO: navigate to relevant chat / call screen
      console.log('[Push] received:', notification);
    },

    onAction(notification) {
      // TODO: handle reply / dismiss / accept-call actions
      console.log('[Push] action:', notification.action);
    },

    onRegistrationError(err) {
      console.warn('[Push] registration error:', err);
    },

    channelId: 'ghostlink-default',

    permissions: {
      alert: true,
      badge: true,
      sound: true,
    },

    popInitialNotification: true,
    requestPermissions: Platform.OS === 'ios',
  });

  // Android notification channels
  if (Platform.OS === 'android') {
    PushNotification.createChannel(
      {
        channelId: 'ghostlink-default',
        channelName: 'GhostLink Messages',
        channelDescription: 'Encrypted message notifications',
        playSound: true,
        soundName: 'default',
        importance: 4, // IMPORTANCE_HIGH
        vibrate: true,
      },
      () => {},
    );

    PushNotification.createChannel(
      {
        channelId: 'ghostlink-calls',
        channelName: 'GhostLink Calls',
        channelDescription: 'Incoming encrypted call notifications',
        playSound: true,
        soundName: 'default',
        importance: 5, // IMPORTANCE_MAX — heads-up display
        vibrate: true,
      },
      () => {},
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  APP NAVIGATOR — NavigationContainer + theme + deep links
// ═══════════════════════════════════════════════════════════════

function AppNavigator() {
  const {theme} = useTheme();

  // Map our theme to React Navigation's theme shape
  const navigationTheme = useMemo(
    () => ({
      dark: true,
      colors: {
        primary: theme.accent,
        background: theme.bg,
        card: theme.bgSecondary,
        text: theme.text,
        border: theme.border,
        notification: theme.accent,
      },
    }),
    [theme],
  );

  return (
    <NavigationContainer
      theme={navigationTheme}
      linking={DEEP_LINK_CONFIG}
      fallback={null}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={theme.bg}
        translucent={false}
      />
      <RootNavigator />
    </NavigationContainer>
  );
}

// ═══════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function App() {
  // Initialise push notifications once
  useEffect(() => {
    try {
      configurePushNotifications();
    } catch (err) {
      // Belt and braces: nothing about notifications is worth a failed launch.
      console.warn('[Push] setup failed, continuing without notifications:', err?.message);
    }
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AppProvider>
          <ThemeProvider>
            <AppNavigator />
          </ThemeProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// ═══════════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0f',
  },
});
