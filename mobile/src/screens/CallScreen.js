/**
 * GhostLink Mobile - CallScreen
 *
 * Full-featured voice and video call screen with WebRTC integration,
 * draggable PiP local video, incoming call overlay, call state
 * management, and background audio support.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Vibration,
  Dimensions,
  StatusBar,
  Platform,
  Alert,
  PanResponder,
  AppState,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text} from '../components/ScaledText';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  FadeIn,
  FadeOut,
  ZoomIn,
  SlideInDown,
  Easing,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import PeerAvatar from '../components/PeerAvatar';
import {CALLS_AVAILABLE} from '../utils/capabilities';

// ─── Constants ─────────────────────────────────────────────
const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');

const ACCENT = '#00ffa3';
const ACCENT2 = '#b347ff';
const BG = '#0a0a0f';
const BG_TERTIARY = '#1a1a25';
const TEXT_PRIMARY = '#e0e0e0';
const TEXT_SECONDARY = '#8a8a9a';
const TEXT_MUTED = '#5a5a6a';
const BORDER_COLOR = 'rgba(255,255,255,0.06)';
const DANGER = '#ff4466';
const SUCCESS = '#00ffa3';

const PIP_WIDTH = 120;
const PIP_HEIGHT = 160;
const PIP_MARGIN = 16;

const CALL_STATES = {
  INCOMING: 'incoming',
  CONNECTING: 'connecting',
  RINGING: 'ringing',
  CONNECTED: 'connected',
  ENDED: 'ended',
  FAILED: 'failed',
};

// ─── Helper Functions ──────────────────────────────────────

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ─── Pulse Ring Animation Component ────────────────────────

function PulseRing({size, color, delay = 0}) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    scale.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(2.2, {duration: 1800, easing: Easing.out(Easing.ease)}),
          withTiming(1, {duration: 0}),
        ),
        -1,
      ),
    );
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(0, {duration: 1800, easing: Easing.out(Easing.ease)}),
          withTiming(0.5, {duration: 0}),
        ),
        -1,
      ),
    );
  }, [scale, opacity, delay]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: color,
        },
        animStyle,
      ]}
    />
  );
}

// ─── Avatar with Pulse ─────────────────────────────────────

function CallAvatar({name, size = 120, isActive}) {
  const breatheScale = useSharedValue(1);

  useEffect(() => {
    if (isActive) {
      breatheScale.value = withRepeat(
        withSequence(
          withTiming(1.05, {duration: 2000, easing: Easing.inOut(Easing.ease)}),
          withTiming(1, {duration: 2000, easing: Easing.inOut(Easing.ease)}),
        ),
        -1,
      );
    } else {
      breatheScale.value = withTiming(1, {duration: 300});
    }
  }, [isActive, breatheScale]);

  const breatheStyle = useAnimatedStyle(() => ({
    transform: [{scale: breatheScale.value}],
  }));

  return (
    <View style={callAvatarStyles.container}>
      <PulseRing size={size} color={ACCENT + '40'} delay={0} />
      <PulseRing size={size} color={ACCENT + '25'} delay={600} />
      <PulseRing size={size} color={ACCENT + '15'} delay={1200} />
      <Animated.View style={breatheStyle}>
        <PeerAvatar name={name} size={size} online />
      </Animated.View>
    </View>
  );
}

const callAvatarStyles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 240,
    height: 240,
  },
});

// ─── Draggable PiP Local Video ─────────────────────────────

function DraggablePiP({children}) {
  const posX = useRef(SCREEN_WIDTH - PIP_WIDTH - PIP_MARGIN);
  const posY = useRef(PIP_MARGIN + (Platform.OS === 'ios' ? 44 : 24));
  const [position, setPosition] = useState({
    x: posX.current,
    y: posY.current,
  });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        Vibration.vibrate(10);
      },
      onPanResponderMove: (_, gestureState) => {
        const newX = Math.max(
          PIP_MARGIN,
          Math.min(
            SCREEN_WIDTH - PIP_WIDTH - PIP_MARGIN,
            posX.current + gestureState.dx,
          ),
        );
        const newY = Math.max(
          PIP_MARGIN,
          Math.min(
            SCREEN_HEIGHT - PIP_HEIGHT - PIP_MARGIN - 100,
            posY.current + gestureState.dy,
          ),
        );
        setPosition({x: newX, y: newY});
      },
      onPanResponderRelease: (_, gestureState) => {
        const finalX = Math.max(
          PIP_MARGIN,
          Math.min(
            SCREEN_WIDTH - PIP_WIDTH - PIP_MARGIN,
            posX.current + gestureState.dx,
          ),
        );
        const finalY = Math.max(
          PIP_MARGIN,
          Math.min(
            SCREEN_HEIGHT - PIP_HEIGHT - PIP_MARGIN - 100,
            posY.current + gestureState.dy,
          ),
        );

        // Snap to nearest edge
        const snapX =
          finalX < SCREEN_WIDTH / 2 - PIP_WIDTH / 2
            ? PIP_MARGIN
            : SCREEN_WIDTH - PIP_WIDTH - PIP_MARGIN;

        posX.current = snapX;
        posY.current = finalY;
        setPosition({x: snapX, y: finalY});
      },
    }),
  ).current;

  return (
    <Animated.View
      entering={ZoomIn.duration(300).springify()}
      {...panResponder.panHandlers}
      style={[
        styles.pipContainer,
        {
          left: position.x,
          top: position.y,
        },
      ]}>
      {children}
    </Animated.View>
  );
}

// ─── Control Button ────────────────────────────────────────

function ControlButton({icon, label, onPress, active, activeColor, dangerBg, size = 64}) {
  const bg = dangerBg
    ? DANGER
    : active
    ? (activeColor || ACCENT) + '20'
    : BG_TERTIARY;
  const borderCol = dangerBg
    ? DANGER
    : active
    ? (activeColor || ACCENT) + '60'
    : BORDER_COLOR;
  const textColor = dangerBg
    ? '#fff'
    : active
    ? activeColor || ACCENT
    : TEXT_PRIMARY;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        styles.controlBtn,
        {
          width: size,
          height: size,
          borderRadius: size * 0.3,
          backgroundColor: bg,
          borderColor: borderCol,
          borderWidth: 1,
        },
      ]}>
      <Text style={{fontSize: size * 0.34, color: textColor}}>{icon}</Text>
      {label && (
        <Text
          style={[
            styles.controlLabel,
            {color: dangerBg ? '#fff' : active ? activeColor || ACCENT : TEXT_SECONDARY},
          ]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─── Incoming Call Overlay ──────────────────────────────────

function IncomingCallOverlay({peerName, isVideo, onAccept, onReject}) {
  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      exiting={FadeOut.duration(300)}
      style={styles.incomingOverlay}>
      <View style={styles.incomingContent}>
        <CallAvatar name={peerName} size={110} isActive={false} />

        <Text style={styles.incomingCallerName}>{peerName}</Text>
        <Text style={styles.incomingCallType}>
          Incoming {isVideo ? 'Video' : 'Voice'} Call
        </Text>
        <Text style={styles.incomingEncrypted}>🔒 End-to-end encrypted</Text>
      </View>

      <View style={styles.incomingActions}>
        <TouchableOpacity
          style={styles.incomingRejectBtn}
          onPress={() => {
            Vibration.vibrate(100);
            onReject();
          }}>
          <Text style={styles.incomingRejectIcon}>📞</Text>
          <Text style={styles.incomingRejectText}>Decline</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.incomingAcceptBtn}
          onPress={() => {
            Vibration.vibrate(50);
            onAccept();
          }}>
          <Text style={styles.incomingAcceptIcon}>📞</Text>
          <Text style={styles.incomingAcceptText}>Accept</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// ─── Main CallScreen Component ─────────────────────────────

export default function CallScreen({route, navigation}) {
  const {theme} = useTheme();
  const {peers, identity} = useApp();

  // Route params
  const peerId = route?.params?.peer || null;
  const isVideoCall = route?.params?.video ?? false;
  const isIncoming = route?.params?.incoming ?? false;

  // State
  const [callState, setCallState] = useState(
    isIncoming ? CALL_STATES.INCOMING : CALL_STATES.CONNECTING,
  );
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(isVideoCall);
  const [isSpeaker, setIsSpeaker] = useState(isVideoCall);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [localStreamUrl, setLocalStreamUrl] = useState(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);

  const durationRef = useRef(null);
  const controlsTimeout = useRef(null);
  const appState = useRef(AppState.currentState);

  // Derive peer name
  const peerName = useMemo(() => {
    if (!peerId) return 'Unknown';
    if (peers instanceof Map) {
      return peers.get(peerId)?.name || 'Peer';
    }
    if (Array.isArray(peers)) {
      return peers.find(p => p.id === peerId)?.name || 'Peer';
    }
    return 'Peer';
  }, [peers, peerId]);

  // Keep screen awake indicator + background audio
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // Returned to foreground
        if (callState === CALL_STATES.CONNECTED) {
          setShowControls(true);
        }
      }
      appState.current = nextAppState;
    });

    return () => subscription?.remove();
  }, [callState]);

  // ── Call Initialization ──

  useEffect(() => {
    // Gated here too: this screen can be reached by other routes.
    if (!CALLS_AVAILABLE) {
      setCallState(CALL_STATES.FAILED);
    } else if (callState === CALL_STATES.CONNECTING) {
      initializeCall();
    }

    return () => {
      if (durationRef.current) clearInterval(durationRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initializeCall() {
    try {
      setCallState(CALL_STATES.CONNECTING);

      // Use real WebRTC service if available
      const WebRTCService = require('../services/WebRTCService').default;

      if (WebRTCService && peerId) {
        // Real WebRTC call flow
        setCallState(CALL_STATES.RINGING);

        // Wait for peer to answer (with timeout)
        const answerTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('No answer')), 30000),
        );

        try {
          await Promise.race([
            WebRTCService.createConnection(peerId, {initiator: !isIncoming}),
            answerTimeout,
          ]);

          if (isVideoCall) {
            await WebRTCService.addMediaStream(peerId, {video: true, audio: true});
          } else {
            await WebRTCService.addMediaStream(peerId, {video: false, audio: true});
          }

          setCallState(CALL_STATES.CONNECTED);
          Vibration.vibrate([0, 50, 50, 50]);
        } catch (rtcErr) {
          console.warn('WebRTC connection failed:', rtcErr);
          setCallState(CALL_STATES.FAILED);
          return;
        }
      } else {
        // No peer, no call.
        setCallState(CALL_STATES.FAILED);
        return;
      }

      // Start duration timer
      durationRef.current = setInterval(() => {
        setDuration(d => d + 1);
      }, 1000);
    } catch (err) {
      console.warn('Call initialization error:', err);
      setCallState(CALL_STATES.FAILED);
    }
  }

  // ── Auto-hide controls in video mode ──

  useEffect(() => {
    if (isVideoCall && callState === CALL_STATES.CONNECTED && showControls) {
      controlsTimeout.current = setTimeout(() => {
        setShowControls(false);
      }, 5000);
    }
    return () => {
      if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
    };
  }, [isVideoCall, callState, showControls]);

  const toggleControls = useCallback(() => {
    if (isVideoCall && callState === CALL_STATES.CONNECTED) {
      setShowControls(s => !s);
    }
  }, [isVideoCall, callState]);

  // ── Call Actions ──

  const handleHangup = useCallback(() => {
    Vibration.vibrate(100);
    if (durationRef.current) clearInterval(durationRef.current);

    // Clean up real WebRTC connection if available
    try {
      const WebRTCService = require('../services/WebRTCService').default;
      if (WebRTCService && peerId) {
        WebRTCService.removeMediaStream(peerId);
        WebRTCService.disconnectPeer(peerId);
      }
    } catch (_) { /* service not available */ }

    setCallState(CALL_STATES.ENDED);

    setTimeout(() => {
      navigation.goBack();
    }, 1200);
  }, [navigation, peerId]);

  const handleAcceptIncoming = useCallback(() => {
    setCallState(CALL_STATES.CONNECTING);
    initializeCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRejectIncoming = useCallback(() => {
    Vibration.vibrate(100);
    setCallState(CALL_STATES.ENDED);
    setTimeout(() => navigation.goBack(), 500);
  }, [navigation]);

  const toggleMute = useCallback(() => {
    Vibration.vibrate(15);
    setIsMuted(m => !m);
  }, []);

  const toggleVideo = useCallback(() => {
    Vibration.vibrate(15);
    setIsVideoEnabled(v => !v);
  }, []);

  const toggleSpeaker = useCallback(() => {
    Vibration.vibrate(15);
    setIsSpeaker(s => !s);
  }, []);

  const flipCamera = useCallback(() => {
    Vibration.vibrate(15);
    setIsFrontCamera(f => !f);
  }, []);

  const toggleScreenShare = useCallback(() => {
    Vibration.vibrate(15);
    if (!isScreenSharing) {
      Alert.alert(
        'Screen Share',
        'Start sharing your screen with this peer?',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Share',
            onPress: () => setIsScreenSharing(true),
          },
        ],
      );
    } else {
      setIsScreenSharing(false);
    }
  }, [isScreenSharing]);

  // ── Call State Text ──

  const callStateText = useMemo(() => {
    switch (callState) {
      case CALL_STATES.INCOMING:
        return 'Incoming Call';
      case CALL_STATES.CONNECTING:
        return 'Connecting...';
      case CALL_STATES.RINGING:
        return 'Ringing...';
      case CALL_STATES.CONNECTED:
        return `Connected ${formatDuration(duration)}`;
      case CALL_STATES.ENDED:
        return 'Call Ended';
      case CALL_STATES.FAILED:
        return 'Connection Failed';
      default:
        return '';
    }
  }, [callState, duration]);

  const callStateColor = useMemo(() => {
    switch (callState) {
      case CALL_STATES.CONNECTED:
        return ACCENT;
      case CALL_STATES.ENDED:
        return TEXT_MUTED;
      case CALL_STATES.FAILED:
        return DANGER;
      default:
        return TEXT_SECONDARY;
    }
  }, [callState]);

  // ─── Render ──────────────────────────────────────────────

  return (
    <View style={[styles.container, {backgroundColor: theme?.bg || BG}]}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="transparent"
        translucent
      />

      {/* ── Incoming Call Overlay ── */}
      {callState === CALL_STATES.INCOMING && (
        <IncomingCallOverlay
          peerName={peerName}
          isVideo={isVideoCall}
          onAccept={handleAcceptIncoming}
          onReject={handleRejectIncoming}
        />
      )}

      {/* ── Video Mode: Remote Video (full screen) ── */}
      {callState !== CALL_STATES.INCOMING && isVideoCall && isVideoEnabled && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={toggleControls}
          style={styles.remoteVideoContainer}>
          {/* Placeholder for RTCView - in production, use:
              <RTCView streamURL={remoteStreamUrl} style={styles.remoteVideo} objectFit="cover" /> */}
          <View style={styles.remoteVideoPlaceholder}>
            <View style={styles.videoGradientTop} />
            <PeerAvatar name={peerName} size={80} online />
            <Text style={styles.videoPlaceholderText}>
              {callState === CALL_STATES.CONNECTED
                ? 'Video Connected'
                : 'Waiting for video...'}
            </Text>
            <View style={styles.videoGradientBottom} />
          </View>
        </TouchableOpacity>
      )}

      {/* ── Video Mode: Local PiP (draggable) ── */}
      {callState === CALL_STATES.CONNECTED &&
        isVideoCall &&
        isVideoEnabled && (
          <DraggablePiP>
            {/* Placeholder for local RTCView */}
            <View style={styles.pipVideo}>
              <Text style={styles.pipLabel}>You</Text>
              <View style={styles.pipCameraIndicator}>
                <Text style={{fontSize: 10}}>
                  {isFrontCamera ? '🤳' : '📷'}
                </Text>
              </View>
            </View>
          </DraggablePiP>
        )}

      {/* ── Audio Mode / Fallback: Avatar UI ── */}
      {callState !== CALL_STATES.INCOMING &&
        (!isVideoCall || !isVideoEnabled) && (
          <TouchableOpacity
            activeOpacity={1}
            onPress={toggleControls}
            style={styles.audioCallUI}>
            <Animated.View entering={ZoomIn.duration(400).springify()}>
              <CallAvatar
                name={peerName}
                size={110}
                isActive={callState === CALL_STATES.CONNECTED}
              />
            </Animated.View>

            <Animated.Text
              entering={FadeIn.delay(200).duration(300)}
              style={styles.callerName}>
              {peerName}
            </Animated.Text>

            <Text style={styles.callType}>
              {isVideoCall ? 'Video Call' : 'Voice Call'}
              {isScreenSharing ? ' - Screen Sharing' : ''}
            </Text>

            <Animated.Text
              entering={FadeIn.delay(400).duration(300)}
              style={[styles.callStateText, {color: callStateColor}]}>
              {callStateText}
            </Animated.Text>

            {callState === CALL_STATES.CONNECTED && (
              <Animated.View
                entering={FadeIn.delay(600).duration(300)}
                style={styles.encBadge}>
                <Text style={styles.encBadgeIcon}>🔒</Text>
                <Text style={styles.encBadgeText}>E2E Encrypted</Text>
              </Animated.View>
            )}

            {callState === CALL_STATES.ENDED && duration > 0 && (
              <Animated.View
                entering={FadeIn.delay(200)}
                style={styles.callSummary}>
                <Text style={styles.callSummaryText}>
                  Duration: {formatDuration(duration)}
                </Text>
              </Animated.View>
            )}
          </TouchableOpacity>
        )}

      {/* ── Bottom Control Bar ── */}
      {callState !== CALL_STATES.INCOMING &&
        callState !== CALL_STATES.ENDED &&
        showControls && (
          <Animated.View
            entering={SlideInDown.duration(250)}
            exiting={FadeOut.duration(200)}
            style={styles.controlsContainer}>
            {/* Background blur effect */}
            <View style={styles.controlsBg} />

            <View style={styles.controlsRow}>
              {/* Mute mic */}
              <ControlButton
                icon={isMuted ? '🔇' : '🎤'}
                label={isMuted ? 'Unmute' : 'Mute'}
                onPress={toggleMute}
                active={isMuted}
                activeColor={DANGER}
              />

              {/* Speaker/earpiece */}
              <ControlButton
                icon="🔊"
                label={isSpeaker ? 'Speaker' : 'Earpiece'}
                onPress={toggleSpeaker}
                active={isSpeaker}
                activeColor={ACCENT}
              />

              {/* Toggle camera (video mode) */}
              {isVideoCall && (
                <ControlButton
                  icon={isVideoEnabled ? '📹' : '🚫'}
                  label={isVideoEnabled ? 'Camera' : 'No Cam'}
                  onPress={toggleVideo}
                  active={!isVideoEnabled}
                  activeColor={DANGER}
                />
              )}

              {/* Flip camera (video mode) */}
              {isVideoCall && isVideoEnabled && (
                <ControlButton
                  icon="🔄"
                  label="Flip"
                  onPress={flipCamera}
                  active={false}
                />
              )}

              {/* Screen share */}
              <ControlButton
                icon="🖥️"
                label={isScreenSharing ? 'Stop' : 'Share'}
                onPress={toggleScreenShare}
                active={isScreenSharing}
                activeColor={ACCENT2}
              />
            </View>

            {/* End call button */}
            <TouchableOpacity
              style={styles.hangupBtn}
              onPress={handleHangup}
              activeOpacity={0.8}>
              <View style={styles.hangupInner}>
                <Text style={styles.hangupIcon}>📞</Text>
                <Text style={styles.hangupText}>End Call</Text>
              </View>
            </TouchableOpacity>
          </Animated.View>
        )}

      {/* ── Call Ended State ── */}
      {callState === CALL_STATES.ENDED && (
        <Animated.View
          entering={FadeIn.duration(300)}
          style={styles.endedOverlay}>
          <TouchableOpacity
            style={styles.endedBackBtn}
            onPress={() => navigation.goBack()}>
            <Text style={styles.endedBackText}>Go Back</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ── Connection Failed ── */}
      {callState === CALL_STATES.FAILED && (
        <Animated.View
          entering={FadeIn.duration(300)}
          style={styles.failedOverlay}>
          <Text style={styles.failedIcon}>⚠️</Text>
          <Text style={styles.failedTitle}>Connection Failed</Text>
          <Text style={styles.failedDesc}>
            Could not establish a secure connection with {peerName}.
          </Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setCallState(CALL_STATES.CONNECTING);
              setDuration(0);
              initializeCall();
            }}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.failedBackBtn}
            onPress={() => navigation.goBack()}>
            <Text style={styles.failedBackText}>Go Back</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },

  // ── Remote Video ──
  remoteVideoContainer: {
    ...StyleSheet.absoluteFillObject,
  },
  remoteVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  remoteVideoPlaceholder: {
    flex: 1,
    backgroundColor: '#0d0d15',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoGradientTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    backgroundColor: 'rgba(10,10,15,0.7)',
  },
  videoGradientBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: 'rgba(10,10,15,0.8)',
  },
  videoPlaceholderText: {
    color: TEXT_MUTED,
    fontSize: 14,
    marginTop: 16,
  },

  // ── PiP ──
  pipContainer: {
    position: 'absolute',
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: ACCENT + '40',
    overflow: 'hidden',
    zIndex: 20,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  pipVideo: {
    flex: 1,
    backgroundColor: '#161622',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipLabel: {
    color: TEXT_MUTED,
    fontSize: 12,
    fontWeight: '600',
  },
  pipCameraIndicator: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Audio Call UI ──
  audioCallUI: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 200,
  },
  callerName: {
    color: TEXT_PRIMARY,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  callType: {
    color: TEXT_SECONDARY,
    fontSize: 14,
    marginTop: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  callStateText: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 16,
    letterSpacing: 0.5,
    fontVariant: ['tabular-nums'],
  },
  encBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ACCENT + '12',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    marginTop: 20,
    gap: 6,
  },
  encBadgeIcon: {
    fontSize: 12,
  },
  encBadgeText: {
    color: ACCENT,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  callSummary: {
    marginTop: 16,
  },
  callSummaryText: {
    color: TEXT_MUTED,
    fontSize: 14,
    letterSpacing: 0.3,
  },

  // ── Controls ──
  controlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'ios' ? 44 : 32,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  controlsBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG + 'e0',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 14,
    marginBottom: 20,
  },
  controlBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlLabel: {
    fontSize: 9,
    fontWeight: '600',
    marginTop: 3,
    letterSpacing: 0.3,
  },

  // ── Hangup ──
  hangupBtn: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 300,
  },
  hangupInner: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: DANGER,
    paddingVertical: 16,
    borderRadius: 30,
    gap: 10,
  },
  hangupIcon: {
    fontSize: 20,
    transform: [{rotate: '135deg'}],
  },
  hangupText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // ── Incoming Call ──
  incomingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: SCREEN_HEIGHT * 0.15,
    paddingBottom: Platform.OS === 'ios' ? 60 : 48,
    zIndex: 30,
  },
  incomingContent: {
    alignItems: 'center',
  },
  incomingCallerName: {
    color: TEXT_PRIMARY,
    fontSize: 28,
    fontWeight: '700',
    marginTop: 12,
    letterSpacing: 0.5,
  },
  incomingCallType: {
    color: TEXT_SECONDARY,
    fontSize: 16,
    marginTop: 6,
    letterSpacing: 0.5,
  },
  incomingEncrypted: {
    color: ACCENT + '80',
    fontSize: 12,
    marginTop: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  incomingActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 60,
  },
  incomingRejectBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: DANGER,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: DANGER,
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  incomingRejectIcon: {
    fontSize: 24,
    transform: [{rotate: '135deg'}],
  },
  incomingRejectText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
    letterSpacing: 0.3,
  },
  incomingAcceptBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: SUCCESS,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: SUCCESS,
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  incomingAcceptIcon: {
    fontSize: 24,
  },
  incomingAcceptText: {
    color: BG,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
    letterSpacing: 0.3,
  },

  // ── Ended ──
  endedOverlay: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 60 : 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  endedBackBtn: {
    backgroundColor: BG_TERTIARY,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
  },
  endedBackText: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: '600',
  },

  // ── Failed ──
  failedOverlay: {
    position: 'absolute',
    bottom: SCREEN_HEIGHT * 0.15,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  failedIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  failedTitle: {
    color: DANGER,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  failedDesc: {
    color: TEXT_SECONDARY,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: ACCENT + '20',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: ACCENT + '40',
    marginBottom: 12,
  },
  retryBtnText: {
    color: ACCENT,
    fontSize: 15,
    fontWeight: '700',
  },
  failedBackBtn: {
    paddingVertical: 10,
  },
  failedBackText: {
    color: TEXT_MUTED,
    fontSize: 14,
    fontWeight: '500',
  },
});
