/**
 * GhostLink Mobile — Ghost Mesh Setup Modal
 *
 * A 3-step modal for configuring Ghost Mesh (Yggdrasil) identity:
 *   1. Intro — Explains what Ghost Mesh is and prerequisites
 *   2. Seed  — Enter seed phrase + Yggdrasil address/pubkey for verification
 *   3. Result — Shows derived keys with copy buttons + verification instructions
 *
 * Matches the desktop (index.html) Ghost Mesh setup flow.
 *
 * @module GhostMeshSetupModal
 */

import React, {useState, useCallback} from 'react';
import {
  View,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Vibration,
  Platform,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from './ScaledText';
import Clipboard from '@react-native-clipboard/clipboard';
import {useTheme} from '../context/ThemeContext';
import CryptoService from '../services/CryptoService';

// ─── IPv6 Normalizer ─────────────────────────────────────────────────────────

function normalizeIPv6(ip) {
  if (!ip) return '';
  let clean = ip.replace(/[\[\]]/g, '').trim().toLowerCase();
  if (clean.includes('::')) {
    const parts = clean.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    const middle = Array(missing).fill('0');
    clean = [...left, ...middle, ...right].join(':');
  }
  return clean
    .split(':')
    .map(seg => parseInt(seg || '0', 16).toString(16).padStart(4, '0'))
    .join(':');
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GhostMeshSetupModal({visible, onClose, onComplete}) {
  const {theme} = useTheme();

  const [step, setStep] = useState('intro'); // 'intro' | 'seed' | 'result'
  const [seedInput, setSeedInput] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [pubKeyInput, setPubKeyInput] = useState('');
  const [derivedAddress, setDerivedAddress] = useState('');
  const [derivedPubKey, setDerivedPubKey] = useState('');
  const [derivedPrivKey, setDerivedPrivKey] = useState('');
  const [verifying, setVerifying] = useState(false);

  const resetState = useCallback(() => {
    setStep('intro');
    setSeedInput('');
    setAddressInput('');
    setPubKeyInput('');
    setDerivedAddress('');
    setDerivedPubKey('');
    setDerivedPrivKey('');
    setVerifying(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const handleVerify = useCallback(async () => {
    const words = seedInput.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      Alert.alert('Invalid Seed', 'Seed phrase must be 12 or 24 words.');
      return;
    }
    if (!addressInput.trim()) {
      Alert.alert('Missing Address', 'Please enter your local Yggdrasil IP address.');
      return;
    }

    setVerifying(true);
    try {
      const derived = await CryptoService.deriveLegacyYggdrasilIP(words);

      const normPasted = normalizeIPv6(addressInput);
      const normDerived = normalizeIPv6(derived.address);

      setDerivedAddress(derived.address);
      setDerivedPubKey(derived.publicKeyHex);
      setDerivedPrivKey(derived.privateKeyHex);

      if (normPasted !== normDerived) {
        Alert.alert(
          'Verification Failed',
          `Derived address (${derived.address}) does not match the entered address.`,
        );
        setVerifying(false);
        return;
      }

      // Verify public key if provided (stronger check)
      if (pubKeyInput.trim()) {
        const normPubPasted = pubKeyInput.trim().toLowerCase().replace(/\s/g, '');
        const normPubDerived = derived.publicKeyHex.toLowerCase();
        if (normPubPasted !== normPubDerived) {
          Alert.alert(
            'Verification Failed',
            `Derived X25519 public key does not match the pasted public key.`,
          );
          setVerifying(false);
          return;
        }
      }

      Vibration.vibrate(15);
      setStep('result');
    } catch (err) {
      Alert.alert('Derivation Error', err.message);
    } finally {
      setVerifying(false);
    }
  }, [seedInput, addressInput, pubKeyInput]);

  const handleSaveAndEnable = useCallback(() => {
    Vibration.vibrate(15);
    onComplete({
      address: derivedAddress,
      publicKeyHex: derivedPubKey,
      privateKeyHex: derivedPrivKey,
    });
    resetState();
  }, [derivedAddress, derivedPubKey, derivedPrivKey, onComplete, resetState]);

  const copyToClipboard = useCallback((text, label) => {
    if (typeof Clipboard?.setString === 'function') {
      Clipboard.setString(text);
    }
    Vibration.vibrate(10);
    Alert.alert('Copied', `${label} copied to clipboard.`);
  }, []);

  // ── Render ──

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View
          style={[
            styles.container,
            {backgroundColor: theme.bg, borderColor: theme.accent + '30'},
          ]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={[styles.headerIcon, {color: theme.accent}]}>
                {'\u25C9'}
              </Text>
              <Text style={[styles.headerTitle, {color: theme.text}]}>
                GHOST MESH SETUP
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Text style={[styles.closeBtn, {color: theme.textMuted}]}>
                {'\u2715'}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}>

            {/* ─── Step 1: Intro ─── */}
            {step === 'intro' && (
              <View>
                <Text style={[styles.body, {color: theme.textSecondary}]}>
                  Ghost Mesh integrates the decentralized, cryptographically-routed{' '}
                  <Text style={{fontWeight: '700', color: theme.text}}>Yggdrasil</Text>{' '}
                  IPv6 network directly into GhostLink as a transport layer.
                </Text>
                <Text style={[styles.body, {color: theme.textSecondary}]}>
                  This allows you to establish direct IP-to-IP encrypted connections
                  to peers without relying on any signaling servers.
                </Text>

                <View
                  style={[
                    styles.infoBox,
                    {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                  ]}>
                  <Text style={[styles.infoBoxTitle, {color: theme.text}]}>
                    Prerequisites:
                  </Text>
                  <Text style={[styles.infoBoxItem, {color: theme.textSecondary}]}>
                    {'\u2022'} A Yggdrasil daemon must be installed and running on
                    a device you control (desktop/server).
                  </Text>
                  <Text style={[styles.infoBoxItem, {color: theme.textSecondary}]}>
                    {'\u2022'} The daemon must be configured with a Node identity
                    derived from your GhostLink recovery phrase.
                  </Text>
                </View>

                <View
                  style={[
                    styles.warningBox,
                    {backgroundColor: '#d69e2e10', borderColor: '#d69e2e30'},
                  ]}>
                  <Text style={[styles.warningTitle, {color: '#d69e2e'}]}>
                    {'\u26A0'} Mobile Note
                  </Text>
                  <Text style={[styles.warningText, {color: '#a0905a'}]}>
                    On mobile, Ghost Mesh currently operates in Web Client mode
                    {'\u2009'}{'\u2014'}{'\u2009'}it derives your Yggdrasil identity for
                    peer discovery and uses WebRTC for transport. Full direct TCP
                    mesh connections require the desktop Electron app.
                  </Text>
                </View>

                <View style={styles.btnRow}>
                  <View />
                  <TouchableOpacity
                    style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
                    onPress={() => setStep('seed')}>
                    <Text style={styles.primaryBtnText}>
                      Next: Cryptographic Setup
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* ─── Step 2: Seed & Verify ─── */}
            {step === 'seed' && (
              <View>
                <Text style={[styles.body, {color: theme.textSecondary}]}>
                  Enter your 12-word seed phrase and your current local Yggdrasil
                  address and public key. We will verify they match before saving.
                </Text>

                {/* Seed Input */}
                <Text style={[styles.inputLabel, {color: theme.textMuted}]}>
                  12-WORD RECOVERY PHRASE
                </Text>
                <TextInput
                  value={seedInput}
                  onChangeText={setSeedInput}
                  placeholder="word1 word2 word3..."
                  placeholderTextColor={theme.textMuted}
                  multiline
                  numberOfLines={3}
                  style={[
                    styles.textArea,
                    {
                      backgroundColor: theme.bgTertiary,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textAlignVertical="top"
                />

                {/* Address Input */}
                <Text style={[styles.inputLabel, {color: theme.textMuted}]}>
                  PASTED LOCAL YGGDRASIL IP ADDRESS
                </Text>
                <TextInput
                  value={addressInput}
                  onChangeText={text => setAddressInput(text.trim())}
                  placeholder="e.g. 201:97c4:..."
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.textInput,
                    {
                      backgroundColor: theme.bgTertiary,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                {/* Public Key Input (optional, stronger verification) */}
                <Text style={[styles.inputLabel, {color: theme.textMuted}]}>
                  PASTED LOCAL YGGDRASIL PUBLIC KEY (HEX)
                </Text>
                <TextInput
                  value={pubKeyInput}
                  onChangeText={text => setPubKeyInput(text.trim().toLowerCase())}
                  placeholder="64 hex chars from yggdrasilctl getSelf (optional)"
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.textInput,
                    {
                      backgroundColor: theme.bgTertiary,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={[styles.helperText, {color: theme.textMuted}]}>
                  Run{' '}
                  <Text style={{fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'}}>
                    yggdrasilctl getSelf
                  </Text>{' '}
                  {'\u2014'} paste both address and public key hex for stronger verification.
                </Text>

                <View style={styles.btnRow}>
                  <TouchableOpacity onPress={() => setStep('intro')}>
                    <Text style={[styles.backText, {color: theme.textMuted}]}>
                      Back
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      {backgroundColor: theme.accent, opacity: verifying ? 0.6 : 1},
                    ]}
                    onPress={handleVerify}
                    disabled={verifying}>
                    <Text style={styles.primaryBtnText}>
                      {verifying ? 'Deriving X25519 key\u2026' : 'Verify & Continue'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* ─── Step 3: Result ─── */}
            {step === 'result' && (
              <View>
                {/* Success Banner */}
                <View style={styles.successBanner}>
                  <Text style={styles.successIcon}>{'\u2714'}</Text>
                  <Text style={styles.successText}>
                    Cryptographic Matching Confirmed!
                  </Text>
                </View>

                <Text style={[styles.body, {color: theme.textSecondary}]}>
                  Your seed phrase matches your Yggdrasil IPv6 address. Here are
                  the keys for your local Yggdrasil config:
                </Text>

                {/* Key Display Box */}
                <View
                  style={[
                    styles.keyBox,
                    {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                  ]}>
                  {/* Address */}
                  <Text style={[styles.keyLabel, {color: theme.textMuted}]}>
                    NODE IPV6 ADDRESS
                  </Text>
                  <Text
                    style={[styles.keyValue, {color: theme.text}]}
                    selectable>
                    {derivedAddress}
                  </Text>

                  {/* Private Key */}
                  <View style={styles.keyDivider} />
                  <View style={styles.keyRow}>
                    <View style={{flex: 1}}>
                      <Text style={[styles.keyLabel, {color: theme.textMuted}]}>
                        NODE PRIVATE KEY (NODEPRIVHEX)
                      </Text>
                      <Text
                        style={[styles.keyValueSmall, {color: theme.textSecondary}]}
                        numberOfLines={1}
                        ellipsizeMode="middle">
                        {derivedPrivKey + derivedPubKey}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() =>
                        copyToClipboard(
                          derivedPrivKey + derivedPubKey,
                          'Private key',
                        )
                      }>
                      <Text style={[styles.copyLink, {color: theme.accent}]}>
                        Copy
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Public Key */}
                  <View style={styles.keyDivider} />
                  <View style={styles.keyRow}>
                    <View style={{flex: 1}}>
                      <Text style={[styles.keyLabel, {color: theme.textMuted}]}>
                        NODE PUBLIC KEY (NODEPUBHEX)
                      </Text>
                      <Text
                        style={[styles.keyValueSmall, {color: theme.textSecondary}]}
                        numberOfLines={1}
                        ellipsizeMode="middle">
                        {derivedPubKey}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() =>
                        copyToClipboard(derivedPubKey, 'Public key')
                      }>
                      <Text style={[styles.copyLink, {color: theme.accent}]}>
                        Copy
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Verification Warning */}
                <View
                  style={[
                    styles.warningBox,
                    {backgroundColor: '#d69e2e10', borderColor: '#d69e2e30'},
                  ]}>
                  <Text style={[styles.warningTitle, {color: '#d69e2e'}]}>
                    {'\u26A0'} Post-Setup Verification
                  </Text>
                  <Text style={[styles.warningText, {color: '#a0905a'}]}>
                    After configuring your Yggdrasil daemon with these keys and
                    restarting, run{' '}
                    <Text style={{fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: theme.text}}>
                      yggdrasilctl getSelf
                    </Text>{' '}
                    and compare both the address AND the full public key hex.
                    Address-only matching is insufficient {'\u2014'} address
                    collisions are theoretically possible with truncated SHA-512
                    hashes.
                  </Text>
                </View>

                <View style={styles.btnRow}>
                  <TouchableOpacity onPress={() => setStep('seed')}>
                    <Text style={[styles.backText, {color: theme.textMuted}]}>
                      Back
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
                    onPress={handleSaveAndEnable}>
                    <Text style={styles.primaryBtnText}>Save & Enable Mesh</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  container: {
    width: '100%',
    maxWidth: 500,
    maxHeight: '90%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  scrollContent: {
    paddingBottom: 10,
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIcon: {
    fontSize: 18,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  closeBtn: {
    fontSize: 18,
    fontWeight: '300',
  },

  /* Body text */
  body: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 14,
  },

  /* Info boxes */
  infoBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  infoBoxTitle: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  infoBoxItem: {
    fontSize: 12,
    lineHeight: 20,
    paddingLeft: 8,
    marginBottom: 4,
  },

  /* Warning boxes */
  warningBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 16,
  },
  warningTitle: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  warningText: {
    fontSize: 11,
    lineHeight: 17,
  },

  /* Inputs */
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 4,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    marginBottom: 14,
    minHeight: 70,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    marginBottom: 8,
  },
  helperText: {
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 18,
  },

  /* Buttons */
  btnRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  primaryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#000',
  },
  backText: {
    fontSize: 12,
  },

  /* Success */
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  successIcon: {
    fontSize: 18,
    color: '#00cc66',
  },
  successText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#00cc66',
  },

  /* Key display */
  keyBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  keyLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  keyValue: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  keyValueSmall: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  keyDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginVertical: 10,
  },
  copyLink: {
    fontSize: 11,
    fontWeight: '600',
    textDecorationLine: 'underline',
    paddingTop: 14,
  },
});
