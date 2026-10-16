import React, {useState, useCallback} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  Vibration,
  Clipboard,
  Platform,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text} from '../components/ScaledText';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTheme, FONT_SCALE} from '../context/ThemeContext';
import ScreenHeader from '../components/ScreenHeader';
import Icon from '../components/Icon';
import {version as APP_VERSION} from '../../package.json';
import {useApp} from '../context/AppContext';
import GhostMeshSetupModal from '../components/GhostMeshSetupModal';
import {MESH_SETUP_AVAILABLE, MESH_SETUP_UNAVAILABLE_REASON} from '../utils/capabilities';

// What the code uses (utils/crypto.js, utils/session-crypto.js). "Connection
// Type: P2P Direct" was dropped: a conversation can run over the mesh or a
// direct link, and the chat header already reports which one, per peer.
const SECURITY_INFO = [
  {label: 'Message encryption', value: 'AES-256-GCM'},
  {label: 'Key exchange', value: 'ECDH P-256'},
  {label: 'Hashing', value: 'SHA-256'},
];

export default function SettingsScreen({navigation}) {
  const {theme, fontSize, setFontSize} = useTheme();
  const insets = useSafeAreaInsets();
  const {identity, messages, wipeAll, ghostMesh, setGhostMesh} = useApp();
  const [pubKeyCopied, setPubKeyCopied] = useState(false);
  const [showMeshSetup, setShowMeshSetup] = useState(false);

  // ── Handlers ──

  const handleCopyPublicKey = useCallback(() => {
    if (identity?.publicKeyHex) {
      Clipboard.setString(identity.publicKeyHex);
      setPubKeyCopied(true);
      Vibration.vibrate(15);
      setTimeout(() => setPubKeyCopied(false), 2000);
    }
  }, [identity]);

  const doExport = useCallback(() => {
    Vibration.vibrate(20);
    const allMessages = {};
    if (messages && typeof messages.forEach === 'function') {
      messages.forEach((msgs, roomId) => {
        allMessages[roomId] = msgs;
      });
    }
    const exportData = {
      displayName: identity?.name || 'Unknown',
      messages: allMessages,
      exportedAt: new Date().toISOString(),
    };
    Clipboard.setString(JSON.stringify(exportData));
    Alert.alert('Copied', 'Your chat history is on the clipboard. Paste it somewhere safe, then copy something else over it.');
  }, [identity, messages]);

  // The export is plain text on the shared clipboard, where other apps and
  // keyboards can read it. Say so before doing it.
  const handleExport = useCallback(() => {
    Alert.alert(
      'Copy Chat History?',
      'Every message is copied as unencrypted text to the clipboard, which other apps on this phone can read.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Copy', onPress: doExport},
      ],
    );
  }, [doExport]);

  const handleWipeAll = useCallback(() => {
    Alert.alert(
      'Wipe All Data',
      'This will permanently delete all messages, keys, and identity. This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Wipe Everything',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'Last chance. All data will be permanently destroyed.',
              [
                {text: 'Cancel', style: 'cancel'},
                {
                  text: 'Confirm Wipe',
                  style: 'destructive',
                  onPress: async () => {
                    Vibration.vibrate([0, 100, 50, 100, 50, 200]);
                    // No navigation here: clearing the identity is what swaps
                    // the root navigator to Setup, and 'Setup' is not a route
                    // in this stack, so a reset to it was never handled.
                    const result = await wipeAll();
                    if (!result.ok) {
                      Alert.alert(
                        'Wipe incomplete',
                        `Could not remove: ${result.failed.join(', ')}. ` +
                          (Platform.OS === 'ios'
                            ? 'Delete the app and install it again to finish.'
                            : 'Clear the app data from Android settings to finish.'),
                      );
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [wipeAll]);

  // ── Derived values ──

  const displayName = identity?.name || 'Anonymous';

  const truncatedFingerprint = identity?.fingerprint
    ? identity.fingerprint.length > 16
      ? identity.fingerprint.slice(0, 16) + '\u2026'
      : identity.fingerprint
    : 'N/A';

  const truncatedPubKey = identity?.publicKeyHex
    ? identity.publicKeyHex.slice(0, 24) + '\u2026' + identity.publicKeyHex.slice(-8)
    : 'N/A';

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <ScreenHeader title="Settings" onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 32}]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Identity Card ── */}
        {identity && (
          <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            {/* Avatar — gradient circle with initial */}
            <View style={[styles.avatarOuter, {backgroundColor: theme.accentDim}]}>
              <View style={[styles.avatarInner, {borderColor: theme.accent}]}>
                <Text style={[styles.avatarLetter, {color: theme.accent}]}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            </View>

            <Text style={[styles.displayName, {color: theme.text}]}>{displayName}</Text>

            <Text style={[styles.fingerprint, {color: theme.textMuted}]}>
              {truncatedFingerprint}
            </Text>

            {/* Public key — tap to copy */}
            <TouchableOpacity
              style={[styles.pubKeyBox, {backgroundColor: theme.bgTertiary}]}
              onPress={handleCopyPublicKey}
              accessibilityRole="button"
              accessibilityLabel="Public key"
              accessibilityHint="Copies the full key"
              activeOpacity={0.7}>
              <Text style={[styles.pubKeyLabel, {color: theme.textSecondary}]}>Public key</Text>
              <Text style={[styles.pubKeyValue, {color: theme.textSecondary}]}>
                {truncatedPubKey}
              </Text>
              <View style={styles.copyHintRow}>
                <Icon name={pubKeyCopied ? 'check' : 'copy'} size={14} color={theme.accent} />
                <Text style={[styles.pubKeyCopyHint, {color: theme.accent}]}>
                  {pubKeyCopied ? 'Copied' : 'Copy full key'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Text size ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textSecondary}]} accessibilityRole="header">Text Size</Text>
          {/* Plain sizes: Text already applies the scale, so scale() here sized
              this line twice. */}
          <Text style={{color: theme.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 12}}>
            Applies everywhere, including your conversations.
          </Text>
          <View style={styles.fontRow}>
            {Object.entries(FONT_SCALE).map(([key, size]) => {
              const isSelected = fontSize === size;
              const label = key === 'extraLarge' ? 'Extra large' : key.charAt(0).toUpperCase() + key.slice(1);
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.fontChip,
                    {
                      backgroundColor: isSelected ? theme.accentDim : theme.bgTertiary,
                      borderColor: isSelected ? theme.accent : theme.border,
                    },
                  ]}
                  onPress={() => setFontSize(size)}
                  accessibilityRole="radio"
                  accessibilityState={{selected: isSelected}}
                  accessibilityLabel={`Text size ${label}`}
                  activeOpacity={0.7}>
                  <Text style={{color: isSelected ? theme.accent : theme.textSecondary, fontSize: size}}>
                    Aa
                  </Text>
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={{
                      color: isSelected ? theme.accent : theme.textSecondary,
                      fontSize: 12,
                      marginTop: 4,
                    }}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textSecondary}]} accessibilityRole="header">Security</Text>
          {SECURITY_INFO.map((item, idx) => (
            <View
              key={item.label}
              style={[
                styles.secRow,
                idx < SECURITY_INFO.length - 1 && {
                  borderBottomWidth: 1,
                  borderBottomColor: theme.border,
                },
              ]}>
              <Text style={[styles.secLabel, {color: theme.textSecondary}]}>{item.label}</Text>
              <Text style={[styles.secValue, {color: theme.text}]}>{item.value}</Text>
            </View>
          ))}
        </View>

        {/* The Preferences card (Notifications, Sounds, Read Receipts) is gone:
            settings v3 dropped those keys because nothing implemented them, so
            the switches flipped and changed nothing. The second text-size
            control, a 11–18 slider, is gone too: it fought the chips above and
            could not show their Large and Extra large sizes. */}

        {/* ── Action Buttons ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textSecondary}]} accessibilityRole="header">Your Data</Text>

          <TouchableOpacity
            style={[styles.actionRow, {borderBottomWidth: 1, borderBottomColor: theme.border}]}
            onPress={handleExport}
            accessibilityRole="button"
            activeOpacity={0.7}>
            <Text style={[styles.actionText, {color: theme.text}]}>Copy Chat History</Text>
            <Icon name="copy" size={20} color={theme.textMuted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionRow}
            onPress={() => {
              Vibration.vibrate(15);
              navigation.navigate('Recovery');
            }}
            accessibilityRole="button"
            activeOpacity={0.7}>
            <Text style={[styles.actionText, {color: theme.text}]}>Back Up Identity</Text>
            <Icon name="chevronRight" size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>

        {/* ── Ghost Mesh (Advanced) ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textSecondary}]} accessibilityRole="header">Ghost Mesh (Advanced)</Text>

          <View style={styles.toggleRow}>
            <View style={{flex: 1}}>
              <Text style={[styles.toggleLabel, {color: theme.text}]}>Ghost Mesh (Yggdrasil)</Text>
              <Text style={{fontSize: 13, color: theme.textSecondary, marginTop: 2}}>
                {ghostMesh.address
                  ? `Address: ${ghostMesh.address}`
                  : 'Direct peer-to-peer transport over Yggdrasil mesh network.'}
              </Text>
            </View>
            <View style={{alignItems: 'flex-end', gap: 6}}>
              {/* Status tag: palette colours, and the word carries the state. */}
              {(() => {
                const tone =
                  ghostMesh.status === 'active' ? theme.success :
                  ghostMesh.status === 'configured' ? theme.warning : theme.textSecondary;
                return (
                  <View style={[styles.meshStatusTag, {borderColor: tone}]}>
                    <Text style={[styles.meshStatusText, {color: tone}]}>
                      {ghostMesh.status === 'active' ? 'Active' :
                       ghostMesh.status === 'configured' ? 'Configured' : 'Not configured'}
                    </Text>
                  </View>
                );
              })()}
              {ghostMesh.address ? (
                <Switch
                  value={ghostMesh.enabled}
                  onValueChange={v => {
                    Vibration.vibrate(10);
                    setGhostMesh({
                      enabled: v,
                      status: v ? 'active' : 'configured',
                    });
                  }}
                  trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
                  thumbColor={ghostMesh.enabled ? theme.accent : theme.textMuted}
                  accessibilityLabel="Ghost Mesh"
                />
              ) : null}
            </View>
          </View>

          {/*
            Disabled, not hidden. "Verify & Continue" inside this modal calls
            CryptoService.deriveLegacyYggdrasilIP(), which reaches for
            react-native-quick-crypto — absent from this build, and stood in
            for by a Proxy that throws on any access so it cannot return wrong
            bytes. Opening this is a crash the user can trigger from Settings.
            See utils/capabilities.js.
          */}
          <TouchableOpacity
            style={[
              styles.actionRow,
              {borderTopWidth: 1, borderTopColor: theme.border, marginTop: 8},
              !MESH_SETUP_AVAILABLE && {opacity: 0.35},
            ]}
            disabled={!MESH_SETUP_AVAILABLE}
            accessibilityRole="button"
            accessibilityState={{disabled: !MESH_SETUP_AVAILABLE}}
            accessibilityLabel={
              MESH_SETUP_AVAILABLE
                ? (ghostMesh.address ? 'Reconfigure Ghost Mesh' : 'Configure Ghost Mesh')
                : MESH_SETUP_UNAVAILABLE_REASON
            }
            onPress={() => {
              if (!MESH_SETUP_AVAILABLE) return;
              setShowMeshSetup(true);
            }}
            activeOpacity={0.7}>
            <Text style={[styles.actionText, {color: theme.text}]}>
              {ghostMesh.address ? 'Reconfigure' : 'Configure'}
            </Text>
            <Icon name="chevronRight" size={20} color={theme.textMuted} />
          </TouchableOpacity>

          {!MESH_SETUP_AVAILABLE ? (
            <Text
              style={{fontSize: 13, color: theme.textSecondary, marginTop: 6, lineHeight: 18}}
              accessibilityRole="text">
              {MESH_SETUP_UNAVAILABLE_REASON}.
            </Text>
          ) : null}

          <Text style={{fontSize: 13, color: theme.textSecondary, marginTop: 8, lineHeight: 18}}>
            On mobile, Ghost Mesh operates in Web Client mode {String.fromCharCode(8212)} it derives
            your Yggdrasil identity for peer discovery but uses WebRTC for transport. Full direct
            TCP mesh connections require the desktop Electron app.
          </Text>
        </View>

        {/* ── Destructive Wipe Button ── */}
        <TouchableOpacity
          style={[styles.dangerBtn, {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'}]}
          onPress={handleWipeAll}
          accessibilityRole="button"
          activeOpacity={0.7}>
          <Text style={[styles.dangerBtnLabel, {color: theme.danger}]}>Wipe All Data</Text>
        </TouchableOpacity>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          {/* Read from package.json; this said v2.0 on a 0.0.x build. */}
          <Text style={[styles.footerText, {color: theme.textMuted}]}>
            GhostLink {APP_VERSION}
          </Text>
        </View>
      </ScrollView>

      {/* Ghost Mesh Setup Modal */}
      <GhostMeshSetupModal
        visible={MESH_SETUP_AVAILABLE && showMeshSetup}
        onClose={() => setShowMeshSetup(false)}
        onComplete={({address, publicKeyHex}) => {
          setGhostMesh({
            enabled: true,
            address,
            publicKeyHex,
            status: 'active',
          });
          setShowMeshSetup(false);
          Alert.alert('Ghost Mesh Configured', 'Your Yggdrasil identity has been saved and Ghost Mesh is now active.');
        }}
      />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  /* Scroll */
  scroll: {
    padding: 16,
  },

  /* Card */
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    marginBottom: 14,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },

  /* Identity */
  avatarOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  avatarInner: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: {
    fontSize: 30,
    fontWeight: '800',
  },
  displayName: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  fingerprint: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: 14,
  },
  pubKeyBox: {
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  pubKeyLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  pubKeyValue: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  copyHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 24,
  },
  pubKeyCopyHint: {
    fontSize: 13,
    fontWeight: '600',
  },

  fontRow: {
    flexDirection: 'row',
    gap: 8,
  },
  fontChip: {
    flex: 1,
    minHeight: 64,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  /* Security */
  secRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    minHeight: 44,
    paddingVertical: 8,
  },
  secLabel: {
    fontSize: 15,
  },
  secValue: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  /* Toggles */
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  toggleLabel: {
    fontSize: 16,
    flex: 1,
  },

  /* Action Rows */
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
  },
  actionText: {
    fontSize: 16,
  },

  /* Danger */
  dangerBtn: {
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 50,
    justifyContent: 'center',
    padding: 14,
    alignItems: 'center',
    marginBottom: 20,
  },
  dangerBtnLabel: {
    fontSize: 16,
    fontWeight: '600',
  },

  /* Ghost Mesh */
  meshStatusTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  meshStatusText: {
    fontSize: 12,
    fontWeight: '600',
  },

  /* Footer */
  footer: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  footerText: {
    fontSize: 13,
  },
});
