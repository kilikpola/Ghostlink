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
  StatusBar,
  ActivityIndicator,
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
import Clipboard from '@react-native-clipboard/clipboard';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useTheme, PALETTE} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import Icon from '../components/Icon';
import WebRTCService from '../services/WebRTCService';
import {CALLS_AVAILABLE, CALLS_UNAVAILABLE_REASON} from '../utils/capabilities';
import {parseInboundChat, parseInboundAck} from '../utils/untrusted';
import PeerAvatar from '../components/PeerAvatar';

// ─── Constants ─────────────────────────────────────────────
const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');

// The shared palette. This screen had its own older one (#00ffa3 neon, a
// purple sender label, #5a5a6a timestamps at 2.6:1), so a conversation
// looked like a different app from the list that opened it.
const ACCENT = PALETTE.accent;
const BG = PALETTE.bg;
const BG_SECONDARY = PALETTE.bgSecondary;
const BG_TERTIARY = PALETTE.bgTertiary;
const TEXT_PRIMARY = PALETTE.text;
const TEXT_SECONDARY = PALETTE.textSecondary;
const TEXT_MUTED = PALETTE.textMuted;
const BORDER_COLOR = PALETTE.border;
const DANGER = PALETTE.danger;
const WARNING = PALETTE.warning;
const ON_ACCENT = PALETTE.onAccent;

const EMOJIS = [
  '😀','😂','😍','🥰','😎','🤔','😤','😭','🥺','😅',
  '🙏','👍','👎','❤️','🔥','✅','⚡','🎉','👀','💀',
  '🤝','🚀','💡','🔒','⚠️','📎','📁','🛡️','🌐','💬',
  '😈','🤖','👻','💎','🌙','✨','🎵','🎮','☕','🍕',
];

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

/**
 * Shape, not just colour, tells the states apart: clock, one tick, two ticks,
 * two accent ticks, and an alert. Each also has a spoken label.
 */
const RECEIPTS = {
  [MESSAGE_STATUS.SENDING]: {icon: 'clock', color: TEXT_MUTED, label: 'Sending'},
  [MESSAGE_STATUS.SENT]: {icon: 'check', color: TEXT_MUTED, label: 'Sent'},
  [MESSAGE_STATUS.DELIVERED]: {icon: 'checkDouble', color: TEXT_MUTED, label: 'Delivered'},
  [MESSAGE_STATUS.READ]: {icon: 'checkDouble', color: ACCENT, label: 'Read'},
  [MESSAGE_STATUS.FAILED]: {icon: 'alert', color: DANGER, label: 'Not sent'},
};

function ReadReceipt({status}) {
  const r = RECEIPTS[status];
  if (!r) return null;
  return <Icon name={r.icon} size={14} color={r.color} strokeWidth={2.2} />;
}

// ─── File Message Card ─────────────────────────────────────

function FileMessageCard({file}) {
  const ext = file.name
    ? file.name.split('.').pop().toLowerCase()
    : 'unknown';
  return (
    <View style={styles.fileCard}>
      <View style={styles.fileIconBox}>
        <Icon name="file" size={20} color={TEXT_SECONDARY} />
        <Text style={styles.fileExtLabel}>{ext.toUpperCase()}</Text>
      </View>
      <View style={styles.fileDetails}>
        <Text style={styles.fileNameText} numberOfLines={1}>
          {file.name || 'Unknown file'}
        </Text>
        <Text style={styles.fileSizeText}>
          {formatFileSize(file.size || 0)}
        </Text>
      </View>
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
      accessibilityRole="imagebutton"
      accessibilityLabel="Image. Opens full screen"
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
      <Text style={styles.dateHeaderText} accessibilityRole="header">
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

  const bubbleBg = isMine ? PALETTE.bubbleMine : BG_TERTIARY;

  const text = message.plainText || message.text || '';
  const receipt = isMine ? RECEIPTS[message.status || 'sent'] : null;
  const a11yLabel = [
    isMine ? 'You' : message.sender || 'Peer',
    isPinned && 'pinned',
    text,
    formatTime(message.timestamp),
    receipt && receipt.label,
    isEndToEnd(message) && 'end-to-end encrypted',
  ]
    .filter(Boolean)
    .join(', ');

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
        accessibilityLabel={a11yLabel}
        accessibilityHint="Long press for reply, copy and pin"
        accessibilityActions={[{name: 'longpress', label: 'Message actions'}]}
        onAccessibilityAction={() => onLongPress && onLongPress(message)}
        style={[
          styles.msgBubble,
          isMine ? styles.msgBubbleMine : styles.msgBubbleTheirs,
          {
            backgroundColor: bubbleBg,
            borderColor: isPinned ? WARNING : 'transparent',
          },
        ]}>
        {isPinned && (
          <View style={styles.pinnedBadge}>
            <Icon name="pin" size={12} color={WARNING} />
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
function isEndToEnd(message) {
  return !!message && message.encrypted === true &&
    (message.transport === 'gmp' || message.transport === 'webrtc-e2e');
}

function TransportBadge({message}) {
  if (!message) return null;

  if (isEndToEnd(message)) {
    return <Icon name="lock" size={12} color={TEXT_MUTED} />;
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
        <TouchableOpacity
          onPress={onClose}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Close emoji">
          <Icon name="close" size={20} color={TEXT_SECONDARY} />
        </TouchableOpacity>
      </View>
      <View style={styles.emojiGrid}>
        {EMOJIS.map((emoji, idx) => (
          <TouchableOpacity
            key={idx}
            style={styles.emojiGridItem}
            accessibilityRole="button"
            accessibilityLabel={`Insert ${emoji}`}
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

// ─── Context Menu ──────────────────────────────────────────

function ContextMenu({visible, message, onClose, onAction, isPinned}) {
  if (!visible || !message) return null;

  // Delete is left out until there is a way to delete: it asked "Remove
  // this message?" and then did nothing on confirm.
  const actions = [
    {key: 'reply', label: 'Reply', icon: 'reply'},
    {key: 'copy', label: 'Copy', icon: 'copy'},
    {key: 'pin', label: isPinned ? 'Unpin' : 'Pin', icon: 'pin'},
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
            style={styles.contextMenu}
            accessibilityViewIsModal>
            <View style={styles.contextPreview}>
              <Text style={styles.contextPreviewText} numberOfLines={2}>
                {message.plainText || message.text || ''}
              </Text>
            </View>
            {actions.map(action => (
              <TouchableOpacity
                key={action.key}
                style={styles.contextItem}
                accessibilityRole="menuitem"
                onPress={() => {
                  Vibration.vibrate(15);
                  onAction(action.key);
                }}>
                <Text style={styles.contextItemLabel}>{action.label}</Text>
                <Icon name={action.icon} size={20} color={TEXT_PRIMARY} />
              </TouchableOpacity>
            ))}
          </Animated.View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── Image Fullscreen Viewer ───────────────────────────────

function ImageViewer({visible, uri, onClose, topInset = 0}) {
  if (!visible || !uri) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <View style={styles.imageViewerBg}>
        <TouchableOpacity
          style={[styles.imageViewerClose, {top: topInset + 8}]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close image">
          <Icon name="close" size={22} color="#FFFFFF" />
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
  const insets = useSafeAreaInsets();
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
  const [replyTo, setReplyTo] = useState(null);
  const [contextMessage, setContextMessage] = useState(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [pinnedMessageIds, setPinnedMessageIds] = useState(new Set());
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
          // This said "Copied" and copied nothing.
          Clipboard.setString(contextMessage.plainText || contextMessage.text || '');
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
      }

      setShowContextMenu(false);
      setContextMessage(null);
    },
    [contextMessage],
  );

  // Every message is already in memory: there is no older page to fetch, so
  // the "Loading older messages" spinner at the top was a 1.2s timer.

  // ── Emoji Select ──

  const handleEmojiSelect = useCallback(emoji => {
    setInputText(prev => prev + emoji);
  }, []);

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

  // Memoised so the list footer does not remount on every keystroke.
  const listFooter = useMemo(
    () => (peerTyping ? <TypingIndicator /> : null),
    [peerTyping],
  );

  const listEmpty = useMemo(
    () => (
      <View style={styles.emptyState}>
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
      <StatusBar barStyle="light-content" backgroundColor={BG_SECONDARY} />

      {/* ── Custom Header ── */}
      <View style={[styles.header, {paddingTop: insets.top + 6}]}>
        <TouchableOpacity
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => navigation.goBack()}>
          <Icon name="back" size={24} color={ACCENT} />
        </TouchableOpacity>

        <PeerAvatar name={peerName} size={36} online={peerOnline} typing={peerTyping} />

        {/*
          One status line, derived from the transport. The badge used to sit
          apart as a pill: "E2EE" said nothing to most people, and "Not
          connected" in the accent colour read as good news. getPeerSecurity()
          reports what the transport can actually do for this peer now.
        */}
        <View
          style={styles.headerInfo}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${peerName}, ${peerStatusText}, ${
            peerSecurity.encrypted ? 'end-to-end encrypted' : 'not encrypted end to end'
          }`}>
          <Text style={styles.headerName} numberOfLines={1}>
            {peerName}
          </Text>
          <View style={styles.headerStatusRow}>
            <Icon
              name={peerSecurity.encrypted ? 'lock' : 'lockOpen'}
              size={12}
              color={peerSecurity.encrypted ? ACCENT : WARNING}
            />
            <Text
              style={[styles.headerStatus, {color: peerSecurity.encrypted ? TEXT_SECONDARY : WARNING}]}
              numberOfLines={1}>
              {peerSecurity.encrypted ? 'End-to-end encrypted' : 'Not encrypted end to end'}
              {' · '}
              {peerStatusText}
            </Text>
          </View>
        </View>

        {/*
          Disabled rather than hidden: the control is part of what the app is
          for, and silently removing it reads as a missing feature rather than
          one that is not ready. Tapping it must not enter the call path — that
          path has no rendezvous and would report a connected call that never
          connected. See utils/capabilities.js.
        */}
        <TouchableOpacity
          style={[styles.iconBtn, !CALLS_AVAILABLE && styles.headerCallBtnDisabled]}
          disabled={!CALLS_AVAILABLE}
          accessibilityRole="button"
          accessibilityState={{disabled: !CALLS_AVAILABLE}}
          accessibilityLabel={CALLS_AVAILABLE ? 'Start voice call' : CALLS_UNAVAILABLE_REASON}
          onPress={() => {
            if (!CALLS_AVAILABLE) return;
            Vibration.vibrate(15);
            navigation.navigate('Call', {peer: peerId, video: false});
          }}>
          <Icon name="phone" size={22} color={ACCENT} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.iconBtn, !CALLS_AVAILABLE && styles.headerCallBtnDisabled]}
          disabled={!CALLS_AVAILABLE}
          accessibilityRole="button"
          accessibilityState={{disabled: !CALLS_AVAILABLE}}
          accessibilityLabel={CALLS_AVAILABLE ? 'Start video call' : CALLS_UNAVAILABLE_REASON}
          onPress={() => {
            if (!CALLS_AVAILABLE) return;
            Vibration.vibrate(15);
            navigation.navigate('Call', {peer: peerId, video: true});
          }}>
          <Icon name="video" size={24} color={ACCENT} />
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
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={11}
          // Android only; it has caused blank cells on iOS.
          removeClippedSubviews={Platform.OS === 'android'}
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
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Cancel reply">
              <Icon name="close" size={18} color={TEXT_SECONDARY} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ── Input Bar ──
            The attach button opened a menu whose every option said "picker
            would open here", and the microphone recorded nothing yet added a
            "Voice message" bubble marked sent. Both are gone until they work;
            send is always present, and dimmed while there is nothing to send. */}
        <View style={[styles.inputBar, {paddingBottom: showEmoji ? 8 : Math.max(8, insets.bottom)}]}>
          <TouchableOpacity
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={showEmoji ? 'Show keyboard' : 'Show emoji'}
            onPress={() => {
              Vibration.vibrate(10);
              setShowEmoji(e => !e);
            }}>
            <Icon name={showEmoji ? 'keyboard' : 'smile'} size={24} color={TEXT_SECONDARY} />
          </TouchableOpacity>

          <View style={[styles.inputField, {minHeight: Math.max(40, inputHeight)}]}>
            <TextInput
              ref={inputRef}
              style={styles.textInput}
              placeholder="Message"
              placeholderTextColor={TEXT_MUTED}
              accessibilityLabel={`Message ${peerName}`}
              value={inputText}
              onChangeText={setInputText}
              onContentSizeChange={handleContentSizeChange}
              multiline
              maxLength={4096}
              textAlignVertical="center"
            />
          </View>

          <TouchableOpacity
            style={[styles.sendBtn, !inputText.trim() && styles.sendBtnIdle]}
            onPress={handleSend}
            disabled={!inputText.trim()}
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{disabled: !inputText.trim()}}>
            <Icon name="send" size={20} color={inputText.trim() ? ON_ACCENT : TEXT_MUTED} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>

        {/* ── Emoji Overlay ── */}
        <EmojiOverlay
          visible={showEmoji}
          onSelect={handleEmojiSelect}
          onClose={() => setShowEmoji(false)}
        />
      </KeyboardAvoidingView>

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
        topInset={insets.top}
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
    paddingHorizontal: 4,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_COLOR,
  },
  iconBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  headerName: {
    color: TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: '600',
  },
  headerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  headerStatus: {
    fontSize: 12,
    flexShrink: 1,
  },
  headerCallBtnDisabled: {
    opacity: 0.35,
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
  // ── Empty State ──
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 100,
  },
  emptyTitle: {
    color: TEXT_SECONDARY,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyDesc: {
    color: TEXT_SECONDARY,
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 50,
    lineHeight: 20,
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
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 12,
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
    color: TEXT_SECONDARY,
    fontSize: 12,
    fontStyle: 'italic',
  },
  systemMsgTime: {
    color: TEXT_MUTED,
    fontSize: 11,
  },

  // ── Message Bubble ──
  msgWrapper: {
    paddingHorizontal: 12,
    marginVertical: 2,
  },
  msgBubble: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxWidth: '82%',
    position: 'relative',
  },
  // A tighter corner on the sender's side says whose it is without colour.
  msgBubbleMine: {
    borderBottomRightRadius: 6,
  },
  msgBubbleTheirs: {
    borderBottomLeftRadius: 6,
  },
  pinnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 3,
  },
  pinnedLabel: {
    color: WARNING,
    fontSize: 12,
    fontWeight: '600',
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
    fontSize: 12,
    fontWeight: '700',
  },
  replyQuoteText: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    marginTop: 1,
  },
  senderLabel: {
    color: TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  msgText: {
    color: TEXT_PRIMARY,
    fontSize: 16,
    lineHeight: 22,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 5,
  },
  transportBadgePlain: {
    color: TEXT_MUTED,
    fontSize: 11,
    fontStyle: 'italic',
  },
  timestampText: {
    color: TEXT_MUTED,
    fontSize: 11,
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
    backgroundColor: BG_TERTIARY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileExtLabel: {
    color: TEXT_SECONDARY,
    fontSize: 11,
    fontWeight: '700',
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
    fontSize: 12,
    marginTop: 2,
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
  // ── Input Bar ──
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: BG_SECONDARY,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_COLOR,
    paddingHorizontal: 4,
    paddingTop: 8,
    gap: 4,
  },
  inputField: {
    flex: 1,
    backgroundColor: BG_TERTIARY,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    paddingHorizontal: 14,
    paddingVertical: 8,
    justifyContent: 'center',
    maxHeight: 140,
    marginBottom: 2,
  },
  textInput: {
    color: TEXT_PRIMARY,
    fontSize: 16,
    paddingVertical: 0,
    maxHeight: 120,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
    margin: 2,
  },
  sendBtnIdle: {
    backgroundColor: BG_TERTIARY,
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
    paddingLeft: 16,
    paddingRight: 4,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
  },
  emojiOverlayTitle: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: '600',
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

  // ── Context Menu ──
  contextOverlay: {
    flex: 1,
    backgroundColor: PALETTE.scrim,
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_COLOR,
  },
  contextItemLabel: {
    color: TEXT_PRIMARY,
    fontSize: 16,
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
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  imageViewerImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
});
