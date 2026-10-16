/**
 * GhostLink Mobile — Restore an identity from its recovery phrase.
 *
 * The phrase restores the Ghost Address and (for newer identities) the
 * messaging keypair. Messages, files, contacts and settings do not come back;
 * the screen says so before the user commits.
 *
 * The phrase has no checksum, so a typo landing on another valid word yields a
 * different identity. The user confirms the resulting Ghost Address instead.
 */

import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  View,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Vibration,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import {Text, TextInput} from '../components/ScaledText';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';
import {SEED_PHRASE_WORDS} from '../utils/wordlist';
import {splitPhrase, validatePhrase, suggestWords} from '../utils/phrase-entry';
import {useSecureScreen} from '../utils/useSecureScreen';

export default function RestoreIdentityScreen({navigation}) {
  const {theme, scale} = useTheme();
  // No header on this screen, so the content itself clears the status bar
  // and Dynamic Island; a flat padding of 20 put the title under them on iOS.
  const insets = useSafeAreaInsets();
  const contentInset = {paddingTop: insets.top + 16, paddingBottom: insets.bottom + 48};
  const {setIdentity, clearIdentityScopedData} = useApp();

  // Blocks screenshots and the recents thumbnail while a phrase is on screen.
  useSecureScreen();

  const [words, setWords] = useState(() => Array(SEED_PHRASE_WORDS).fill(''));
  const [focused, setFocused] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const inputs = useRef([]);

  const validation = useMemo(() => validatePhrase(words), [words]);
  const suggestions = useMemo(
    () => (focused >= 0 ? suggestWords(words[focused]) : []),
    [focused, words],
  );

  const setWord = useCallback((index, value) => {
    setWords(prev => {
      // A paste into any box fills the whole phrase — people paste the lot.
      const parts = splitPhrase(value);
      if (parts.length >= SEED_PHRASE_WORDS) {
        return parts.slice(0, SEED_PHRASE_WORDS);
      }
      const next = [...prev];
      next[index] = value.toLowerCase().replace(/[^a-z]/g, '');
      return next;
    });
  }, []);

  const acceptSuggestion = useCallback(
    word => {
      if (focused < 0) return;
      setWords(prev => {
        const next = [...prev];
        next[focused] = word;
        return next;
      });
      if (focused < SEED_PHRASE_WORDS - 1) inputs.current[focused + 1]?.focus();
    },
    [focused],
  );

  /** Derive and show the address, so the user can confirm before committing. */
  const handleDerive = useCallback(async () => {
    if (!validation.ok || busy) return;
    Vibration.vibrate(15);
    setBusy(true);
    try {
      // Let the busy state paint before the derivations start.
      await new Promise(r => setTimeout(r, 0));
      const phrase = words.map(w => w.trim().toLowerCase());
      const [ghost, keyPair] = await Promise.all([
        CryptoEngine.deriveGhostIdentity(phrase),
        CryptoEngine.deriveIdentityKeyPair(phrase),
      ]);
      const fingerprint = await CryptoEngine.sha256(keyPair.publicKeyHex);
      setPreview({ghost, keyPair, fingerprint: fingerprint.slice(0, 16)});
    } catch (err) {
      Alert.alert(
        'Could not derive an identity',
        'Something went wrong working out your identity from those words. ' +
          'Check them and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, validation.ok, words]);

  /** Commit: store the key and set the identity. */
  const handleConfirm = useCallback(async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      // The key first: storeKeyPair throws if the keystore refuses, before
      // anything else has changed.
      await CryptoEngine.storeKeyPair(preview.keyPair.publicKeyHex, preview.keyPair.privateKeyRaw);

      // Then drop data belonging to the previous identity.
      await clearIdentityScopedData();

      setIdentity({
        publicKeyHex: preview.keyPair.publicKeyHex,
        fingerprint: preview.fingerprint,
        name: displayName.trim() || 'You',
        ghostAddress: preview.ghost.ghostAddress,
        meshNodeId: preview.ghost.nodeIdHex,
        keyDerivation: 'phrase-v1',
      });
      // Deliberately not cleared to a new array: overwrite in place so the
      // words do not linger in a detached object waiting on the collector.
      setWords(prev => prev.map(() => ''));
      setPreview(null);
    } catch (err) {
      Alert.alert(
        "Couldn't finish restoring",
        (err && err.message) ||
          'Your identity could not be saved to this device. Nothing has been changed — please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, displayName, preview, setIdentity, clearIdentityScopedData]);

  // StyleSheet.create on every render was rebuilding the whole sheet on each
  // keystroke across twelve inputs. Theme and scale are the only inputs.
  const s = useMemo(() => styles(theme, scale), [theme, scale]);

  if (preview) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={[s.content, contentInset]}>
        <Text style={s.title}>Is this your identity?</Text>
        <Text style={s.body}>
          These words produce the address below. Check it against your other device
          before continuing — if it doesn't match, one of the words is wrong.
        </Text>

        <View style={s.addressCard} accessibilityRole="text">
          <Text style={s.addressLabel}>Ghost Address</Text>
          <Text style={s.address} selectable>
            {preview.ghost.ghostAddress}
          </Text>
          <Text style={s.addressLabel}>Fingerprint</Text>
          <Text style={s.fingerprint} selectable>
            {preview.fingerprint}
          </Text>
        </View>

        <View style={s.noticeCard}>
          <Text style={s.noticeTitle}>What comes back</Text>
          <Text style={s.noticeBody}>
            Your identity — the same address and keys, so your contacts recognise you.
          </Text>
          <Text style={s.noticeTitle}>What doesn't</Text>
          <Text style={s.noticeBody}>
            Past messages, files and contacts stay on your old device. GhostLink never
            stores copies of them anywhere.
          </Text>
        </View>

        <TextInput
          style={s.nameInput}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Display name (optional)"
          placeholderTextColor={theme.textMuted}
          maxLength={24}
          autoCorrect={false}
          accessibilityLabel="Display name"
        />

        <TouchableOpacity
          style={[s.primaryBtn, busy && s.btnDisabled]}
          onPress={handleConfirm}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Yes, restore this identity">
          {busy ? (
            <ActivityIndicator color={theme.bg} />
          ) : (
            <Text style={s.primaryBtnText}>Yes, this is mine</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => setPreview(null)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Go back and check the words">
          <Text style={s.secondaryBtnText}>Let me check the words</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.content, contentInset]} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Enter your recovery phrase</Text>
        <Text style={s.body}>
          The {SEED_PHRASE_WORDS} words you wrote down, in order. You can paste the whole
          phrase into any box.
        </Text>

        <View style={s.grid}>
          {words.map((word, i) => {
            const isUnknown = validation.unknown.includes(i);
            return (
              <View key={i} style={s.cell}>
                <Text style={s.cellIndex}>{i + 1}</Text>
                <TextInput
                  ref={el => (inputs.current[i] = el)}
                  style={[s.cellInput, isUnknown && s.cellInputBad]}
                  value={word}
                  onChangeText={v => setWord(i, v)}
                  onFocus={() => setFocused(i)}
                  onSubmitEditing={() => inputs.current[i + 1]?.focus()}
                  returnKeyType={i === SEED_PHRASE_WORDS - 1 ? 'done' : 'next'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  importantForAutofill="no"
                  spellCheck={false}
                  keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                  accessibilityLabel={`Word ${i + 1}${isUnknown ? ', not in the wordlist' : ''}`}
                />
              </View>
            );
          })}
        </View>

        {suggestions.length > 0 ? (
          <View style={s.suggestRow}>
            {suggestions.map(w => (
              <TouchableOpacity
                key={w}
                style={s.suggestChip}
                onPress={() => acceptSuggestion(w)}
                accessibilityRole="button"
                accessibilityLabel={`Use the word ${w}`}>
                <Text style={s.suggestText}>{w}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {validation.unknown.length > 0 ? (
          <Text style={s.error}>
            {validation.unknown.length === 1
              ? `Word ${validation.unknown[0] + 1} isn't in the list.`
              : `Words ${validation.unknown.map(i => i + 1).join(', ')} aren't in the list.`}
          </Text>
        ) : validation.missing > 0 ? (
          <Text style={s.hint}>
            {validation.missing} more {validation.missing === 1 ? 'word' : 'words'} to go.
          </Text>
        ) : validation.legacy.length > 0 ? (
          /*
           * A legacy word: still valid and restores normally. Say so, since
           * autocomplete will not offer it.
           */
          <Text style={s.hint}>
            Recognised — this phrase is from an earlier version of GhostLink. It still works.
          </Text>
        ) : null}

        <TouchableOpacity
          style={[s.primaryBtn, (!validation.ok || busy) && s.btnDisabled]}
          onPress={handleDerive}
          disabled={!validation.ok || busy}
          accessibilityRole="button"
          accessibilityState={{disabled: !validation.ok || busy}}
          accessibilityLabel="Continue and show the identity these words produce">
          {busy ? (
            <View style={s.btnBusy}>
              <ActivityIndicator color={theme.bg} />
              <Text style={s.primaryBtnText}>Working out your identity…</Text>
            </View>
          ) : (
            <Text style={s.primaryBtnText}>Continue</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={s.secondaryBtnText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (theme, scale) =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: theme.bg},
    content: {padding: 20, paddingBottom: 48},
    title: {color: theme.text, fontSize: 22, fontWeight: '700', marginBottom: 8},
    body: {color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 20},
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    // Two columns from Large up: three 31% columns cut long words at 19pt+.
    cell: {width: scale(16) > 17 ? '48%' : '31%', flexDirection: 'row', alignItems: 'center'},
    cellIndex: {color: theme.textMuted, fontSize: 11, width: 18},
    cellInput: {
      flex: 1,
      minHeight: 48,
      backgroundColor: theme.bgTertiary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 8,
      color: theme.text,
      fontSize: 14,
    },
    cellInputBad: {borderColor: theme.danger},
    suggestRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
    suggestChip: {
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: theme.bgTertiary,
      borderWidth: 1,
      borderColor: theme.border,
    },
    suggestText: {color: theme.accent, fontSize: 14},
    error: {color: theme.danger, fontSize: 13, marginTop: 14},
    hint: {color: theme.textMuted, fontSize: 13, marginTop: 14},
    primaryBtn: {
      marginTop: 24,
      minHeight: 52,
      borderRadius: 12,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnBusy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    primaryBtnText: {color: theme.onAccent, fontSize: 16, fontWeight: '600'},
    btnDisabled: {opacity: 0.4},
    secondaryBtn: {marginTop: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center'},
    secondaryBtnText: {color: theme.textSecondary, fontSize: 14},
    addressCard: {
      backgroundColor: theme.bgSecondary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    addressLabel: {color: theme.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 4},
    address: {color: theme.accent, fontSize: 20, fontWeight: '700', marginBottom: 14},
    fingerprint: {color: theme.textSecondary, fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
    noticeCard: {
      backgroundColor: theme.bgSecondary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    noticeTitle: {color: theme.text, fontSize: 13, fontWeight: '700', marginBottom: 4},
    noticeBody: {color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 12},
    nameInput: {
      minHeight: 48,
      backgroundColor: theme.bgTertiary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      color: theme.text,
      fontSize: 15,
    },
  });
