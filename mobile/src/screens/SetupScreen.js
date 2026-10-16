import React, {useState, useCallback, useRef} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Vibration,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from '../components/ScaledText';
import Animated, {
  FadeInDown,
  FadeInUp,
  SlideInRight,
  SlideOutLeft,
} from 'react-native-reanimated';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTheme} from '../context/ThemeContext';
import Icon from '../components/Icon';
import {useApp} from '../context/AppContext';
import {useSecureScreenWhen} from '../utils/useSecureScreen';
import {CryptoEngine, generateSeedPhrase} from '../utils/crypto';
import {wrapIdentity, saveRecoveryBundle} from '../utils/recovery';

// ==================== BIP39 512-WORD LIST ====================
// Same word list used by the GhostLink web app (index.html)

// ==================== STEP DEFINITIONS ====================
const STEPS = {
  NAME: 0,
  SEED: 1,
  CONFIRM: 2,
};

// Verification word positions (0-indexed): words 3, 7, 11
/** The steps of identity creation, shown one at a time (three are PBKDF2 runs). */
const SETUP_STAGES = [
  'Deriving your identity key…',
  'Deriving your Ghost Address…',
  'Sealing your recovery bundle…',
];

const VERIFY_INDICES = [2, 6, 10];

export default function SetupScreen({navigation}) {
  const {theme, fontScale} = useTheme();
  const insets = useSafeAreaInsets();
  const {setIdentity} = useApp();
  const [step, setStep] = useState(STEPS.NAME);

  // The recovery phrase is on screen for the SEED and CONFIRM steps, and on
  // both it is the whole identity in plain text. FLAG_SECURE blocks the
  // screenshot and the recents thumbnail for as long as that is true.
  const phraseVisible = step === STEPS.SEED || step === STEPS.CONFIRM;
  useSecureScreenWhen(phraseVisible);
  const [displayName, setDisplayName] = useState('');
  const [seedPhrase, setSeedPhrase] = useState([]);
  const [confirmWords, setConfirmWords] = useState({2: '', 6: '', 10: ''});
  const [loading, setLoading] = useState(false);
  const [generatingFragments, setGeneratingFragments] = useState(false);
  /** Which step of identity creation is running. */
  const [stage, setStage] = useState(0);

  // Refs for confirm inputs
  const confirmRef7 = useRef(null);
  const confirmRef11 = useRef(null);

  // The logo used to pulse forever. Motion with no meaning, on the screen
  // where people are reading the most carefully, is decoration.

  // Step 1: Handle name submission — generate seed phrase
  const handleNameSubmit = useCallback(() => {
    const name = displayName.trim();
    if (!name) {
      Alert.alert('Name Required', 'Enter a display name to continue.');
      return;
    }
    if (name.length < 2) {
      Alert.alert('Too Short', 'Display name must be at least 2 characters.');
      return;
    }
    Vibration.vibrate(20);
    const seed = generateSeedPhrase();
    setSeedPhrase(seed);
    setStep(STEPS.SEED);
  }, [displayName]);

  // Step 2: "I've written it down" — move to verify
  const handleSeedWrittenDown = useCallback(() => {
    Vibration.vibrate(20);
    setConfirmWords({2: '', 6: '', 10: ''});
    setStep(STEPS.CONFIRM);
  }, []);

  // Step 3: Verify words 3, 7, 11 then generate keys, wrap, Shamir, store
  const handleVerifyAndFinish = useCallback(async () => {
    // Check the three verification words
    for (const idx of VERIFY_INDICES) {
      const entered = (confirmWords[idx] || '').toLowerCase().trim();
      const expected = seedPhrase[idx];
      if (entered !== expected) {
        Alert.alert(
          'Verification Failed',
          `Word #${idx + 1} does not match. Check your seed phrase backup and try again.`,
        );
        return;
      }
    }

    Vibration.vibrate(30);
    setLoading(true);
    setGeneratingFragments(true);
    setStage(1);

    try {
      // Let the stage render before the first derivation starts.
      await new Promise(r => setTimeout(r, 0));
      // 1. The ECDH P-256 keypair, derived from the recovery phrase so the
      //    phrase restores the identity (older random keys: see MOBILE_BUILD.md).
      const keyPair = await CryptoEngine.deriveIdentityKeyPair(seedPhrase);
      const fingerprint = await CryptoEngine.sha256(keyPair.publicKeyHex);

      // 2. Wrap the private key under the phrase (AES-256-GCM) and store the
      //    sealed bundle. Fragments are made on demand in RecoveryScreen, never
      //    stored. The Ghost Mesh identity is derived once and kept.
      setStage(2);
      const ghost = await CryptoEngine.deriveGhostIdentity(seedPhrase);

      setStage(3);
      const bundle = await wrapIdentity(
        {
          privateKeyRaw: keyPair.privateKeyRaw,
          publicKeyHex: keyPair.publicKeyHex,
          name: displayName.trim(),
          ghostAddress: ghost.ghostAddress,
        },
        seedPhrase,
      );

      // 3. Store keypair securely in Keychain
      await CryptoEngine.storeKeyPair(keyPair.publicKeyHex, keyPair.privateKeyRaw);

      // 4. Store the bundle
      await saveRecoveryBundle(bundle);
      // No separate seed hash is stored; the GCM tag on the wrapped key is the
      // phrase check.

      // 7. Update app context
      const identity = {
        publicKeyHex: keyPair.publicKeyHex,
        fingerprint: fingerprint.slice(0, 16),
        name: displayName.trim(),
        ghostAddress: ghost.ghostAddress,
        meshNodeId: ghost.nodeIdHex,
        /**
         * 'phrase-v1': the recovery phrase reproduces the messaging key. Absent
         * on older identities whose key was random.
         */
        keyDerivation: 'phrase-v1',
      };

      // The recovery phrase is deliberately kept out of app state (it would be
      // persisted); the wrapped bundle is what recovery needs.
      setIdentity(identity);
      // No invite code is stored: the Ghost Address replaced it,
      // and the stored copy was never read.

      Vibration.vibrate(40);

      // No navigation.reset: MainNavigator switches stacks once an identity exists.
    } catch (e) {
      // The message alone ("undefined is not a function") says nothing about
      // where it came from, and this path runs entirely on-device — so log the
      // stack too, or the next failure here is another guessing game.
      console.error('[GhostLink:Setup] identity generation failed:', e && e.stack ? e.stack : e);
      Alert.alert('Setup Error', 'Failed to generate identity. Please try again.\n\n' + (e.message || ''));
    } finally {
      setLoading(false);
      setGeneratingFragments(false);
      setStage(0);
    }
  }, [confirmWords, seedPhrase, displayName, setIdentity]);

  // ==================== RENDER ====================
  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {paddingTop: insets.top + 32, paddingBottom: insets.bottom + 40},
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* Ghost Icon Header */}
        <View style={styles.logoContainer}>
          <View style={[styles.ghostIcon, {borderColor: theme.accent, backgroundColor: theme.accentDim}]}>
            <Text style={[styles.ghostGlyph, {color: theme.accent}]}>G</Text>
          </View>
          <Text style={[styles.title, {color: theme.text}]} accessibilityRole="header">GhostLink</Text>
          {/* "Zero Trust. Zero Trace." was a promise the app does not make:
              messages and keys are stored on this phone. */}
          <Text style={[styles.subtitle, {color: theme.textSecondary}]}>
            Peer-to-peer messaging.
          </Text>
        </View>

        {/* Step indicator */}
        <View
          style={styles.stepIndicator}
          accessible
          accessibilityLabel={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map(i => (
            <View key={i} style={styles.stepDotRow}>
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor: step >= i ? theme.accent : theme.bgTertiary,
                    borderColor: step >= i ? theme.accent : theme.border,
                  },
                ]}
              />
              {i < 2 && (
                <View
                  style={[
                    styles.stepLine,
                    {backgroundColor: step > i ? theme.accent : theme.bgTertiary},
                  ]}
                />
              )}
            </View>
          ))}
        </View>

        {/* ==================== STEP 1: DISPLAY NAME ==================== */}
        {step === STEPS.NAME && (
          <Animated.View entering={SlideInRight.duration(350)} exiting={SlideOutLeft.duration(250)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]} accessibilityRole="header">
              Choose a Display Name
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              This name is visible to peers in your encrypted conversations. It cannot be changed later without re-keying.
            </Text>

            <View
              style={[
                styles.inputWrapper,
                {backgroundColor: theme.bgSecondary, borderColor: theme.border},
              ]}>
              <TextInput
                style={[styles.input, {color: theme.text}]}
                placeholder="Display name"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Display name"
                textContentType="nickname"
                value={displayName}
                onChangeText={setDisplayName}
                maxLength={24}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleNameSubmit}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {displayName.length > 0 && (
                <Text style={[styles.charCount, {color: theme.textMuted}]}>
                  {displayName.length}/24
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {backgroundColor: theme.accent},
                !displayName.trim() && {opacity: 0.4},
              ]}
              onPress={handleNameSubmit}
              disabled={!displayName.trim()}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.onAccent}]}>
                Create New Identity
              </Text>
            </TouchableOpacity>

            {/*
              Equal prominence, deliberately. Someone reinstalling or moving
              phones arrives here with twelve words written down and needs to
              see straight away that there is somewhere to put them — before
              this existed, the only path forward created a second identity and
              quietly orphaned the first.
            */}
            <View style={styles.altDivider}>
              <View style={[styles.altRule, {backgroundColor: theme.border}]} />
              <Text style={[styles.altDividerText, {color: theme.textMuted}]}>or</Text>
              <View style={[styles.altRule, {backgroundColor: theme.border}]} />
            </View>

            <TouchableOpacity
              style={[styles.secondaryBtn, {borderColor: theme.accent}]}
              onPress={() => navigation.navigate('RestoreIdentity')}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="I already have an identity. Restore it from your recovery phrase.">
              <Text style={[styles.secondaryBtnText, {color: theme.accent}]}>
                I Already Have an Identity
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ==================== STEP 2: SEED PHRASE ==================== */}
        {step === STEPS.SEED && (
          <Animated.View entering={SlideInRight.duration(350)} exiting={SlideOutLeft.duration(250)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]} accessibilityRole="header">
              Your Recovery Phrase
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Write down these 12 words in order. They are your only way to recover your identity.
            </Text>

            {/* 3x4 Seed Grid */}
            <View style={styles.seedGrid}>
              {seedPhrase.map((word, idx) => (
                <Animated.View
                  key={idx}
                  entering={FadeInUp.delay(idx * 60).duration(300)}
                  accessible
                  accessibilityLabel={`Word ${idx + 1}, ${word}`}
                  style={[
                    styles.seedWord,
                    // Two columns from Large up, so long words are not cut.
                    {width: fontScale > 1.1 ? '48%' : '31%'},
                    {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                  ]}>
                  <Text style={[styles.seedIndex, {color: theme.textMuted}]}>
                    {idx + 1}
                  </Text>
                  <Text style={[styles.seedText, {color: theme.accent}]}>
                    {word}
                  </Text>
                </Animated.View>
              ))}
            </View>

            {/* Warning Banner */}
            <Animated.View
              entering={FadeInDown.delay(700).duration(400)}
              style={[
                styles.warningBox,
                {backgroundColor: theme.warning + '12', borderColor: theme.warning + '30'},
              ]}>
              <Icon name="warning" size={20} color={theme.warning} style={styles.warningIcon} />
              <View style={styles.warningContent}>
                <Text style={[styles.warningTitle, {color: theme.warning}]}>
                  Write these down. Never share digitally.
                </Text>
                <Text style={[styles.warningText, {color: theme.text}]}>
                  Store these words on paper in a secure location. Anyone with these words controls your identity. Screenshots and digital copies are vulnerable.
                </Text>
              </View>
            </Animated.View>

            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
              onPress={handleSeedWrittenDown}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.onAccent}]}>
                I've Written It Down
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ==================== STEP 3: VERIFY WORDS 3, 7, 11 ==================== */}
        {step === STEPS.CONFIRM && (
          <Animated.View entering={SlideInRight.duration(350)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]} accessibilityRole="header">
              Check Your Copy
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Enter words 3, 7 and 11 from your recovery phrase.
            </Text>

            {/* Word #3 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  3
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Word 3"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Word 3"
                  value={confirmWords[2]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 2: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef7.current?.focus()}
                  autoFocus
                />
              </View>
            </View>

            {/* Word #7 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  7
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  ref={confirmRef7}
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Word 7"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Word 7"
                  value={confirmWords[6]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 6: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef11.current?.focus()}
                />
              </View>
            </View>

            {/* Word #11 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  11
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  ref={confirmRef11}
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Word 11"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="Word 11"
                  value={confirmWords[10]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 10: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleVerifyAndFinish}
                />
              </View>
            </View>

            {/* Progress info while generating */}
            {generatingFragments && (
              <Animated.View
                entering={FadeInDown.duration(300)}
                style={[styles.progressBox, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                {SETUP_STAGES.map((label, i) => {
                  const n = i + 1;
                  const done = stage > n;
                  const active = stage === n;
                  return (
                    <View key={label} style={styles.progressRow}>
                      {active ? (
                        <ActivityIndicator size="small" color={theme.accent} style={styles.progressSpinner} />
                      ) : (
                        <Text
                          style={[
                            styles.progressMark,
                            {color: done ? theme.accent : theme.textSecondary},
                          ]}>
                          {done ? '✓' : '·'}
                        </Text>
                      )}
                      <Text
                        style={[
                          styles.progressText,
                          {color: active ? theme.text : theme.textSecondary},
                        ]}>
                        {label}
                      </Text>
                    </View>
                  );
                })}
              </Animated.View>
            )}

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {backgroundColor: theme.accent},
                loading && {opacity: 0.6},
              ]}
              onPress={handleVerifyAndFinish}
              disabled={loading}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.onAccent}]}>
                {loading
                  ? SETUP_STAGES[Math.max(0, stage - 1)] || 'Creating your identity…'
                  : 'Create Identity'}
              </Text>
            </TouchableOpacity>

            {/* Back to seed link */}
            {!loading && (
              <TouchableOpacity
                style={styles.backLink}
                onPress={() => setStep(STEPS.SEED)}
                accessibilityRole="button"
                activeOpacity={0.6}>
                <Text style={[styles.backLinkText, {color: theme.accent}]}>
                  Show the phrase again
                </Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 24,
  },
  ghostIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  ghostGlyph: {
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  subtitle: {
    fontSize: 15,
    marginTop: 6,
    textAlign: 'center',
  },

  // Step indicator
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  stepDotRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  stepLine: {
    width: 40,
    height: 2,
    marginHorizontal: 4,
    borderRadius: 1,
  },

  // Step content
  stepContainer: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  stepDesc: {
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 24,
  },

  // Name input
  inputWrapper: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    fontSize: 16,
    paddingVertical: 14,
    fontWeight: '500',
    flex: 1,
  },
  charCount: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },

  // Primary button
  altDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 18,
    gap: 12,
  },
  altRule: {flex: 1, height: 1},
  altDividerText: {fontSize: 13},
  secondaryBtn: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {fontSize: 16, fontWeight: '600'},
  primaryBtn: {
    borderRadius: 12,
    minHeight: 52,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },

  // Seed grid (3 columns x 4 rows)
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  seedWord: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedIndex: {
    fontSize: 11,
    fontWeight: '700',
    marginRight: 6,
    width: 18,
    textAlign: 'right',
  },
  seedText: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },

  // Warning banner
  warningBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  warningIcon: {
    marginRight: 10,
    marginTop: 1,
  },
  warningContent: {
    flex: 1,
  },
  warningTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },

  // Confirm step
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  confirmLabel: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmLabelText: {
    fontSize: 15,
    fontWeight: '700',
  },
  confirmInputWrap: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginLeft: 10,
  },
  confirmInput: {
    fontSize: 16,
    paddingVertical: 13,
    fontWeight: '500',
  },

  // Progress indicator
  progressBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
    marginBottom: 4,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  progressSpinner: {
    width: 16,
    marginRight: 6,
  },
  progressMark: {
    width: 16,
    marginRight: 6,
    textAlign: 'center',
    fontSize: 12,
  },
  progressText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },

  // Back link
  backLink: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 44,
  },
  backLinkText: {
    fontSize: 15,
  },
});
