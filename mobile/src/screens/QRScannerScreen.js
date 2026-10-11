/**
 * GhostLink Mobile — QR scanner: read someone's Ghost Address, or show yours.
 * Uses react-native-vision-camera's native useCodeScanner.
 */
import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Vibration,
  Alert,
  Dimensions,
  Linking,
  ActivityIndicator,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text} from '../components/ScaledText';
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import QRCode from 'react-native-qrcode-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';
import {normalizeGhostAddress} from '../utils/ghost-address';
import {cleanDisplayName, cleanPublicKeyHex} from '../utils/untrusted';

const INVITE_CODE_REGEX = /^GL-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/;
const {width: SCREEN_WIDTH} = Dimensions.get('window');
const QR_SIZE = Math.min(SCREEN_WIDTH - 96, 260);

/**
 * Classify a scanned payload: Ghost Address first, then the older GL- invite
 * code and JSON invite blob.
 */
export function classifyScan(raw) {
  const text = String(raw || '').trim();
  if (!text) return {kind: 'empty'};

  const ghost = normalizeGhostAddress(text);
  if (ghost) return {kind: 'ghost', address: ghost};

  // A JSON invite may carry the address inside it.
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      // `c` is where the web client's invite QR puts the address
      // ({c: address, n: name, p: publicKeyHex, t: timestamp}).
      const inner = normalizeGhostAddress(
        parsed.ghostAddress || parsed.address || parsed.a || parsed.c || '',
      );
      if (inner) {
        // name and key are whatever the QR's author wrote. A non-string name
        // was saved with the peer and crashed the chat list on every launch
        // after — see utils/untrusted.js.
        return {
          kind: 'ghost',
          address: inner,
          name: cleanDisplayName(parsed.name ?? parsed.n),
          // The web ships the peer's public key alongside the address; keep it,
          // it is what lets a message be sealed to them.
          publicKeyHex: cleanPublicKeyHex(parsed.publicKeyHex ?? parsed.p),
        };
      }
      const code = parsed.code || parsed.c;
      if (code && INVITE_CODE_REGEX.test(String(code).toUpperCase())) {
        return {kind: 'invite', code: String(code).toUpperCase(), name: cleanDisplayName(parsed.name ?? parsed.n)};
      }
    } catch (_) {
      // fall through to the unknown case
    }
    return {kind: 'unknown', text};
  }

  const upper = text.toUpperCase();
  if (INVITE_CODE_REGEX.test(upper)) return {kind: 'invite', code: upper};

  return {kind: 'unknown', text};
}

export default function QRScannerScreen({navigation}) {
  const {theme} = useTheme();
  const {state, dispatch, identity} = useApp();
  const [mode, setMode] = useState('scan');
  const [busy, setBusy] = useState(false);

  // One scan at a time. onCodeScanned fires per frame while a code is in view,
  // so without this the same address is added dozens of times in a second.
  const handling = useRef(false);

  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');

  const scanLineY = useSharedValue(0);
  useEffect(() => {
    scanLineY.value = withRepeat(
      withSequence(withTiming(1, {duration: 2000}), withTiming(0, {duration: 2000})),
      -1,
    );
  }, [scanLineY]);
  const scanLineStyle = useAnimatedStyle(() => ({top: `${scanLineY.value * 100}%`}));

  useEffect(() => {
    if (mode === 'scan' && !hasPermission) {
      requestPermission();
    }
  }, [mode, hasPermission, requestPermission]);

  const resume = useCallback(() => {
    handling.current = false;
    setBusy(false);
  }, []);

  const addPeer = useCallback(
    async ({address, code, name, publicKeyHex}) => {
      const peerId = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fingerprint = await CryptoEngine.sha256(address || code);
      dispatch({
        type: 'ADD_PEER',
        payload: {
          id: peerId,
          name: name || address || `Peer ${(state.peers?.size ?? 0) + 1}`,
          ghostAddress: address || '',
          // Carried from the invite. classifyScan reads it out of the web
          // client's QR, and without storing it there is nothing to seal a
          // message to that peer with.
          publicKeyHex: publicKeyHex || '',
          inviteCode: address ? '' : code,
          fingerprint: fingerprint.slice(0, 16),
          online: false,
          pinned: false,
          muted: false,
          roomId: `room-${peerId}`,
          addedAt: Date.now(),
        },
      });
      Vibration.vibrate(40);
      navigation.navigate('ChatList');
    },
    [dispatch, navigation, state.peers],
  );

  const onScanned = useCallback(
    (codes) => {
      if (handling.current) return;
      const value = codes?.find(c => c?.value)?.value;
      if (!value) return;

      handling.current = true;
      setBusy(true);
      Vibration.vibrate([0, 50, 50, 50]);

      const result = classifyScan(value);

      if (result.kind === 'ghost') {
        if (identity?.ghostAddress && result.address === identity.ghostAddress) {
          Alert.alert('That is your own address', 'Point the camera at someone else\'s code.', [
            {text: 'OK', onPress: resume},
          ]);
          return;
        }
        const existing = Array.from(state.peers?.values?.() ?? []).find(
          p => p.ghostAddress === result.address,
        );
        if (existing) {
          Alert.alert('Already added', `${result.address} is already in your peers.`, [
            {text: 'OK', onPress: resume},
          ]);
          return;
        }
        Alert.alert('Add this peer?', result.address, [
          {text: 'Cancel', style: 'cancel', onPress: resume},
          {text: 'Add', onPress: () => addPeer(result)},
        ]);
        return;
      }

      if (result.kind === 'invite') {
        // No signature is verified here; the alert says so plainly.
        Alert.alert(
          'Legacy invite code',
          `${result.code}\n\nThis older format carries no signature, so there is nothing to verify it against. Add it only if you trust where you scanned it.`,
          [
            {text: 'Cancel', style: 'cancel', onPress: resume},
            {text: 'Add anyway', onPress: () => addPeer(result)},
          ],
        );
        return;
      }

      const preview = result.text && result.text.length > 120
        ? result.text.slice(0, 120) + '…'
        : result.text || '';
      Alert.alert('Not a GhostLink code', preview, [
        {text: 'OK', onPress: resume},
        {
          text: 'Copy',
          onPress: () => {
            Clipboard.setString(result.text || '');
            resume();
          },
        },
      ]);
    },
    [addPeer, identity, resume, state.peers],
  );

  const codeScanner = useCodeScanner({codeTypes: ['qr'], onCodeScanned: onScanned});

  const copyMine = useCallback(() => {
    if (!identity?.ghostAddress) return;
    Clipboard.setString(identity.ghostAddress);
    Vibration.vibrate(15);
    Alert.alert('Copied', identity.ghostAddress);
  }, [identity]);

  const renderScanner = () => {
    if (!hasPermission) {
      return (
        <View style={styles.stateBox}>
          <Text style={[styles.stateTitle, {color: theme.text}]}>Camera access needed</Text>
          <Text style={[styles.stateDesc, {color: theme.textSecondary}]}>
            The camera is used only to read a QR code on this device. Nothing is recorded or sent
            anywhere.
          </Text>
          <TouchableOpacity
            style={[styles.stateBtn, {backgroundColor: theme.accent}]}
            onPress={async () => {
              const granted = await requestPermission();
              // A second refusal means the OS will no longer prompt, so the
              // only way back is Settings.
              if (!granted) Linking.openSettings();
            }}
            activeOpacity={0.8}>
            <Text style={[styles.stateBtnText, {color: theme.bg}]}>Allow camera</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (!device) {
      return (
        <View style={styles.stateBox}>
          <Text style={[styles.stateTitle, {color: theme.text}]}>No camera found</Text>
          <Text style={[styles.stateDesc, {color: theme.textSecondary}]}>
            This device has no back camera available. Paste a Ghost Address on the peers screen
            instead.
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.scannerWrap}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={mode === 'scan'}
          codeScanner={codeScanner}
        />
        <View style={styles.overlay} pointerEvents="none">
          <View style={[styles.reticle, {borderColor: theme.accent}]}>
            {!busy && (
              <Animated.View
                style={[styles.scanLine, {backgroundColor: theme.accent}, scanLineStyle]}
              />
            )}
          </View>
          <Text style={[styles.hint, {color: theme.textSecondary}]}>
            {busy ? 'Reading…' : 'Point at a GhostLink QR code'}
          </Text>
        </View>
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )}
      </View>
    );
  };

  const renderMine = () => (
    <Animated.View entering={FadeIn.duration(200)} style={styles.mineWrap}>
      {identity?.ghostAddress ? (
        <>
          <View style={[styles.qrFrame, {backgroundColor: '#FFFFFF', borderColor: theme.border}]}>
            <QRCode value={identity.ghostAddress} size={QR_SIZE} backgroundColor="#FFFFFF" color="#000000" />
          </View>
          <Text style={[styles.mineLabel, {color: theme.textMuted}]}>YOUR GHOST ADDRESS</Text>
          <TouchableOpacity onPress={copyMine} activeOpacity={0.7}>
            <Text style={[styles.mineValue, {color: theme.accent}]} selectable>
              {identity.ghostAddress}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.mineHint, {color: theme.textMuted}]}>
            Let a peer scan this, or tap the address to copy it.
          </Text>
        </>
      ) : (
        <View style={styles.stateBox}>
          <Text style={[styles.stateTitle, {color: theme.text}]}>No address yet</Text>
          <Text style={[styles.stateDesc, {color: theme.textSecondary}]}>
            Your Ghost Address is derived from your recovery phrase when you set up an identity.
          </Text>
        </View>
      )}
    </Animated.View>
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn} activeOpacity={0.7}>
          <Text style={[styles.backText, {color: theme.accent}]}>{'←'} Back</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {color: theme.text}]}>
          {mode === 'scan' ? 'Scan a code' : 'My code'}
        </Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.tabBar}>
        {[
          ['scan', 'Scan'],
          ['show', 'My code'],
        ].map(([key, label]) => (
          <TouchableOpacity
            key={key}
            style={[
              styles.tab,
              {
                backgroundColor: mode === key ? theme.accentDim : 'transparent',
                borderColor: mode === key ? theme.accent : theme.border,
              },
            ]}
            onPress={() => {
              setMode(key);
              resume();
            }}
            activeOpacity={0.7}>
            <Text
              style={{
                color: mode === key ? theme.accent : theme.textSecondary,
                fontWeight: '700',
                fontSize: 14,
              }}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.body}>{mode === 'scan' ? renderScanner() : renderMine()}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  backBtn: {minWidth: 72},
  backText: {fontSize: 15, fontWeight: '600'},
  headerTitle: {fontSize: 16, fontWeight: '700'},
  tabBar: {flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 12},
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  body: {flex: 1},
  scannerWrap: {flex: 1, overflow: 'hidden'},
  overlay: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reticle: {
    width: QR_SIZE,
    height: QR_SIZE,
    borderWidth: 2,
    borderRadius: 16,
    overflow: 'hidden',
  },
  scanLine: {position: 'absolute', left: 0, right: 0, height: 2, opacity: 0.9},
  hint: {marginTop: 20, fontSize: 13},
  busyOverlay: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  mineWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  qrFrame: {padding: 16, borderRadius: 16, borderWidth: 1},
  mineLabel: {marginTop: 24, fontSize: 11, letterSpacing: 1.5, fontWeight: '700'},
  mineValue: {marginTop: 8, fontSize: 20, fontWeight: '800', letterSpacing: 1},
  mineHint: {marginTop: 14, fontSize: 12, textAlign: 'center', lineHeight: 18},
  stateBox: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32},
  stateTitle: {fontSize: 18, fontWeight: '700', marginBottom: 10},
  stateDesc: {fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 22},
  stateBtn: {paddingHorizontal: 26, paddingVertical: 13, borderRadius: 12},
  stateBtnText: {fontSize: 14, fontWeight: '700'},
});
