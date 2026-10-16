import React, {useState, useCallback, useMemo, useEffect, useRef} from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Vibration,
  Alert,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from '../components/ScaledText';
import ScreenHeader from '../components/ScreenHeader';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {
  CryptoEngine,
  generateBackupFragments,
  FRAGMENT_SHARES,
  FRAGMENT_THRESHOLD,
  generateSeedPhrase,
} from '../utils/crypto';
import {
  wrapIdentity,
  deriveRecoveryTag,
  restoreFromPhrase,
  restoreFromFragments,
  unlockBundle,
  saveRecoveryBundle,
  RecoveryError,
} from '../utils/recovery';
import {distributor} from '../services/MobileDistributor';
import {useSecureScreen} from '../utils/useSecureScreen';
import {
  GUARDIAN_RECOVERY_AVAILABLE,
  GUARDIAN_RECOVERY_UNAVAILABLE_REASON,
} from '../utils/capabilities';

// ─── Constants ──────────────────────────────────────────────────
const TABS = ['Backup', 'Verify', 'Restore'];

// Labels, not statuses, so they share one neutral style. They were three
// off-palette neons (#00ffa3, #44ddff, #ff00ff) that read as three states.
const LAYER_BADGES = ['Recovery phrase', 'Shamir shares', 'Peer recovery'];

// Lightweight BIP39-style word list (same as AppContext uses)

// ─── Component ──────────────────────────────────────────────────
export default function RecoveryScreen({navigation}) {
  const {theme} = useTheme();
  const {identity, setIdentity, legacyRecovery, confirmRecoveryPhrase} = useApp();
  const webrtcRef = useRef(null);

  // Shows and accepts recovery phrases: keep them out of screenshots.
  useSecureScreen();

  useEffect(() => {
    const initWebRTC = async () => {
      try {
        // A short-lived transport of its own, not the app-wide one. Guardian
        // rendezvous needs a serverless transport (see MOBILE_BUILD.md).
        const {WebRTCService} = await import('../services/WebRTCService');

        const webrtc = new WebRTCService();
        distributor.useWebRTC(webrtc);
        webrtcRef.current = webrtc;
      } catch (e) {
        console.warn('[RecoveryScreen] WebRTC init failed:', e);
      }
    };

    initWebRTC();

    return () => {
      if (webrtcRef.current) {
        webrtcRef.current.destroy();
      }
    };
  }, []);

  // Tab state
  const [activeTab, setActiveTab] = useState(0);

  // Backup state
  const [seedPhrase, setSeedPhrase] = useState(() => generateSeedPhrase());
  const [fragments, setFragments] = useState([]);
  const [fragmentDist, setFragmentDist] = useState({});
  const [distributing, setDistributing] = useState(false);
  // fragmentDist shape: { fragmentIndex: { distributed: bool, peerName: string } }

  // Verify state
  const [verifyInputs, setVerifyInputs] = useState(['', '', '']);
  const [verifyResult, setVerifyResult] = useState(null); // null | 'success' | 'fail'

  // Restore state
  const [restoreStep, setRestoreStep] = useState(1);
  const [restoreSeedInput, setRestoreSeedInput] = useState('');
  const [restoreDerivStatus, setRestoreDerivStatus] = useState(null); // null | 'deriving' | 'success' | 'fail'
  const [shamirInputs, setShamirInputs] = useState(['', '', '']);
  const [shamirStatus, setShamirStatus] = useState(null); // null | 'combining' | 'success' | 'fail'

  // Peer state for P2P distribution
  const [connectedPeers, setConnectedPeers] = useState([]);
  const [showPeerPicker, setShowPeerPicker] = useState(false);
  const [pendingFragment, setPendingFragment] = useState(null);

  // ── Older recovery data: confirm the phrase before it is deleted ──
  const [legacyPhraseInput, setLegacyPhraseInput] = useState('');
  const [legacyBusy, setLegacyBusy] = useState(false);
  const handleConfirmLegacyPhrase = useCallback(async () => {
    const words = legacyPhraseInput.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (words.length !== 12) {
      Alert.alert('Invalid', 'Please enter exactly 12 words.');
      return;
    }
    setLegacyBusy(true);
    try {
      const {deleted} = await confirmRecoveryPhrase(words);
      setLegacyPhraseInput('');
      Alert.alert('Done', `Your phrase is confirmed and a current recovery backup is saved. Removed from this phone: ${deleted.length} older recovery item(s).`);
    } catch (e) {
      Alert.alert(
        e && e.code === 'WRONG_PHRASE' ? 'Not this identity\'s phrase' : 'Could not finish',
        (e && e.message) || 'Nothing was deleted.',
      );
    } finally {
      setLegacyBusy(false);
    }
  }, [legacyPhraseInput, confirmRecoveryPhrase]);

  // ── Backup Handlers ──

  const handleGenerateFragments = useCallback(async () => {
    Vibration.vibrate(20);
    try {
      // Fragments carry the private key wrapped under the phrase, never the
      // phrase itself.
      const stored = await CryptoEngine.loadKeyPair();
      if (!stored || !stored.privateKeyRaw) {
        Alert.alert(
          'No key available',
          'Your private key could not be read from the keychain, so there is nothing to back up yet.',
        );
        return;
      }

      setDistributing(true);
      const bundle = await wrapIdentity(
        {
          privateKeyRaw: stored.privateKeyRaw,
          publicKeyHex: stored.publicKeyHex,
          name: identity?.name || '',
          ghostAddress: identity?.ghostAddress || '',
        },
        seedPhrase,
      );

      const frags = generateBackupFragments(JSON.stringify(bundle));
      setFragments(frags);
      setFragmentDist({});
      setHandedOut({}); // new shares: nothing of these has been handed out

      // The phrase shown on this screen is the one these fragments are wrapped
      // under, so it has to become the phrase that unlocks this device too —
      // otherwise the new fragments and the stored bundle disagree.
      await saveRecoveryBundle(bundle);
      // Fragments are never stored: they exist in memory for the user to hand out.
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to generate backup fragments.');
    } finally {
      setDistributing(false);
    }
  }, [identity, seedPhrase]);

  const handleCopyPhrase = useCallback(() => {
    Clipboard.setString(seedPhrase.join(' '));
    Vibration.vibrate(15);
    Alert.alert('Copied', 'Seed phrase copied to clipboard. Store it safely offline.');
  }, [seedPhrase]);

  const handleRegenerate = useCallback(() => {
    Alert.alert(
      'Regenerate Seed?',
      'This will generate a completely new seed phrase. The old one will be lost.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Regenerate',
          onPress: () => {
            Vibration.vibrate(20);
            setSeedPhrase(generateSeedPhrase());
            setFragments([]);
            setFragmentDist({});
          },
        },
      ],
    );
  }, []);

  const handleCopyFragment = useCallback((frag, idx) => {
    Clipboard.setString(frag.data);
    Vibration.vibrate(15);
    Alert.alert(
      'Copied',
      `Fragment ${frag.id} of ${FRAGMENT_SHARES} is on the clipboard. Paste it somewhere that is not this phone — to the person who will keep it, or write it down — then mark it handed out.`,
    );
  }, []);

  const handleGiveFragment = useCallback(async (frag, idx) => {
    // No guardian can receive and hold a fragment yet, so there is nothing to
    // send to — and nothing may be reported as held.
    if (!GUARDIAN_RECOVERY_AVAILABLE) {
      Alert.alert('Unavailable', GUARDIAN_RECOVERY_UNAVAILABLE_REASON);
      return;
    }
    setPendingFragment({frag, idx});
    setShowPeerPicker(true);
  }, []);

  const handleSelectPeer = useCallback(
    async peer => {
      if (!pendingFragment) return;

      const {frag, idx} = pendingFragment;
      setShowPeerPicker(false);
      if (!GUARDIAN_RECOVERY_AVAILABLE) {
        setPendingFragment(null);
        return;
      }
      setDistributing(true);

      try {
        if (webrtcRef.current && distributor) {
          // Same derivation the restoring device uses, so the lookup matches.
          const tag = await deriveRecoveryTag(seedPhrase);

          const stored = await CryptoEngine.loadKeyPair();
          if (!stored || !stored.privateKeyRaw) {
            Alert.alert('No key available', 'There is no private key on this device to back up.');
            return;
          }

          // What a peer holds is the wrapped bundle, never the phrase. Handing
          // peers the 12 words would let a single one of them read everything
          // the phrase unlocks, which defeats distributing shares at all.
          const bundle = await wrapIdentity(
            {
              privateKeyRaw: stored.privateKeyRaw,
              publicKeyHex: stored.publicKeyHex,
              name: identity?.name || '',
              ghostAddress: identity?.ghostAddress || '',
            },
            seedPhrase,
          );

          const result = await distributor.distribute(
            {tag, ...bundle},
            [peer],
            {n: 1, k: 1},
          );

          if (result.ok) {
            Vibration.vibrate(15);
            setFragmentDist(prev => ({
              ...prev,
              [idx]: {distributed: true, peerName: peer.name || peer.id},
            }));
            Alert.alert('Distributed', `Fragment ${frag.id} sent to ${peer.name || peer.id} via P2P.`);
          } else {
            throw new Error('Distribution failed');
          }
        } else {
          Clipboard.setString(frag.data);
          Vibration.vibrate(15);
          Alert.alert(
            'Not sent',
            `P2P not available. Fragment ${frag.id} was copied to the clipboard instead — it has not reached ${peer.name || peer.id}.`,
          );
        }
      } catch (e) {
        console.warn('[RecoveryScreen] Distribution error:', e);
        Clipboard.setString(frag.data);
        Vibration.vibrate(15);
        Alert.alert(
          'Not sent',
          `P2P distribution failed. Fragment ${frag.id} was copied to the clipboard instead — it has not reached ${peer.name || peer.id}.`,
        );
      } finally {
        setDistributing(false);
        setPendingFragment(null);
      }
    },
    [pendingFragment, identity, seedPhrase],
  );

  const handleManualGive = useCallback(
    (frag, idx) => {
      Alert.alert(
        'Manual Sharing',
        `Fragment ${frag.id} will be copied to clipboard. Share it with your trusted peer manually.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Copy',
            onPress: () => {
              Clipboard.setString(frag.data);
              Vibration.vibrate(15);
              Alert.alert('Copied', `Fragment ${frag.id} copied to clipboard.`);
            },
          },
        ],
      );
    },
    [],
  );

  // ── Verify Handlers ──

  const handleVerify = useCallback(() => {
    Vibration.vibrate(15);
    const checks = [
      {index: 2, word: verifyInputs[0].trim().toLowerCase()},
      {index: 6, word: verifyInputs[1].trim().toLowerCase()},
      {index: 10, word: verifyInputs[2].trim().toLowerCase()},
    ];
    const pass = checks.every((c) => seedPhrase[c.index] === c.word);
    setVerifyResult(pass ? 'success' : 'fail');
    Vibration.vibrate(pass ? [0, 50, 50, 50] : [0, 200]);
  }, [verifyInputs, seedPhrase]);

  // ── Restore Handlers ──

  const handleDeriveSeed = useCallback(async () => {
    Vibration.vibrate(20);
    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length !== 12) {
      Alert.alert('Invalid', 'Please enter exactly 12 words.');
      return;
    }

    setRestoreDerivStatus('deriving');

    try {
      // Unwraps the private key stored at setup.
      const identity = await restoreFromPhrase(words);

      setRestoreDerivStatus('success');
      Vibration.vibrate([0, 50, 50, 100]);
      setIdentity(identity);

      setTimeout(() => {
        navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
      }, 1200);
    } catch (e) {
      setRestoreDerivStatus('fail');
      if (e.code === RecoveryError.NO_LOCAL_BUNDLE) {
        // Nothing to unwrap here, so send them to the fragment path rather than
        // implying the phrase was wrong.
        Alert.alert('No identity on this device', e.message);
        setRestoreStep(2);
      } else {
        Alert.alert('Recovery failed', e.message || 'Could not restore this identity.');
      }
    }
  }, [restoreSeedInput, setIdentity, navigation]);

  const handleShamirRestore = useCallback(async () => {
    Vibration.vibrate(20);

    const validFrags = shamirInputs.map((f) => f.trim()).filter((f) => f.length > 0);
    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (validFrags.length < 3 && (!GUARDIAN_RECOVERY_AVAILABLE || connectedPeers.length === 0)) {
      Alert.alert(
        'Need Fragments',
        GUARDIAN_RECOVERY_AVAILABLE
          ? 'Please paste at least 3 recovery fragments or connect to peers for P2P recovery.'
          : 'Please paste at least 3 recovery fragments.',
      );
      return;
    }

    // Fragments carry only the wrapped private key. Without the phrase there is
    // nothing to unwrap it with, so ask for it before doing any work rather
    // than after reconstructing.
    if (words.length !== 12) {
      Alert.alert(
        'Recovery phrase needed',
        'Enter your 12-word phrase in step 1 as well. The fragments hold your key in encrypted form; the phrase is what unlocks it.',
      );
      setRestoreStep(1);
      return;
    }

    setShamirStatus('combining');

    if (validFrags.length >= 3) {
      try {
        const identity = await restoreFromFragments(validFrags, words);
        setShamirStatus('success');
        Vibration.vibrate([0, 50, 50, 50, 50, 100]);
        setIdentity(identity);
        setTimeout(() => {
          navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
        }, 1200);
        return;
      } catch (e) {
        setShamirStatus('fail');
        Alert.alert(
          e.code === RecoveryError.WRONG_PHRASE ? 'Phrase does not match' : 'Recovery failed',
          e.message || 'Those fragments could not be combined.',
        );
        return;
      }
    }

    if (GUARDIAN_RECOVERY_AVAILABLE && connectedPeers.length > 0 && distributor) {
      try {
        const tag = await deriveRecoveryTag(words);
        const blob = await distributor.recover(tag, connectedPeers, {k: 1});
        // Peers hold the same wrapped bundle, so it unlocks the same way.
        const identity = await unlockBundle(blob, words);
        // The key goes to the keystore; app state never holds it.
        await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
        await saveRecoveryBundle(blob);

        setShamirStatus('success');
        Vibration.vibrate([0, 50, 50, 50, 50, 100]);
        setIdentity(identity);
        setTimeout(() => {
          navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
        }, 1200);
        return;
      } catch (e) {
        console.warn('[RecoveryScreen] P2P recovery failed:', e);
        setShamirStatus('fail');
        Alert.alert('Recovery failed', e.message || 'No peer could return your backup.');
        return;
      }
    }

    setShamirStatus('fail');
  }, [shamirInputs, connectedPeers, setIdentity, navigation, restoreSeedInput, distributor]);

  const handleRecoverFromPeers = useCallback(async () => {
    if (!GUARDIAN_RECOVERY_AVAILABLE) {
      Alert.alert('Unavailable', GUARDIAN_RECOVERY_UNAVAILABLE_REASON);
      return;
    }
    if (connectedPeers.length === 0) {
      Alert.alert('No Peers', 'Connect to peers first to recover via P2P.');
      return;
    }

    setShamirStatus('combining');

    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length !== 12) {
      Alert.alert(
        'Recovery phrase needed',
        'Enter your 12-word phrase first. Peers hold your key in encrypted form; the phrase is what unlocks it.',
      );
      setShamirStatus(null);
      setRestoreStep(1);
      return;
    }

    try {
      const tag = await deriveRecoveryTag(words);
      const blob = await distributor.recover(tag, connectedPeers, {k: 1});

      // The peer returns the wrapped bundle, so it unlocks exactly like the
      // local and fragment paths do.
      const identity = await unlockBundle(blob, words);
      // The key goes to the keystore; app state never holds it.
      await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
      await saveRecoveryBundle(blob);

      setShamirStatus('success');
      Vibration.vibrate([0, 50, 50, 50, 50, 100]);
      setIdentity(identity);

      setTimeout(() => {
        navigation.reset({
          index: 0,
          routes: [{name: 'ChatList'}],
        });
      }, 1500);
    } catch (e) {
      console.warn('[RecoveryScreen] P2P recovery failed:', e);
      setShamirStatus('fail');
      Alert.alert(
        'P2P Recovery Failed',
        'Could not recover from peers. Make sure the correct peers are connected and they have your fragments.',
      );
    }
  }, [connectedPeers, restoreSeedInput, setIdentity, navigation]);

  // ── Derived ──

  const distributedCount = useMemo(() => {
    return Object.values(fragmentDist).filter((d) => d.distributed).length;
  }, [fragmentDist]);

  // Manual hand-out, tracked on this screen only (never stored): what the
  // user says they have given to someone.
  const [handedOut, setHandedOut] = useState({});
  const handedOutCount = Object.values(handedOut).filter(Boolean).length;

  const safetyColor =
    distributedCount >= FRAGMENT_SHARES
      ? theme.success
      : distributedCount >= FRAGMENT_THRESHOLD
        ? theme.warning
        : theme.danger;

  // ────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <ScreenHeader title="Recovery" onBack={() => navigation.goBack()} />

      {/* ── Tab Bar ── */}
      <View
        style={[styles.tabBar, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}
        accessibilityRole="tablist">
        {TABS.map((tab, idx) => {
          const active = activeTab === idx;
          return (
            <TouchableOpacity
              key={tab}
              style={[
                styles.tab,
                active && {borderBottomWidth: 2, borderBottomColor: theme.accent},
              ]}
              accessibilityRole="tab"
              accessibilityState={{selected: active}}
              onPress={() => {
                Vibration.vibrate(10);
                setActiveTab(idx);
              }}>
              <Text
                style={[
                  styles.tabText,
                  {color: active ? theme.accent : theme.textSecondary},
                ]}>
                {tab}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">

          {legacyRecovery?.state === 'needs-phrase' && (
            <View style={[styles.card, {backgroundColor: theme.warning + '14', borderColor: theme.warning + '60'}]}>
              <Text style={[styles.sectionLabel, {color: theme.warning}]}>CONFIRM YOUR RECOVERY PHRASE</Text>
              <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                An older version kept recovery data on this phone that this update would otherwise delete. It stays
                until you confirm your 12-word phrase here. Write the phrase down first, somewhere other than this
                phone. Confirming saves a current recovery backup under it; only then is the older data removed.
              </Text>
              <TextInput
                style={[styles.restoreTextarea, {color: theme.text, borderColor: theme.border, backgroundColor: theme.bgTertiary}]}
                value={legacyPhraseInput}
                onChangeText={setLegacyPhraseInput}
                placeholder="your twelve recovery words"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
                multiline
              />
              <TouchableOpacity
                style={[styles.genFragBtn, {backgroundColor: theme.warning, opacity: legacyBusy ? 0.6 : 1}]}
                onPress={handleConfirmLegacyPhrase}
                disabled={legacyBusy}
                activeOpacity={0.7}>
                <Text style={[styles.genFragBtnText, {color: theme.bg}]}>{legacyBusy ? 'Checking…' : 'Confirm phrase'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ═══════════════════ BACKUP TAB ═══════════════════ */}
          {activeTab === 0 && (
            <View>
              {/* Layer Badges */}
              <View style={styles.badgeRow}>
                {LAYER_BADGES.map((label, i) => (
                  <View
                    key={label}
                    style={[styles.badge, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}>
                    <Text style={[styles.badgeText, {color: theme.textSecondary}]}>{`${i + 1}. ${label}`}</Text>
                  </View>
                ))}
              </View>

              {/* 12-Word Seed Phrase (3x4 grid) */}
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>SEED PHRASE</Text>
                <View style={styles.seedGrid}>
                  {seedPhrase.map((word, idx) => (
                    <View
                      key={idx}
                      style={[styles.seedCell, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}>
                      <Text style={[styles.seedIndex, {color: theme.textMuted}]}>{idx + 1}</Text>
                      <Text style={[styles.seedWord, {color: theme.text}]}>{word}</Text>
                    </View>
                  ))}
                </View>

                {/* Warning */}
                <View style={[styles.warningBanner, {backgroundColor: theme.warning + '15', borderColor: theme.warning + '30'}]}>
                  <Text style={[styles.warningText, {color: theme.warning}]}>
                    Write this phrase down and store it offline. Never share it digitally.
                  </Text>
                </View>

                {/* Buttons */}
                <View style={styles.seedActions}>
                  <TouchableOpacity
                    style={[styles.seedBtn, {backgroundColor: theme.accentDim}]}
                    onPress={handleCopyPhrase}
                    activeOpacity={0.7}>
                    <Text style={[styles.seedBtnText, {color: theme.accent}]}>Copy Phrase</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.seedBtn, {backgroundColor: theme.bgTertiary}]}
                    onPress={handleRegenerate}
                    activeOpacity={0.7}>
                    <Text style={[styles.seedBtnText, {color: theme.textSecondary}]}>Regenerate</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Shamir Fragments */}
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>SHAMIR FRAGMENTS</Text>

                {fragments.length === 0 ? (
                  <TouchableOpacity
                    style={[styles.genFragBtn, {backgroundColor: theme.accent}]}
                    onPress={handleGenerateFragments}
                    activeOpacity={0.7}>
                    <Text style={[styles.genFragBtnText, {color: theme.bg}]}>
                      Generate {FRAGMENT_SHARES} fragments
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    {/* Distribution counter — only meaningful when a guardian can hold a fragment */}
                    {GUARDIAN_RECOVERY_AVAILABLE ? (
                    <View style={[styles.distCounter, {borderColor: safetyColor + '40'}]}>
                      <Text style={[styles.distCounterText, {color: safetyColor}]}>
                        {distributedCount}/{FRAGMENT_SHARES} distributed
                      </Text>
                      <Text style={[styles.distSafety, {color: safetyColor}]}>
                        {distributedCount >= FRAGMENT_SHARES
                          ? 'Excellent'
                          : distributedCount >= FRAGMENT_THRESHOLD
                            ? 'Adequate'
                            : 'Needs more'}
                      </Text>
                    </View>
                    ) : (
                      <View>
                        <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                          What these are for: if you lose this phone, any {FRAGMENT_THRESHOLD} of these {FRAGMENT_SHARES} fragments,
                          together with your recovery phrase, bring your identity back on a new one.
                        </Text>
                        <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                          What to do now: give each fragment to a different person you trust, outside this app — read it to
                          them, write it down for them, or send it by another channel. Keep none on this phone. They are not
                          saved: when you leave this screen they are gone, so hand them out before you do.
                          ({GUARDIAN_RECOVERY_UNAVAILABLE_REASON}.)
                        </Text>
                        <Text style={[styles.restoreDesc, {color: handedOutCount >= FRAGMENT_THRESHOLD ? theme.success : theme.warning}]}>
                          {handedOutCount}/{FRAGMENT_SHARES} handed out — {handedOutCount >= FRAGMENT_THRESHOLD
                            ? `restorable: any ${FRAGMENT_THRESHOLD} of them plus your phrase`
                            : `not a backup yet: at least ${FRAGMENT_THRESHOLD} must be with other people`}
                        </Text>
                      </View>
                    )}

                    {/* Fragment list */}
                    {fragments.map((frag, idx) => {
                      const dist = fragmentDist[idx];
                      return (
                        <View
                          key={frag.id}
                          style={[
                            styles.fragCard,
                            {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                          ]}>
                          <View style={styles.fragHeader}>
                            <Text style={[styles.fragNum, {color: theme.accent}]}>
                              Fragment {frag.id}
                            </Text>
                            <Text style={[styles.fragCheck, {color: theme.textMuted}]}>
                              {frag.check}
                            </Text>
                          </View>

                          {/* Distribution status */}
                          {dist?.distributed ? (
                            <Text style={[styles.fragDist, {color: theme.success}]}>
                              Distributed to {dist.peerName}
                            </Text>
                          ) : (
                            <Text style={[styles.fragDist, {color: theme.textMuted}]}>
                              Not distributed
                            </Text>
                          )}

                          {/* Action buttons */}
                          <View style={styles.fragActions}>
                            <TouchableOpacity
                              style={[styles.fragActionBtn, {backgroundColor: theme.accentDim}]}
                              onPress={() => handleCopyFragment(frag, idx)}>
                              <Text style={[styles.fragActionText, {color: theme.accent}]}>
                                COPY
                              </Text>
                            </TouchableOpacity>
                            {!GUARDIAN_RECOVERY_AVAILABLE && (
                              <TouchableOpacity
                                style={[styles.fragActionBtn, {backgroundColor: handedOut[frag.id] ? theme.success + '20' : theme.bgSecondary}]}
                                onPress={() => setHandedOut((h) => ({...h, [frag.id]: !h[frag.id]}))}
                                accessibilityRole="checkbox"
                                accessibilityState={{checked: !!handedOut[frag.id]}}>
                                <Text style={[styles.fragActionText, {color: handedOut[frag.id] ? theme.success : theme.textSecondary}]}>
                                  {handedOut[frag.id] ? 'HANDED OUT' : 'MARK HANDED OUT'}
                                </Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity
                              style={[
                                styles.fragActionBtn,
                                {backgroundColor: dist?.distributed ? theme.success + '20' : theme.bgSecondary},
                              ]}
                              onPress={() => handleGiveFragment(frag, idx)}
                              disabled={!GUARDIAN_RECOVERY_AVAILABLE || distributing}
                              accessibilityLabel={GUARDIAN_RECOVERY_AVAILABLE ? undefined : GUARDIAN_RECOVERY_UNAVAILABLE_REASON}>
                              <Text
                                style={[
                                  styles.fragActionText,
                                  {color: dist?.distributed ? theme.success : theme.textSecondary},
                                ]}>
                                {!GUARDIAN_RECOVERY_AVAILABLE
                                  ? 'P2P UNAVAILABLE'
                                  : dist?.distributed ? 'SENT' : distributing ? 'SENDING...' : 'SEND P2P'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })}
                  </>
                )}
              </View>
            </View>
          )}

          {/* ═══════════════════ VERIFY TAB ═══════════════════ */}
          {activeTab === 1 && (
            <View>
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                  VERIFY YOUR SEED
                </Text>
                <Text style={[styles.verifyInstr, {color: theme.textSecondary}]}>
                  Enter words 3, 7, and 11 from your seed phrase to verify you recorded it correctly.
                </Text>

                {[3, 7, 11].map((wordNum, idx) => (
                  <View key={wordNum} style={styles.verifyInputGroup}>
                    <Text style={[styles.verifyLabel, {color: theme.textMuted}]}>
                      Word #{wordNum}
                    </Text>
                    <TextInput
                      style={[
                        styles.verifyInput,
                        {
                          backgroundColor: theme.bgTertiary,
                          borderColor: theme.border,
                          color: theme.text,
                        },
                      ]}
                      placeholder={`Enter word ${wordNum}`}
                      placeholderTextColor={theme.textMuted}
                      value={verifyInputs[idx]}
                      onChangeText={(text) => {
                        setVerifyResult(null);
                        setVerifyInputs((prev) => {
                          const next = [...prev];
                          next[idx] = text;
                          return next;
                        });
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType={idx < 2 ? 'next' : 'done'}
                    />
                  </View>
                ))}

                <TouchableOpacity
                  style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
                  onPress={handleVerify}
                  activeOpacity={0.7}>
                  <Text style={[styles.primaryBtnText, {color: theme.bg}]}>Verify</Text>
                </TouchableOpacity>

                {/* Result banners */}
                {verifyResult === 'success' && (
                  <View
                    style={[
                      styles.resultBanner,
                      {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                    ]}>
                    <Text style={[styles.resultTitle, {color: theme.success}]}>
                      Verification Passed
                    </Text>
                    <Text style={[styles.resultDesc, {color: theme.success}]}>
                      Your seed phrase was recorded correctly.
                    </Text>
                  </View>
                )}
                {verifyResult === 'fail' && (
                  <View
                    style={[
                      styles.resultBanner,
                      {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                    ]}>
                    <Text style={[styles.resultTitle, {color: theme.danger}]}>
                      Verification Failed
                    </Text>
                    <Text style={[styles.resultDesc, {color: theme.danger}]}>
                      One or more words do not match. Check your seed phrase and try again.
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* ═══════════════════ RESTORE TAB ═══════════════════ */}
          {activeTab === 2 && (
            <View>
              {/* Step 1: Seed Phrase Restore */}
              {restoreStep === 1 && (
                <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                    STEP 1: SEED PHRASE
                  </Text>
                  <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                    Enter your 12-word seed phrase to derive your identity key.
                  </Text>

                  <TextInput
                    style={[
                      styles.restoreTextarea,
                      {
                        backgroundColor: theme.bgTertiary,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                    placeholder="Enter 12 words separated by spaces..."
                    placeholderTextColor={theme.textMuted}
                    value={restoreSeedInput}
                    onChangeText={(text) => {
                      setRestoreSeedInput(text);
                      setRestoreDerivStatus(null);
                    }}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    textAlignVertical="top"
                  />

                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      {backgroundColor: theme.accent},
                      restoreDerivStatus === 'deriving' && {opacity: 0.6},
                    ]}
                    onPress={handleDeriveSeed}
                    disabled={restoreDerivStatus === 'deriving'}
                    activeOpacity={0.7}>
                    <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                      {restoreDerivStatus === 'deriving'
                        ? 'Deriving Key (PBKDF2)...'
                        : 'Derive Key & Check Device'}
                    </Text>
                  </TouchableOpacity>

                  {/* Status indicators */}
                  {restoreDerivStatus === 'deriving' && (
                    <View style={[styles.statusRow, {borderColor: theme.accent + '30'}]}>
                      <Text style={[styles.statusText, {color: theme.accent}]}>
                        Running PBKDF2 derivation...
                      </Text>
                    </View>
                  )}
                  {restoreDerivStatus === 'success' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.success}]}>
                        Identity Restored
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.success}]}>
                        Key derived successfully. Redirecting to chat...
                      </Text>
                    </View>
                  )}
                  {restoreDerivStatus === 'fail' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.danger}]}>
                        Seed Derivation Failed
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.danger}]}>
                        Could not restore from seed. Try Shamir fragment recovery below.
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Step 2: Shamir Fragment Restore */}
              {restoreStep === 2 && (
                <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                    STEP 2: SHAMIR FRAGMENTS
                  </Text>
                  <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                    {GUARDIAN_RECOVERY_AVAILABLE
                      ? 'Paste at least 3 Shamir fragments to reconstruct your identity, or recover from connected peers.'
                      : 'Paste at least 3 Shamir fragments to reconstruct your identity.'}
                  </Text>

                  {/* P2P Recovery Option */}
                  {GUARDIAN_RECOVERY_AVAILABLE && (
                  <View style={[styles.p2pRecoveryCard, {backgroundColor: theme.accent + '10', borderColor: theme.accent + '30'}]}>
                    <View style={styles.p2pRecoveryHeader}>
                      <Text style={[styles.p2pRecoveryTitle, {color: theme.accent}]}>
                        Recover from Peers
                      </Text>
                      <Text style={[styles.p2pRecoveryPeers, {color: theme.textMuted}]}>
                        {connectedPeers.length} peer{connectedPeers.length !== 1 ? 's' : ''} connected
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.p2pRecoveryBtn,
                        {backgroundColor: theme.accent},
                        (shamirStatus === 'combining' || connectedPeers.length === 0) && {opacity: 0.6},
                      ]}
                      onPress={handleRecoverFromPeers}
                      disabled={shamirStatus === 'combining' || connectedPeers.length === 0}
                      activeOpacity={0.7}>
                      <Text style={[styles.p2pRecoveryBtnText, {color: theme.bg}]}>
                        Recover via P2P
                      </Text>
                    </TouchableOpacity>
                  </View>
                  )}

                  {GUARDIAN_RECOVERY_AVAILABLE && (
                    <Text style={[styles.restoreDivider, {color: theme.textMuted}]}>
                      — or paste fragments manually —
                    </Text>
                  )}

                  {shamirInputs.map((val, idx) => (
                    <View key={idx} style={styles.shamirInputGroup}>
                      <View style={styles.shamirLabelRow}>
                        <Text style={[styles.shamirLabel, {color: theme.accent}]}>
                          Fragment {idx + 1}
                        </Text>
                        {val.trim().length > 0 && (
                          <Text style={[styles.shamirOk, {color: theme.success}]}>Ready</Text>
                        )}
                      </View>
                      <TextInput
                        style={[
                          styles.shamirInput,
                          {
                            backgroundColor: theme.bgTertiary,
                            borderColor: theme.border,
                            color: theme.text,
                          },
                        ]}
                        placeholder="Paste hex fragment data..."
                        placeholderTextColor={theme.textMuted}
                        value={val}
                        onChangeText={(text) => {
                          setShamirStatus(null);
                          setShamirInputs((prev) => {
                            const next = [...prev];
                            next[idx] = text;
                            return next;
                          });
                        }}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        textAlignVertical="top"
                      />
                    </View>
                  ))}

                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      {backgroundColor: theme.accent},
                      shamirStatus === 'combining' && {opacity: 0.6},
                    ]}
                    onPress={handleShamirRestore}
                    disabled={shamirStatus === 'combining'}
                    activeOpacity={0.7}>
                    <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                      {shamirStatus === 'combining'
                        ? 'Combining Fragments...'
                        : 'Combine & Restore'}
                    </Text>
                  </TouchableOpacity>

                  {/* Status */}
                  {shamirStatus === 'combining' && (
                    <View style={[styles.statusRow, {borderColor: theme.accent + '30'}]}>
                      <Text style={[styles.statusText, {color: theme.accent}]}>
                        Reconstructing secret via Lagrange interpolation...
                      </Text>
                    </View>
                  )}
                  {shamirStatus === 'success' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.success}]}>
                        Identity Restored
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.success}]}>
                        Shamir reconstruction successful. Redirecting to chat...
                      </Text>
                    </View>
                  )}
                  {shamirStatus === 'fail' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.danger}]}>
                        Reconstruction Failed
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.danger}]}>
                        Fragment data is invalid or insufficient. Verify fragment integrity.
                      </Text>
                    </View>
                  )}

                  {/* Back to Step 1 */}
                  <TouchableOpacity
                    style={[styles.secondaryBtn, {borderColor: theme.border}]}
                    onPress={() => {
                      setRestoreStep(1);
                      setRestoreDerivStatus(null);
                    }}
                    activeOpacity={0.7}>
                    <Text style={[styles.secondaryBtnText, {color: theme.textSecondary}]}>
                      {'\u2190'} Back to Step 1
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Peer Picker Modal */}
      {showPeerPicker && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            <Text style={[styles.modalTitle, {color: theme.text}]}>Send to Peer</Text>
            <Text style={[styles.modalSubtitle, {color: theme.textMuted}]}>
              Select a connected peer to receive this fragment
            </Text>

            {connectedPeers.length === 0 ? (
              <View style={styles.noPeersContainer}>
                <Text style={[styles.noPeersText, {color: theme.textMuted}]}>
                  No peers connected. Connect to peers first via the main chat screen.
                </Text>
                <TouchableOpacity
                  style={[styles.modalBtn, {backgroundColor: theme.accentDim}]}
                  onPress={() => setShowPeerPicker(false)}>
                  <Text style={[styles.modalBtnText, {color: theme.accent}]}>Close</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {connectedPeers.map(peer => (
                  <TouchableOpacity
                    key={peer.id}
                    style={[styles.peerItem, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}
                    onPress={() => handleSelectPeer(peer)}>
                    <View style={[styles.peerAvatar, {backgroundColor: theme.accent}]}>
                      <Text style={styles.peerInitial}>
                        {(peer.name || peer.id)[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.peerInfo}>
                      <Text style={[styles.peerName, {color: theme.text}]}>
                        {peer.name || peer.id}
                      </Text>
                      <Text style={[styles.peerStatus, {color: theme.success}]}>Connected</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[styles.modalBtn, {backgroundColor: theme.bgTertiary}]}
                  onPress={() => {
                    setShowPeerPicker(false);
                    if (pendingFragment) {
                      handleManualGive(pendingFragment.frag, pendingFragment.idx);
                    }
                  }}>
                  <Text style={[styles.modalBtnText, {color: theme.textSecondary}]}>
                    Manual (Copy to Clipboard)
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },

  /* Tab Bar */
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  /* Scroll */
  scroll: {
    padding: 16,
    paddingBottom: 50,
  },

  /* Card */
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    marginBottom: 14,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
  },

  /* Badge Row */
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },

  /* Seed Grid (3 columns, 4 rows) */
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  seedCell: {
    width: '31%',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedIndex: {
    fontSize: 11,
    fontWeight: '700',
    width: 18,
  },
  seedWord: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },

  /* Warning */
  warningBanner: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 14,
  },
  warningText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  },

  /* Seed Action Buttons */
  seedActions: {
    flexDirection: 'row',
    gap: 10,
  },
  seedBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  seedBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },

  /* Fragment generation */
  genFragBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  genFragBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },

  /* Distribution Counter */
  distCounter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  distCounterText: {
    fontSize: 14,
    fontWeight: '700',
  },
  distSafety: {
    fontSize: 12,
    fontWeight: '600',
  },

  /* Fragment Card */
  fragCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  fragHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  fragNum: {
    fontSize: 14,
    fontWeight: '700',
  },
  fragCheck: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fragDist: {
    fontSize: 12,
    marginBottom: 10,
  },
  fragActions: {
    flexDirection: 'row',
    gap: 8,
  },
  fragActionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  fragActionText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },

  /* Verify */
  verifyInstr: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  verifyInputGroup: {
    marginBottom: 14,
  },
  verifyLabel: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  verifyInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    fontWeight: '500',
  },

  /* Primary Button */
  primaryBtn: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },

  /* Secondary Button */
  secondaryBtn: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },

  /* Result banners */
  resultBanner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginTop: 14,
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  resultDesc: {
    fontSize: 12,
    lineHeight: 18,
  },

  /* Status indicator */
  statusRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },

  /* Restore */
  restoreDesc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  restoreTextarea: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 8,
  },

  /* Shamir Inputs */
  shamirInputGroup: {
    marginBottom: 12,
  },
  shamirLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  shamirLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  shamirOk: {
    fontSize: 11,
    fontWeight: '700',
  },
  shamirInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 12,
    minHeight: 70,
    textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  /* Peer Picker Modal */
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    marginBottom: 16,
  },
  noPeersContainer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  noPeersText: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  peerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  peerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  peerInitial: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    fontSize: 15,
    fontWeight: '600',
  },
  peerStatus: {
    fontSize: 12,
    marginTop: 2,
  },
  modalBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },

  /* P2P Recovery */
  p2pRecoveryCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  p2pRecoveryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  p2pRecoveryTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  p2pRecoveryPeers: {
    fontSize: 12,
  },
  p2pRecoveryBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  p2pRecoveryBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  restoreDivider: {
    textAlign: 'center',
    marginVertical: 12,
    fontSize: 12,
  },
});
