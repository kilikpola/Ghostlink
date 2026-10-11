/**
 * GhostLink Mobile - ChatScreen
 *
 * Individual peer-to-peer encrypted chat view with full messaging
 * capabilities: text, files, images, voice messages, replies,
 * read receipts, typing indicators, and context actions.
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Vibration,
  Dimensions,
  Modal,
  Image,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StatusBar,
  ActivityIndicator,
  PanResponder,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from '../components/ScaledText';
import Animated, {
  FadeIn,
  SlideInUp,
  SlideInDown,
  SlideOutDown,
  SlideInRight,
  SlideInLeft,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import WebRTCService from '../services/WebRTCService';
import {CALLS_AVAILABLE, CALLS_UNAVAILABLE_REASON} from '../utils/capabilities';
import {parseInboundChat, parseInboundAck} from '../utils/untrusted';
import PeerAvatar from '../components/PeerAvatar';

// ─── Constants ─────────────────────────────────────────────
const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');

const ACCENT = '#00ffa3';
const ACCENT2 = '#b347ff';
const BG = '#0a0a0f';
const BG_SECONDARY = '#12121a';
const BG_TERTIARY = '#1a1a25';
const TEXT_PRIMARY = '#e0e0e0';
const TEXT_SECONDARY = '#8a8a9a';
const TEXT_MUTED = '#5a5a6a';
const BORDER_COLOR = 'rgba(255,255,255,0.06)';
const DANGER = '#ff4466';

const EMOJIS = [
  '😀','😂','😍','🥰','😎','🤔','😤','😭','🥺','😅',
  '🙏','👍','👎','❤️','🔥','✅','⚡','🎉','👀','💀',
  '🤝','🚀','💡','🔒','⚠️','📎','📁','🛡️','🌐','💬',
  '😈','🤖','👻','💎','🌙','✨','🎵','🎮','☕','🍕',
];

const FILE_ICONS = {
  pdf: {icon: '📄', color: '#ff4444'},
  doc: {icon: '📝', color: '#4488ff'},
  docx: {icon: '📝', color: '#4488ff'},
  zip: {icon: '📦', color: '#ffaa00'},
  rar: {icon: '📦', color: '#ffaa00'},
  png: {icon: '🖼️', color: '#00cc88'},
  jpg: {icon: '🖼️', color: '#00cc88'},
  jpeg: {icon: '🖼️', color: '#00cc88'},
  gif: {icon: '🖼️', color: '#b347ff'},
  mp4: {icon: '🎬', color: '#b347ff'},
  mp3: {icon: '🎵', color: '#ff6600'},
  py: {icon: '🐍', color: '#3776ab'},
  js: {icon: '⚡', color: '#f7df1e'},
  ts: {icon: '⚡', color: '#3178c6'},
  json: {icon: '📋', color: '#6a6a7a'},
  txt: {icon: '📃', color: '#8a8a9a'},
  apk: {icon: '📱', color: '#3ddc84'},
};

const MESSAGE_STATUS = {
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
};

// ─── Helper Functions ──────────────────────────────────────

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function formatDateHeader(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatVoiceDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function groupMessagesByDay(messages) {
  const groups = [];
  let currentDay = null;

  for (const msg of messages) {
    const dayKey = new Date(msg.timestamp).toDateString();
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      groups.push({
        type: 'date_header',
        id: `date_${dayKey}`,
        timestamp: msg.timestamp,
      });
    }
    groups.push(msg);
  }

  return groups;
}

// ─── Typing Indicator Component ────────────────────────────

function TypingIndicator() {
  const dot1Y = useSharedValue(0);
  const dot2Y = useSharedValue(0);
  const dot3Y = useSharedValue(0);

  useEffect(() => {
    const bounce = (sv, delay) => {
      setTimeout(() => {
        sv.value = withRepeat(
          withSequence(
            withTiming(-6, {duration: 300, easing: Easing.out(Easing.ease)}),
            withTiming(0, {duration: 300, easing: Easing.in(Easing.ease)}),
          ),
          -1,
        );
      }, delay);
    };
    bounce(dot1Y, 0);
    bounce(dot2Y, 150);
    bounce(dot3Y, 300);
  }, [dot1Y, dot2Y, dot3Y]);

  const anim1 = useAnimatedStyle(() => ({
    transform: [{translateY: dot1Y.value}],
  }));
  const anim2 = useAnimatedStyle(() => ({
    transform: [{translateY: dot2Y.value}],
  }));
  const anim3 = useAnimatedStyle(() => ({
    transform: [{translateY: dot3Y.value}],
  }));

  return (
    <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        <Animated.View style={[styles.typingDot, anim1]} />
        <Animated.View style={[styles.typingDot, anim2]} />
        <Animated.View style={[styles.typingDot, anim3]} />
      </View>
    </View>
  );
}

// ─── Read Receipt Icon ─────────────────────────────────────

function ReadReceipt({status}) {
  if (status === MESSAGE_STATUS.SENDING) {
    return <Text style={styles.receiptSending}>○</Text>;
  }
  if (status === MESSAGE_STATUS.SENT) {
    return <Text style={styles.receiptSent}>✓</Text>;
  }
  if (status === MESSAGE_STATUS.DELIVERED) {
    return <Text style={styles.receiptDelivered}>✓✓</Text>;
  }
  if (status === MESSAGE_STATUS.READ) {
    return <Text style={styles.receiptRead}>✓✓</Text>;
  }
  if (status === MESSAGE_STATUS.FAILED) {
    return <Text style={styles.receiptFailed}>!</Text>;
  }
  return null;
}

// ─── Voice Record Button ───────────────────────────────────

function VoiceRecordButton({onRecordComplete}) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [swipeCancelled, setSwipeCancelled] = useState(false);
  const recordInterval = useRef(null);
  const startX = useRef(0);
  const pulseScale = useSharedValue(1);

  useEffect(() => {
    if (isRecording) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.2, {duration: 600}),
          withTiming(1, {duration: 600}),
        ),
        -1,
      );
    } else {
      pulseScale.value = withTiming(1, {duration: 200});
    }
  }, [isRecording, pulseScale]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{scale: pulseScale.value}],
  }));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        startX.current = evt.nativeEvent.pageX;
        setIsRecording(true);
        setSwipeCancelled(false);
        setRecordDuration(0);
        Vibration.vibrate(30);
        recordInterval.current = setInterval(() => {
          setRecordDuration(d => d + 1);
        }, 1000);
      },
      onPanResponderMove: (evt) => {
        const dx = evt.nativeEvent.pageX - startX.current;
        if (dx < -80) {
          setSwipeCancelled(true);
        }
      },
      onPanResponderRelease: () => {
        if (recordInterval.current) clearInterval(recordInterval.current);
        if (!swipeCancelled && recordDuration > 0 && onRecordComplete) {
          onRecordComplete(recordDuration);
        }
        setIsRecording(false);
        setRecordDuration(0);
        setSwipeCancelled(false);
      },
    }),
  ).current;

  if (isRecording) {
    return (
      <Animated.View
        entering={FadeIn.duration(150)}
        style={styles.voiceRecordingBar}>
        <Animated.View style={[styles.voiceRecordDot, pulseStyle]} />
        <Text style={styles.voiceRecordTime}>
          {formatVoiceDuration(recordDuration)}
        </Text>
        <Text style={styles.voiceRecordHint}>
          {swipeCancelled ? 'Release to cancel' : '< Swipe to cancel'}
        </Text>
        <View {...panResponder.panHandlers} style={styles.voiceRecordHandle}>
          <Text style={styles.voiceRecordIcon}>🎙️</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <View {...panResponder.panHandlers}>
      <View style={styles.voiceBtn}>
        <Text style={{fontSize: 18}}>🎙️</Text>
      </View>
    </View>
  );
}

// ─── File Message Card ─────────────────────────────────────

function FileMessageCard({file}) {
  const ext = file.name
    ? file.name.split('.').pop().toLowerCase()
    : 'unknown';
  const fileInfo = FILE_ICONS[ext] || {icon: '📄', color: TEXT_MUTED};

  return (
    <View style={styles.fileCard}>
      <View style={[styles.fileIconBox, {backgroundColor: fileInfo.color + '20'}]}>
        <Text style={styles.fileIconEmoji}>{fileInfo.icon}</Text>
        <Text style={[styles.fileExtLabel, {color: fileInfo.color}]}>
          {ext.toUpperCase()}
        </Text>
      </View>
      <View style={styles.fileDetails}>
        <Text style={styles.fileNameText} numberOfLines={1}>
          {file.name || 'Unknown file'}
        </Text>
        <Text style={styles.fileSizeText}>
          {formatFileSize(file.size || 0)}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.fileDownloadBtn}
        onPress={() => Vibration.vibrate(15)}>
        <Text style={styles.fileDownloadIcon}>⬇️</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Image Message ─────────────────────────────────────────

function ImageMessage({uri, onPress}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={styles.imageMessageContainer}>
      {!loaded && (
        <View style={styles.imagePlaceholder}>
          <ActivityIndicator color={ACCENT} size="small" />
        </View>
      )}
      <Image
        source={{uri}}
        style={[styles.imageThumb, !loaded && {width: 0, height: 0}]}
        resizeMode="cover"
        onLoad={() => setLoaded(true)}
      />
    </TouchableOpacity>
  );
}

// ─── System Message ────────────────────────────────────────

function SystemMessage({text, timestamp}) {
  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.systemMsgWrap}>
      <View style={styles.systemMsgBubble}>
        <Text style={styles.systemMsgText}>{text}</Text>
        {timestamp && (
          <Text style={styles.systemMsgTime}>{formatTime(timestamp)}</Text>
        )}
      </View>
    </Animated.View>
  );
}

// ─── Date Header ───────────────────────────────────────────

function DateHeader({timestamp}) {
  return (
    <View style={styles.dateHeaderWrap}>
      <View style={styles.dateHeaderLine} />
      <Text style={styles.dateHeaderText}>
        {formatDateHeader(timestamp)}
      </Text>
      <View style={styles.dateHeaderLine} />
    </View>
  );
}

// ─── Message Bubble (Full) ─────────────────────────────────

function MessageBubbleInline({
  message,
  isMine,
  replyMessage,
  isPinned,
  onLongPress,
  onReplyPress,
  onImagePress,
}) {
  const entering = isMine
    ? SlideInRight.duration(200).springify()
    : SlideInLeft.duration(200).springify();

  const bubbleBg = isMine ? 'rgba(0,255,163,0.12)' : BG_TERTIARY;
  const bubbleBorder = isMine ? ACCENT + '30' : BORDER_COLOR;

  return (
    <Animated.View
      entering={entering}
      style={[
        styles.msgWrapper,
        {alignItems: isMine ? 'flex-end' : 'flex-start'},
      ]}>
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={() => {
          Vibration.vibrate(30);
          onLongPress && onLongPress(message);
        }}
        delayLongPress={400}
        style={[
          styles.msgBubble,
          {
            backgroundColor: bubbleBg,
            borderColor: isPinned ? '#ffaa00' + '60' : bubbleBorder,
            borderWidth: isPinned ? 1.5 : 1,
          },
        ]}>
        {isPinned && (
          <View style={styles.pinnedBadge}>
            <Text style={styles.pinnedIcon}>📌</Text>
            <Text style={styles.pinnedLabel}>Pinned</Text>
          </View>
        )}

        {replyMessage && (
          <TouchableOpacity
            onPress={() => onReplyPress && onReplyPress(replyMessage.id)}
            style={styles.replyQuote}>
            <View style={styles.replyQuoteLine} />
            <View style={styles.replyQuoteContent}>
              <Text style={styles.replyQuoteSender} numberOfLines={1}>
                {replyMessage.sender}
              </Text>
              <Text style={styles.replyQuoteText} numberOfLines={1}>
                {replyMessage.plainText || replyMessage.text}
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {!isMine && message.sender && (
          <Text style={styles.senderLabel}>{message.sender}</Text>
        )}

        {message.type === 'image' && message.imageUri && (
          <ImageMessage
            uri={message.imageUri}
            onPress={() => onImagePress && onImagePress(message.imageUri)}
          />
        )}

        {message.type === 'file' && message.file && (
          <FileMessageCard file={message.file} />
        )}

        {message.type === 'voice' && (
          <View style={styles.voiceMsgWrap}>
            <TouchableOpacity style={styles.voicePlayBtn}>
              <Text style={{fontSize: 16}}>▶️</Text>
            </TouchableOpacity>
            <View style={styles.voiceWaveform}>
              {Array.from({length: 20}).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.voiceBar,
                    {
                      height: 4 + Math.random() * 16,
                      backgroundColor: isMine ? ACCENT + '80' : TEXT_MUTED,
                    },
                  ]}
                />
              ))}
            </View>
            <Text style={styles.voiceDurationText}>
              {formatVoiceDuration(message.voiceDuration || 0)}
            </Text>
          </View>
        )}

        {(message.plainText || message.text) &&
          message.type !== 'system' && (
            <Text style={styles.msgText}>
              {message.plainText || message.text}
            </Text>
          )}

        <View style={styles.metaRow}>
          <TransportBadge message={message} />
          <Text style={styles.timestampText}>
            {formatTime(message.timestamp)}
          </Text>
          {isMine && <ReadReceipt status={message.status || 'sent'} />}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

/**
 * What protected this message:
 *
 *   gmp           — Ghost Mesh, end to end
 *   webrtc-e2e    — direct, sealed with AES-256-GCM (utils/session-crypto.js)
 *   anything else — only DTLS on the hop; no padlock is shown.
 */
function TransportBadge({message}) {
  if (!message) return null;
  const endToEnd = message.encrypted === true &&
    (message.transport === 'gmp' || message.transport === 'webrtc-e2e');

  if (endToEnd) {
    return <Text style={styles.transportBadgeSecure} accessibilityLabel="End-to-end encrypted">🔒</Text>;
  }
  // Explicitly unlabelled rather than reassuring.
  if (message.transport === 'webrtc-plain') {
    return <Text style={styles.transportBadgePlain}>transport-encrypted</Text>;
  }
  return null;
}

// ─── Emoji Grid Overlay ────────────────────────────────────

function EmojiOverlay({visible, onSelect, onClose}) {
  if (!visible) return null;

  return (
    <Animated.View
      entering={SlideInDown.duration(250)}
      exiting={SlideOutDown.duration(200)}
      style={styles.emojiOverlay}>
      <View style={styles.emojiOverlayHeader}>
        <Text style={styles.emojiOverlayTitle}>Emoji</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.emojiCloseBtn}>✕</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.emojiGrid}>
        {EMOJIS.map((emoji, idx) => (
          <TouchableOpacity
            key={idx}
            style={styles.emojiGridItem}
            onPress={() => {
              Vibration.vibrate(10);
              onSelect(emoji);
            }}>
            <Text style={styles.emojiGridText}>{emoji}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </Animated.View>
  );
}

// ─── Attach Menu ───────────────────────────────────────────

function AttachMenu({visible, onClose, onSelect}) {
  if (!visible) return null;

  const options = [
    {key: 'camera', icon: '📷', label: 'Camera'},
    {key: 'gallery', icon: '🖼️', label: 'Gallery'},
    {key: 'file', icon: '📁', label: 'File'},
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.attachOverlay}>
          <Animated.View
            entering={SlideInDown.duration(200)}
            style={styles.attachMenu}>
            {options.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={styles.attachOption}
                onPress={() => {
                  Vibration.vibrate(15);
                  onSelect(opt.key);
                  onClose();
                }}>
                <View style={styles.attachIconWrap}>
                  <Text style={styles.attachIcon}>{opt.icon}</Text>
                </View>
                <Text style={styles.attachLabel}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── Context Menu ──────────────────────────────────────────

function ContextMenu({visible, message, onClose, onAction, isPinned}) {
  if (!visible || !message) return null;

  const actions = [
    {key: 'reply', label: 'Reply', icon: '↩️'},
    {key: 'copy', label: 'Copy Text', icon: '📋'},
    {key: 'pin', label: isPinned ? 'Unpin' : 'Pin', icon: '📌'},
    {key: 'delete', label: 'Delete', icon: '🗑️', danger: true},
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.contextOverlay}>
          <Animated.View
            entering={FadeIn.duration(150)}
            style={styles.contextMenu}>
            <View style={styles.contextPreview}>
              <Text style={styles.contextPreviewText} numberOfLines={2}>
                {message.plainText || message.text || ''}
              </Text>
            </View>
            {actions.map(action => (
              <TouchableOpacity
                key={action.key}
                style={styles.contextItem}
                onPress={() => {
                  Vibration.vibrate(15);
                  onAction(action.key);
                }}>
                <Text style={styles.contextItemIcon}>{action.icon}</Text>
                <Text
                  style={[
                    styles.contextItemLabel,
                    action.danger && {color: DANGER},
                  ]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── Image Fullscreen Viewer ───────────────────────────────

function ImageViewer({visible, uri, onClose}) {
  if (!visible || !uri) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <View style={styles.imageViewerBg}>
        <TouchableOpacity style={styles.imageViewerClose} onPress={onClose}>
          <Text style={styles.imageViewerCloseText}>✕</Text>
        </TouchableOpacity>
        <Image
          source={{uri}}
          style={styles.imageViewerImage}
          resizeMode="contain"
        />
      </View>
    </Modal>
  );
}

// ─── Main ChatScreen Component ─────────────────────────────

export default function ChatScreen({route, navigation}) {
  const {theme} = useTheme();
  const {
    identity,
    peers,
    messages: allMessages,
    addMessage,
    updateMessage,
  } = useApp();

  // Route params
  const peerId = route?.params?.peerId || route?.params?.peer || null;

  // State
  const [inputText, setInputText] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [contextMessage, setContextMessage] = useState(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [pinnedMessageIds, setPinnedMessageIds] = useState(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewerImage, setViewerImage] = useState(null);
  // No typing frames exist on the wire yet.
  const [peerTyping] = useState(false);

  const flatListRef = useRef(null);
  const inputRef = useRef(null);

  // Derive peer info
  const peer = useMemo(() => {
    if (!peerId) return null;
    if (peers instanceof Map) {
      return peers.get(peerId) || null;
    }
    if (Array.isArray(peers)) {
      return peers.find(p => p.id === peerId) || null;
    }
    return null;
  }, [peers, peerId]);

  const peerName = peer?.name || 'Peer';
  const peerOnline = peer?.online ?? false;
  const peerStatusText = peerTyping
    ? 'typing...'
    : peerOnline
    ? 'online'
    : 'offline';

  // Get messages for this room
  const roomMessages = useMemo(() => {
    const roomId = peerId || 'general';
    if (allMessages instanceof Map) {
      return allMessages.get(roomId) || [];
    }
    if (allMessages && typeof allMessages === 'object') {
      return allMessages[roomId] || [];
    }
    return [];
  }, [allMessages, peerId]);

  // Group messages by day for display
  const groupedMessages = useMemo(
    () => groupMessagesByDay(roomMessages),
    [roomMessages],
  );

  // Auto-scroll on new message
  useEffect(() => {
    if (groupedMessages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({animated: true});
      }, 150);
    }
  }, [groupedMessages.length]);

  // ── Send Message ──

  /** What the transport can currently do for this peer (drives the header badge). */
  const [peerSecurity, setPeerSecurity] = useState(() =>
    peerId ? WebRTCService.getPeerSecurity(peerId) : {transport: 'none', encrypted: false, ready: false},
  );

  useEffect(() => {
    if (!peerId) return undefined;
    const refresh = () => setPeerSecurity(WebRTCService.getPeerSecurity(peerId));
    refresh();
    WebRTCService.on('session-established', refresh);
    WebRTCService.on('mesh-status', refresh);
    WebRTCService.on('datachannel-open', refresh);
    WebRTCService.on('datachannel-close', refresh);
    return () => {
      WebRTCService.off('session-established', refresh);
      WebRTCService.off('mesh-status', refresh);
      WebRTCService.off('datachannel-open', refresh);
      WebRTCService.off('datachannel-close', refresh);
    };
  }, [peerId]);

  /**
   * Inbound traffic: chat messages, and acks for our messages (the only thing
   * that marks DELIVERED). `encrypted` comes from the transport.
   */
  useEffect(() => {
    if (!peerId) return undefined;
    const roomId = peerId;

    const onMessage = ({peerId: from, data, transport, encrypted}) => {
      if (from !== peerId) return;

      // Every field here was written by the peer and is persisted, then
      // rendered on the next launch — see utils/untrusted.js.
      const ackId = parseInboundAck(data);
      if (ackId) {
        updateMessage(roomId, ackId, {status: MESSAGE_STATUS.DELIVERED});
        return;
      }

      const chat = parseInboundChat(data);
      if (chat) {
        addMessage(roomId, {
          id: chat.id || `rx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          sender: peer?.name || 'Peer',
          // Direction is recorded, never inferred from the sender's name.
          outgoing: false,
          text: chat.text,
          plainText: chat.text,
          timestamp: chat.timestamp,
          type: 'text',
          status: MESSAGE_STATUS.READ,
          replyTo: chat.replyTo,
          transport: transport || 'unknown',
          encrypted: !!encrypted,
        });
        // Acknowledge, so their client can show a delivery it can stand behind.
        if (chat.id) {
          WebRTCService.sendMessage(peerId, {__gl: 'ack', id: chat.id});
        }
      }
    };

    WebRTCService.on('message', onMessage);
    return () => WebRTCService.off('message', onMessage);
  }, [peerId, peer, addMessage, updateMessage]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;

    Vibration.vibrate(15);

    const roomId = peerId || 'general';
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // How this message will actually travel decides what the UI may claim
    // about it. Recorded per message, because a conversation can move between
    // the mesh and a direct connection.
    const security = peerId
      ? WebRTCService.getPeerSecurity(peerId)
      : {transport: 'none', encrypted: false, ready: false};

    const newMessage = {
      id: messageId,
      sender: identity?.name || 'You',
      outgoing: true,
      text,
      plainText: text,
      timestamp: Date.now(),
      type: 'text',
      status: MESSAGE_STATUS.SENDING,
      replyTo: replyTo?.id || null,
      transport: security.transport,
      encrypted: security.encrypted,
    };

    addMessage(roomId, newMessage);

    // Actually send it. A status only moves because the transport said so:
    // SENT when it went out, FAILED when it could not, and DELIVERED only
    // later, when the peer acknowledges it.
    if (peerId) {
      const sent = WebRTCService.sendMessage(peerId, {
        __gl: 'chat',
        id: messageId,
        text,
        replyTo: replyTo?.id || null,
        timestamp: newMessage.timestamp,
      });
      updateMessage(roomId, messageId, {
        status: sent ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED,
      });
    } else {
      updateMessage(roomId, messageId, {status: MESSAGE_STATUS.FAILED});
    }
    setInputText('');
    setReplyTo(null);
    setShowEmoji(false);
    setInputHeight(40);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({animated: true});
    }, 100);
  }, [inputText, peerId, identity, addMessage, updateMessage, replyTo]);

  // ── Long Press Context ──

  const handleLongPress = useCallback(message => {
    setContextMessage(message);
    setShowContextMenu(true);
  }, []);

  const handleContextAction = useCallback(
    action => {
      if (!contextMessage) return;

      switch (action) {
        case 'reply':
          setReplyTo(contextMessage);
          inputRef.current?.focus();
          break;
        case 'copy':
          // In production: Clipboard.setString(contextMessage.plainText || contextMessage.text)
          Alert.alert('Copied', 'Message text copied to clipboard');
          break;
        case 'pin':
          setPinnedMessageIds(prev => {
            const next = new Set(prev);
            if (next.has(contextMessage.id)) {
              next.delete(contextMessage.id);
            } else {
              next.add(contextMessage.id);
            }
            return next;
          });
          break;
        case 'delete':
          Alert.alert('Delete Message', 'Remove this message?', [
            {text: 'Cancel', style: 'cancel'},
            {text: 'Delete', style: 'destructive', onPress: () => {}},
          ]);
          break;
      }

      setShowContextMenu(false);
      setContextMessage(null);
    },
    [contextMessage],
  );

  // ── Pull to Load Older ──

  const handleLoadOlder = useCallback(() => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    // Simulate loading older messages
    setTimeout(() => setLoadingOlder(false), 1200);
  }, [loadingOlder]);

  // ── Emoji Select ──

  const handleEmojiSelect = useCallback(emoji => {
    setInputText(prev => prev + emoji);
  }, []);

  // ── Attach ──

  const handleAttach = useCallback(type => {
    Alert.alert(
      'Attach',
      `${type.charAt(0).toUpperCase() + type.slice(1)} picker would open here`,
    );
  }, []);

  // ── Voice Record Complete ──

  const handleVoiceRecord = useCallback(
    duration => {
      const roomId = peerId || 'general';
      const voiceMsg = {
        id: `msg_${Date.now()}_voice`,
        sender: identity?.name || 'You',
        outgoing: true,
        text: 'Voice message',
        plainText: 'Voice message',
        timestamp: Date.now(),
        type: 'voice',
        voiceDuration: duration,
        status: MESSAGE_STATUS.SENT,
      };
      addMessage(roomId, voiceMsg);
    },
    [peerId, identity, addMessage],
  );

  // ── Render Item ──

  const renderItem = useCallback(
    ({item}) => {
      // Date header
      if (item.type === 'date_header') {
        return <DateHeader timestamp={item.timestamp} />;
      }

      // System message
      if (item.type === 'system') {
        return (
          <SystemMessage text={item.text || item.plainText} timestamp={item.timestamp} />
        );
      }

      // Regular message
      // Messages saved before `outgoing` existed fall back to the name check.
      const isMine =
        typeof item.outgoing === 'boolean'
          ? item.outgoing
          : item.sender === (identity?.name || 'You');
      const replyMsg = item.replyTo
        ? roomMessages.find(m => m.id === item.replyTo)
        : null;

      return (
        <MessageBubbleInline
          message={item}
          isMine={isMine}
          replyMessage={replyMsg}
          isPinned={pinnedMessageIds.has(item.id)}
          onLongPress={handleLongPress}
          onReplyPress={id => {
            const idx = groupedMessages.findIndex(m => m.id === id);
            if (idx >= 0) {
              flatListRef.current?.scrollToIndex({index: idx, animated: true});
            }
          }}
          onImagePress={uri => setViewerImage(uri)}
        />
      );
    },
    [
      identity,
      roomMessages,
      pinnedMessageIds,
      handleLongPress,
      groupedMessages,
    ],
  );

  const keyExtractor = useCallback(item => item.id, []);

  // Memoised so the list header/footer do not remount on every keystroke.
  const listHeader = useMemo(
    () =>
      loadingOlder ? (
        <View style={styles.loadingOlder}>
          <ActivityIndicator color={ACCENT} size="small" />
          <Text style={styles.loadingOlderText}>Loading older messages...</Text>
        </View>
      ) : null,
    [loadingOlder],
  );

  const listFooter = useMemo(
    () => (peerTyping ? <TypingIndicator /> : null),
    [peerTyping],
  );

  const listEmpty = useMemo(
    () => (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>👻</Text>
        <Text style={styles.emptyTitle}>No messages yet</Text>
        <Text style={styles.emptyDesc}>
          Send a message to start the conversation.
        </Text>
      </View>
    ),
    [],
  );

  // ── Input height handler ──

  const handleContentSizeChange = useCallback(e => {
    const newHeight = Math.min(
      Math.max(40, e.nativeEvent.contentSize.height),
      120, // max 5 lines approx
    );
    setInputHeight(newHeight);
  }, []);

  // ─── Render ──────────────────────────────────────────────

  return (
    <View style={[styles.container, {backgroundColor: theme?.bg || BG}]}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />

      {/* ── Custom Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBackBtn}
          onPress={() => {
            Vibration.vibrate(10);
            navigation.goBack();
          }}>
          <Text style={styles.headerBackIcon}>←</Text>
        </TouchableOpacity>

        <PeerAvatar name={peerName} size={38} online={peerOnline} typing={peerTyping} />

        <View style={styles.headerInfo}>
          <Text style={styles.headerName} numberOfLines={1}>
            {peerName}
          </Text>
          <Text
            style={[
              styles.headerStatus,
              {
                color: peerTyping
                  ? ACCENT
                  : peerOnline
                  ? ACCENT
                  : TEXT_MUTED,
              },
            ]}>
            {peerStatusText}
          </Text>
        </View>

        <View style={styles.headerEncBadge}>
          {/*
            Derived, not assumed. This said E2EE for every conversation
            regardless of whether a session existed — the same unearned claim
            as the empty-state padlock. getPeerSecurity() reports what the
            transport can actually do for this peer right now.
          */}
          <Text style={styles.headerLockIcon}>{peerSecurity.encrypted ? '🔒' : '🔓'}</Text>
          <Text style={styles.headerEncText}>
            {peerSecurity.encrypted ? 'E2EE' : 'Not connected'}
          </Text>
        </View>

        {/*
          Disabled rather than hidden: the control is part of what the app is
          for, and silently removing it reads as a missing feature rather than
          one that is not ready. Tapping it must not enter the call path — that
          path has no rendezvous and would report a connected call that never
          connected. See utils/capabilities.js.
        */}
        <TouchableOpacity
          style={[styles.headerCallBtn, !CALLS_AVAILABLE && styles.headerCallBtnDisabled]}
          disabled={!CALLS_AVAILABLE}
          accessibilityRole="button"
          accessibilityState={{disabled: !CALLS_AVAILABLE}}
          accessibilityLabel={CALLS_AVAILABLE ? 'Start voice call' : CALLS_UNAVAILABLE_REASON}
          onPress={() => {
            if (!CALLS_AVAILABLE) return;
            Vibration.vibrate(15);
            navigation.navigate('Call', {peer: peerId, video: false});
          }}>
          <Text style={styles.headerCallIcon}>📞</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.headerCallBtn, !CALLS_AVAILABLE && styles.headerCallBtnDisabled]}
          disabled={!CALLS_AVAILABLE}
          accessibilityRole="button"
          accessibilityState={{disabled: !CALLS_AVAILABLE}}
          accessibilityLabel={CALLS_AVAILABLE ? 'Start video call' : CALLS_UNAVAILABLE_REASON}
          onPress={() => {
            if (!CALLS_AVAILABLE) return;
            Vibration.vibrate(15);
            navigation.navigate('Call', {peer: peerId, video: true});
          }}>
          <Text style={styles.headerVideoIcon}>📹</Text>
        </TouchableOpacity>
      </View>

      {/* ── Messages + Input ── */}
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}>

        {/* ── Message List (inverted FlatList) ── */}
        <FlatList
          ref={flatListRef}
          data={groupedMessages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          inverted={false}
          contentContainerStyle={styles.messageListContent}
          showsVerticalScrollIndicator={false}
          onStartReached={handleLoadOlder}
          onStartReachedThreshold={0.1}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={11}
          // Android only; it has caused blank cells on iOS.
          removeClippedSubviews={Platform.OS === 'android'}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={listEmpty}
        />

        {/* ── Reply Bar ── */}
        {replyTo && (
          <Animated.View entering={SlideInUp.duration(200)} style={styles.replyBar}>
            <View style={styles.replyBarLine} />
            <View style={styles.replyBarContent}>
              <Text style={styles.replyBarLabel}>
                Replying to {replyTo.sender}
              </Text>
              <Text style={styles.replyBarText} numberOfLines={1}>
                {replyTo.plainText || replyTo.text}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setReplyTo(null)}
              style={styles.replyBarClose}>
              <Text style={styles.replyBarCloseIcon}>✕</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ── Input Bar ── */}
        <View style={styles.inputBar}>
          <TouchableOpacity
            style={styles.inputActionBtn}
            onPress={() => {
              Vibration.vibrate(10);
              setShowEmoji(e => !e);
              if (showAttach) setShowAttach(false);
            }}>
            <Text style={styles.inputActionIcon}>
              {showEmoji ? '⌨️' : '😊'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.inputActionBtn}
            onPress={() => {
              Vibration.vibrate(10);
              setShowAttach(true);
            }}>
            <Text style={styles.inputActionIcon}>📎</Text>
          </TouchableOpacity>

          <View style={[styles.inputField, {height: Math.max(40, inputHeight)}]}>
            <TextInput
              ref={inputRef}
              style={[styles.textInput, {height: Math.max(36, inputHeight - 4)}]}
              placeholder="Encrypted message..."
              placeholderTextColor={TEXT_MUTED}
              value={inputText}
              onChangeText={setInputText}
              onContentSizeChange={handleContentSizeChange}
              multiline
              maxLength={4096}
              textAlignVertical="center"
            />
          </View>

          {inputText.trim().length > 0 ? (
            <TouchableOpacity style={styles.sendBtn} onPress={handleSend}>
              <Text style={styles.sendBtnIcon}>↑</Text>
            </TouchableOpacity>
          ) : (
            <VoiceRecordButton onRecordComplete={handleVoiceRecord} />
          )}
        </View>

        {/* ── Emoji Overlay ── */}
        <EmojiOverlay
          visible={showEmoji}
          onSelect={handleEmojiSelect}
          onClose={() => setShowEmoji(false)}
        />
      </KeyboardAvoidingView>

      {/* ── Attach Menu Modal ── */}
      <AttachMenu
        visible={showAttach}
        onClose={() => setShowAttach(false)}
        onSelect={handleAttach}
      />

      {/* ── Context Menu Modal ── */}
      <ContextMenu
        visible={showContextMenu}
        message={contextMessage}
        onClose={() => {
          setShowContextMenu(false);
          setContextMessage(null);
        }}
        onAction={handleContextAction}
        isPinned={
          contextMessage ? pinnedMessageIds.has(contextMessage.id) : false
        }
      />

      {/* ── Image Fullscreen Viewer ── */}
      <ImageViewer
        visible={!!viewerImage}
        uri={viewerImage}
        onClose={() => setViewerImage(null)}
      />
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BG_SECONDARY,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
    paddingTop: Platform.OS === 'ios' ? 50 : 10,
  },
  headerBackBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  headerBackIcon: {
    color: TEXT_PRIMARY,
    fontSize: 18,
    fontWeight: '700',
  },
  headerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  headerName: {
    color: TEXT_PRIMARY,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerStatus: {
    fontSize: 12,
    marginTop: 1,
    letterSpacing: 0.2,
  },
  headerEncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ACCENT + '12',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginRight: 6,
  },
  headerLockIcon: {
    fontSize: 10,
    marginRight: 3,
  },
  headerEncText: {
    color: ACCENT,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerCallBtnDisabled: {
    opacity: 0.35,
  },
  headerCallBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  headerCallIcon: {
    fontSize: 16,
  },
  headerVideoIcon: {
    fontSize: 16,
  },

  // ── Keyboard Avoiding ──
  keyboardView: {
    flex: 1,
  },

  // ── Message List ──
  messageListContent: {
    paddingVertical: 8,
    flexGrow: 1,
  },
  loadingOlder: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  loadingOlderText: {
    color: TEXT_MUTED,
    fontSize: 12,
  },

  // ── Empty State ──
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 100,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    color: TEXT_SECONDARY,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyDesc: {
    color: TEXT_MUTED,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 50,
    lineHeight: 20,
  },
  emptyEncBadge: {
    marginTop: 20,
    backgroundColor: ACCENT + '10',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  emptyEncText: {
    color: ACCENT + '80',
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Date Header ──
  dateHeaderWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  dateHeaderLine: {
    flex: 1,
    height: 1,
    backgroundColor: BORDER_COLOR,
  },
  dateHeaderText: {
    color: TEXT_MUTED,
    fontSize: 11,
    fontWeight: '600',
    marginHorizontal: 12,
    letterSpacing: 0.3,
  },

  // ── System Message ──
  systemMsgWrap: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 20,
  },
  systemMsgBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BG_TERTIARY + '80',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
    gap: 8,
  },
  systemMsgText: {
    color: TEXT_MUTED,
    fontSize: 12,
    fontStyle: 'italic',
  },
  systemMsgTime: {
    color: TEXT_MUTED + '80',
    fontSize: 10,
  },

  // ── Message Bubble ──
  msgWrapper: {
    paddingHorizontal: 12,
    marginVertical: 2,
  },
  msgBubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '82%',
    position: 'relative',
  },
  pinnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 3,
  },
  pinnedIcon: {
    fontSize: 10,
  },
  pinnedLabel: {
    color: '#ffaa00',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  replyQuote: {
    flexDirection: 'row',
    marginBottom: 6,
    backgroundColor: BG + 'aa',
    borderRadius: 8,
    padding: 8,
    overflow: 'hidden',
  },
  replyQuoteLine: {
    width: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
    marginRight: 8,
  },
  replyQuoteContent: {
    flex: 1,
  },
  replyQuoteSender: {
    color: ACCENT,
    fontSize: 11,
    fontWeight: '700',
  },
  replyQuoteText: {
    color: TEXT_SECONDARY,
    fontSize: 12,
    marginTop: 1,
  },
  senderLabel: {
    color: ACCENT2,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 3,
    letterSpacing: 0.3,
  },
  msgText: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 5,
  },
  transportBadgeSecure: {
    fontSize: 9,
  },
  transportBadgePlain: {
    color: TEXT_MUTED,
    fontSize: 9,
    fontStyle: 'italic',
  },
  timestampText: {
    color: TEXT_MUTED,
    fontSize: 10,
  },

  // ── Read Receipts ──
  receiptSending: {
    color: TEXT_MUTED,
    fontSize: 12,
  },
  receiptSent: {
    color: TEXT_MUTED,
    fontSize: 12,
    fontWeight: '700',
  },
  receiptDelivered: {
    color: TEXT_MUTED,
    fontSize: 12,
    fontWeight: '700',
  },
  receiptRead: {
    color: '#44aaff',
    fontSize: 12,
    fontWeight: '700',
  },
  receiptFailed: {
    color: DANGER,
    fontSize: 12,
    fontWeight: '800',
  },

  // ── File Card ──
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BG + '80',
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
  },
  fileIconBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileIconEmoji: {
    fontSize: 18,
  },
  fileExtLabel: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginTop: 1,
  },
  fileDetails: {
    flex: 1,
    marginLeft: 10,
  },
  fileNameText: {
    color: TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: '600',
  },
  fileSizeText: {
    color: TEXT_SECONDARY,
    fontSize: 11,
    marginTop: 2,
  },
  fileDownloadBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: ACCENT + '15',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileDownloadIcon: {
    fontSize: 16,
  },

  // ── Image Message ──
  imageMessageContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 6,
  },
  imagePlaceholder: {
    width: 200,
    height: 150,
    backgroundColor: BG_TERTIARY,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageThumb: {
    width: 200,
    height: 150,
    borderRadius: 12,
  },

  // ── Voice Message ──
  voiceMsgWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  voicePlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ACCENT + '20',
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceWaveform: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    height: 24,
    gap: 2,
  },
  voiceBar: {
    width: 3,
    borderRadius: 2,
  },
  voiceDurationText: {
    color: TEXT_MUTED,
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Typing Indicator ──
  typingContainer: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: 'flex-start',
  },
  typingBubble: {
    flexDirection: 'row',
    backgroundColor: BG_TERTIARY,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: TEXT_MUTED,
  },

  // ── Reply Bar ──
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BG_SECONDARY,
    borderTopWidth: 1,
    borderTopColor: BORDER_COLOR,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  replyBarLine: {
    width: 3,
    height: '100%',
    minHeight: 30,
    backgroundColor: ACCENT,
    borderRadius: 2,
    marginRight: 10,
  },
  replyBarContent: {
    flex: 1,
  },
  replyBarLabel: {
    color: ACCENT,
    fontSize: 12,
    fontWeight: '700',
  },
  replyBarText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    marginTop: 1,
  },
  replyBarClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  replyBarCloseIcon: {
    color: TEXT_MUTED,
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Input Bar ──
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: BG_SECONDARY,
    borderTopWidth: 1,
    borderTopColor: BORDER_COLOR,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 4,
  },
  inputActionBtn: {
    width: 38,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inputActionIcon: {
    fontSize: 20,
  },
  inputField: {
    flex: 1,
    backgroundColor: BG_TERTIARY,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    paddingHorizontal: 14,
    justifyContent: 'center',
    minHeight: 40,
    maxHeight: 120,
  },
  textInput: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    paddingVertical: 0,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnIcon: {
    color: BG,
    fontSize: 18,
    fontWeight: '800',
  },

  // ── Voice Record ──
  voiceBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceRecordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    height: 40,
    gap: 8,
  },
  voiceRecordDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: DANGER,
  },
  voiceRecordTime: {
    color: TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  voiceRecordHint: {
    color: TEXT_MUTED,
    fontSize: 12,
    flex: 1,
    textAlign: 'center',
  },
  voiceRecordHandle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: DANGER + '30',
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceRecordIcon: {
    fontSize: 18,
  },

  // ── Emoji Overlay ──
  emojiOverlay: {
    backgroundColor: BG_SECONDARY,
    borderTopWidth: 1,
    borderTopColor: BORDER_COLOR,
    maxHeight: 260,
  },
  emojiOverlayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
  },
  emojiOverlayTitle: {
    color: TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: '700',
  },
  emojiCloseBtn: {
    color: TEXT_MUTED,
    fontSize: 18,
    fontWeight: '700',
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  emojiGridItem: {
    width: '10%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiGridText: {
    fontSize: 24,
  },

  // ── Attach Menu ──
  attachOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  attachMenu: {
    backgroundColor: BG_SECONDARY,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingVertical: 20,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: BORDER_COLOR,
  },
  attachOption: {
    alignItems: 'center',
    gap: 8,
  },
  attachIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: BORDER_COLOR,
  },
  attachIcon: {
    fontSize: 24,
  },
  attachLabel: {
    color: TEXT_SECONDARY,
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Context Menu ──
  contextOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  contextMenu: {
    width: 270,
    backgroundColor: BG_SECONDARY,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    overflow: 'hidden',
  },
  contextPreview: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
    backgroundColor: BG_TERTIARY + '60',
  },
  contextPreviewText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
  },
  contextItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: BORDER_COLOR,
  },
  contextItemIcon: {
    fontSize: 18,
    marginRight: 12,
  },
  contextItemLabel: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: '500',
  },

  // ── Image Viewer ──
  imageViewerBg: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerClose: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 20,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  imageViewerCloseText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  imageViewerImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
});
