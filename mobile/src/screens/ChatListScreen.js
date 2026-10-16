import React, {useState, useCallback, useMemo, useRef} from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  Alert,
  Vibration,
  StatusBar,
  Platform,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from '../components/ScaledText';
import Animated, {
  FadeInDown,
  SlideInDown,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  interpolate,
} from 'react-native-reanimated';
import {Gesture, GestureDetector, GestureHandlerRootView} from 'react-native-gesture-handler';
import {useTheme} from '../context/ThemeContext';
import Icon from '../components/Icon';
import PeerAvatar from '../components/PeerAvatar';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';
import Clipboard from '@react-native-clipboard/clipboard';
import {normalizeGhostAddress} from '../utils/ghost-address';

const SWIPE_THRESHOLD = 80;
const SWIPE_WIDTH = 216;
/** Row height at the default text size; scaled with the user's setting. */
const CHAT_ITEM_BASE_HEIGHT = 76;

function formatTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const diff = now - date;
  const oneDay = 86400000;

  if (diff < oneDay && date.getDate() === now.getDate()) {
    const h = date.getHours();
    const m = date.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m} ${ampm}`;
  }
  if (diff < 2 * oneDay) return 'Yesterday';
  if (diff < 7 * oneDay) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ==================== SWIPEABLE CHAT ITEM ====================
/**
 * One row, memoised. The comparator checks `item` field by field because chat
 * objects are rebuilt from state on every pass.
 */
function ChatItemImpl({item, theme, rowHeight, onPress, onPin, onMute, onDelete}) {
  const translateX = useSharedValue(0);
  const isSwipeOpen = useRef(false);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onUpdate(e => {
      // Only allow left swipe (negative direction) to reveal actions
      if (e.translationX < 0) {
        translateX.value = Math.max(e.translationX, -SWIPE_WIDTH);
      } else if (isSwipeOpen.current) {
        translateX.value = Math.min(-SWIPE_WIDTH + e.translationX, 0);
      }
    })
    .onEnd(e => {
      if (translateX.value < -SWIPE_THRESHOLD) {
        translateX.value = withSpring(-SWIPE_WIDTH, {damping: 20, stiffness: 200});
        isSwipeOpen.current = true;
      } else {
        translateX.value = withSpring(0, {damping: 20, stiffness: 200});
        isSwipeOpen.current = false;
      }
    });

  const animatedRowStyle = useAnimatedStyle(() => ({
    transform: [{translateX: translateX.value}],
  }));

  const animatedActionsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [0, -100], [0, 1]),
  }));

  const closeSwipe = useCallback(() => {
    translateX.value = withSpring(0, {damping: 20, stiffness: 200});
    isSwipeOpen.current = false;
  }, [translateX]);

  const handlePin = useCallback(() => {
    closeSwipe();
    onPin(item.id);
  }, [item.id, onPin, closeSwipe]);

  const handleMute = useCallback(() => {
    closeSwipe();
    onMute(item.id);
  }, [item.id, onMute, closeSwipe]);

  const handleDelete = useCallback(() => {
    closeSwipe();
    onDelete(item.id, item.name);
  }, [item.id, item.name, onDelete, closeSwipe]);

  // The swipe is a shortcut; screen-reader and switch users get the same
  // three actions from the row itself.
  const accessibilityActions = [
    {name: 'pin', label: item.pinned ? 'Unpin' : 'Pin'},
    {name: 'mute', label: item.muted ? 'Unmute' : 'Mute'},
    {name: 'delete', label: 'Delete conversation'},
  ];
  const onAccessibilityAction = e => {
    if (e.nativeEvent.actionName === 'pin') handlePin();
    if (e.nativeEvent.actionName === 'mute') handleMute();
    if (e.nativeEvent.actionName === 'delete') handleDelete();
  };

  const rowLabel = [
    item.name,
    item.pinned && 'pinned',
    item.muted && 'muted',
    item.unread > 0 && `${item.unread} unread`,
    item.lastMessage || 'No messages yet',
    formatTimestamp(item.lastMessageTime),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={[styles.chatItemContainer, {height: rowHeight}]}>
      {/* Swipe actions behind the row. Neutral for the reversible two, red
          only for the destructive one, so colour means one thing. */}
      <Animated.View
        style={[styles.swipeActions, animatedActionsStyle]}
        importantForAccessibility="no-hide-descendants">
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: theme.bgTertiary}]}
          onPress={handlePin}
          activeOpacity={0.7}>
          <Icon name="pin" size={20} color={theme.text} />
          <Text style={[styles.swipeActionLabel, {color: theme.text}]}>
            {item.pinned ? 'Unpin' : 'Pin'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: theme.border}]}
          onPress={handleMute}
          activeOpacity={0.7}>
          <Icon name={item.muted ? 'bell' : 'bellOff'} size={20} color={theme.text} />
          <Text style={[styles.swipeActionLabel, {color: theme.text}]}>
            {item.muted ? 'Unmute' : 'Mute'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: theme.danger}]}
          onPress={handleDelete}
          activeOpacity={0.7}>
          <Icon name="trash" size={20} color={theme.onAccent} />
          <Text style={[styles.swipeActionLabel, {color: theme.onAccent}]}>Delete</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Main chat row */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[{height: rowHeight}, animatedRowStyle]}>
          <TouchableOpacity
            style={[styles.chatItem, {height: rowHeight, backgroundColor: theme.bg}]}
            onPress={() => onPress(item)}
            accessibilityRole="button"
            accessibilityLabel={rowLabel}
            accessibilityHint="Opens the conversation"
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            activeOpacity={0.7}>
            <PeerAvatar name={item.name} size={48} online={item.online} />

            {/* Content */}
            <View style={styles.chatContent}>
              <View style={styles.chatTopRow}>
                <View style={styles.chatNameRow}>
                  {item.pinned && (
                    <Icon name="pin" size={14} color={theme.textMuted} style={styles.rowGlyph} />
                  )}
                  <Text
                    style={[styles.chatName, {color: theme.text}]}
                    numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.muted && (
                    <Icon name="bellOff" size={14} color={theme.textMuted} style={styles.rowGlyphAfter} />
                  )}
                </View>
                <Text style={[styles.chatTime, {color: item.unread > 0 ? theme.accent : theme.textMuted}]}>
                  {formatTimestamp(item.lastMessageTime)}
                </Text>
              </View>
              <View style={styles.chatBottomRow}>
                <Text
                  style={[
                    styles.chatPreview,
                    {color: item.unread > 0 ? theme.text : theme.textSecondary},
                    item.unread > 0 && {fontWeight: '600'},
                  ]}
                  numberOfLines={1}>
                  {item.lastMessage || 'No messages yet'}
                </Text>
                {item.unread > 0 && (
                  <View style={[styles.unreadBadge, {backgroundColor: item.muted ? theme.textMuted : theme.accent}]}>
                    <Text style={[styles.unreadText, {color: theme.onAccent}]}>
                      {item.unread > 99 ? '99+' : item.unread}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const ChatItem = React.memo(ChatItemImpl, (prev, next) => {
  const a = prev.item;
  const b = next.item;
  return (
    prev.theme === next.theme &&
    prev.rowHeight === next.rowHeight &&
    prev.onPress === next.onPress &&
    prev.onPin === next.onPin &&
    prev.onMute === next.onMute &&
    prev.onDelete === next.onDelete &&
    // Exactly the fields the row renders. Anything added to the row must be
    // added here too, or it will not repaint when it changes.
    a.id === b.id &&
    a.name === b.name &&
    a.lastMessage === b.lastMessage &&
    a.lastMessageTime === b.lastMessageTime &&
    a.unread === b.unread &&
    a.pinned === b.pinned &&
    a.muted === b.muted &&
    a.online === b.online
  );
});

// ==================== MAIN CHAT LIST SCREEN ====================
export default function ChatListScreen({navigation}) {
  const {theme, scale} = useTheme();
  const insets = useSafeAreaInsets();
  const {state, dispatch, identity, legacyRecovery} = useApp();
  const [searchQuery, setSearchQuery] = useState('');
  const [addPeerModalVisible, setAddPeerModalVisible] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [addressCopied, setAddressCopied] = useState(false);
  // Rows grow with the text size; a fixed 76pt row clipped two lines of
  // Extra large text under overflow:hidden.
  const rowHeight = Math.max(CHAT_ITEM_BASE_HEIGHT, scale(CHAT_ITEM_BASE_HEIGHT));

  // FAB animation
  const fabScale = useSharedValue(1);
  const fabStyle = useAnimatedStyle(() => ({
    transform: [{scale: fabScale.value}],
  }));

  // Build chat list from peers + messages
  const chatList = useMemo(() => {
    // state.peers and state.messages are Maps (see AppContext's reducer),
    // not arrays. Calling .map() on a Map is what threw "undefined is not a
    // function" and took the whole screen down on first render.
    const peers = Array.from(state.peers?.values?.() ?? []);
    return peers
      .map(peer => {
        const roomId = peer.roomId || peer.id;
        // ChatScreen files a conversation under the peer's id; `roomId` is a
        // separate value set when the peer is added and never written to, so
        // looking only there showed every conversation as "No messages yet".
        const msgs =
          state.messages?.get?.(peer.id) ?? state.messages?.get?.(roomId) ?? [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        const unread = msgs.filter(
          m =>
            !m.read &&
            m.status !== 'read' &&
            (typeof m.outgoing === 'boolean' ? !m.outgoing : m.sender !== identity?.name),
        ).length;

        return {
          id: peer.id,
          name: peer.name || peer.displayName || 'Unknown',
          lastMessage: lastMsg ? lastMsg.plainText || '[Encrypted]' : '',
          lastMessageTime: lastMsg ? lastMsg.timestamp : peer.addedAt || 0,
          unread,
          online: peer.online || false,
          pinned: peer.pinned || false,
          muted: peer.muted || false,
          roomId,
        };
      })
      .sort((a, b) => {
        // Pinned first, then by last message time
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
      });
  }, [state.peers, state.messages, identity]);

  // Filtered list based on search
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chatList;
    const q = searchQuery.toLowerCase().trim();
    return chatList.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        (c.lastMessage && c.lastMessage.toLowerCase().includes(q)),
    );
  }, [chatList, searchQuery]);

  // Chat item press
  const handleChatPress = useCallback(
    item => {
      // The Chat screen reads the peer from its route params; there is no
      // activePeer in state and nothing ever read one, so dispatching
      // SET_ACTIVE_PEER (which the reducer does not handle) did nothing.
      navigation.navigate('Chat', {peerId: item.id, peerName: item.name, roomId: item.roomId});
    },
    [navigation],
  );

  // Swipe actions
  const handlePin = useCallback(
    peerId => {
      Vibration.vibrate(15);
      const peer = state.peers?.get?.(peerId);
      if (peer) {
        dispatch({
          type: 'UPDATE_PEER',
          payload: {id: peerId, pinned: !peer.pinned},
        });
      }
    },
    [state.peers, dispatch],
  );

  const handleMute = useCallback(
    peerId => {
      Vibration.vibrate(15);
      const peer = state.peers?.get?.(peerId);
      if (peer) {
        dispatch({
          type: 'UPDATE_PEER',
          payload: {id: peerId, muted: !peer.muted},
        });
      }
    },
    [state.peers, dispatch],
  );

  const handleDelete = useCallback(
    (peerId, peerName) => {
      Alert.alert(
        'Delete Conversation',
        `Remove ${peerName} and all messages? This cannot be undone.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              Vibration.vibrate(20);
              dispatch({type: 'REMOVE_PEER', payload: peerId});
            },
          },
        ],
      );
    },
    [dispatch],
  );

  const handleCopyAddress = useCallback(() => {
    if (!identity?.ghostAddress) return;
    Clipboard.setString(identity.ghostAddress);
    Vibration.vibrate(15);
    // Confirmed in place, not with a dialog that has to be dismissed.
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 2000);
  }, [identity]);

  // Add peer via Ghost Address or invite code
  const handleAddPeer = useCallback(async () => {
    const raw = inviteCodeInput.trim();
    if (!raw) {
      Alert.alert('Nothing entered', 'Enter a Ghost Address or invite code to add a peer.');
      return;
    }

    // A Ghost Address is the normal way to reach someone; the older GL- invite
    // code still works. normalizeGhostAddress tolerates lower case, missing
    // dashes and the characters people mistype (O for 0, I for 1).
    const ghost = normalizeGhostAddress(raw);
    const code = ghost || raw.toUpperCase();

    if (!ghost && (!code.startsWith('GL-') || code.length < 35)) {
      Alert.alert(
        'Not recognised',
        'Enter a Ghost Address like GHOST-7K2-M4Q-8ZB, or a GL- invite code.',
      );
      return;
    }

    if (ghost && identity?.ghostAddress && ghost === identity.ghostAddress) {
      Alert.alert('That is your own address', 'Share it with someone else so they can add you.');
      return;
    }

    Vibration.vibrate(20);

    const peerId = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fingerprint = await CryptoEngine.sha256(code);

    dispatch({
      type: 'ADD_PEER',
      payload: {
        id: peerId,
        name: ghost || `Peer ${(state.peers?.size ?? 0) + 1}`,
        ghostAddress: ghost || '',
        inviteCode: ghost ? '' : code,
        fingerprint: fingerprint.slice(0, 16),
        online: false,
        pinned: false,
        muted: false,
        roomId: `room-${peerId}`,
        addedAt: Date.now(),
      },
    });

    setInviteCodeInput('');
    setAddPeerModalVisible(false);
  }, [inviteCodeInput, dispatch, state.peers, identity]);

  // Open QR scanner
  const handleScanQR = useCallback(() => {
    setAddPeerModalVisible(false);
    // Navigate to QR scanner screen if available
    if (navigation.navigate) {
      try {
        navigation.navigate('QRScanner');
      } catch (_e) {
        Alert.alert('QR Scanner', 'QR scanning will be available in a future update.');
      }
    }
  }, [navigation]);

  // FAB press
  const handleFABPress = useCallback(() => {
    fabScale.value = withSequence(
      withSpring(0.85, {damping: 8}),
      withSpring(1, {damping: 8}),
    );
    Vibration.vibrate(15);
    setAddPeerModalVisible(true);
  }, [fabScale]);

  // Settings press
  const handleSettingsPress = useCallback(() => {
    Vibration.vibrate(10);
    navigation.navigate('Settings');
  }, [navigation]);

  // FlatList key extractor
  const keyExtractor = useCallback(item => item.id, []);

  // FlatList getItemLayout for fixed-height rows
  const getItemLayout = useCallback(
    (_data, index) => ({
      length: rowHeight,
      offset: rowHeight * index,
      index,
    }),
    [rowHeight],
  );

  // Render chat item
  const renderItem = useCallback(
    ({item}) => (
      <ChatItem
        item={item}
        theme={theme}
        rowHeight={rowHeight}
        onPress={handleChatPress}
        onPin={handlePin}
        onMute={handleMute}
        onDelete={handleDelete}
      />
    ),
    [theme, rowHeight, handleChatPress, handlePin, handleMute, handleDelete],
  );

  // ==================== RENDER ====================
  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <View style={[styles.container, {backgroundColor: theme.bg}]}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

        {/* ===== HEADER =====
            There was a green "Connected" line here, driven by local state
            that started at 'connected' and that nothing ever changed. There
            is no app-wide connection to report; each conversation shows its
            own transport in its header instead. */}
        <View style={[styles.header, {paddingTop: insets.top + 8, borderBottomColor: theme.border}]}>
          <Text style={[styles.headerTitle, {color: theme.text}]} accessibilityRole="header">
            Chats
          </Text>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={handleSettingsPress}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            activeOpacity={0.6}>
            <Icon name="settings" size={24} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* ===== OLDER RECOVERY DATA WAITING ON THE PHRASE ===== */}
        {legacyRecovery?.state === 'needs-phrase' && (
          <TouchableOpacity
            style={{margin: 12, padding: 12, borderRadius: 10, borderWidth: 1, backgroundColor: theme.warning + '18', borderColor: theme.warning + '60'}}
            onPress={() => navigation.navigate('Recovery')}
            accessibilityRole="button"
            activeOpacity={0.7}>
            <Text style={{color: theme.warning, fontWeight: '600', marginBottom: 4}}>Record your recovery phrase</Text>
            <Text style={{color: theme.textSecondary}}>
              This update keeps older recovery data on this phone until you confirm your 12-word phrase. Tap to confirm it.
            </Text>
          </TouchableOpacity>
        )}

        {/* ===== SEARCH BAR ===== */}
        <View style={[styles.searchContainer, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Icon name="search" size={18} color={theme.textMuted} style={styles.searchIcon} />
          <TextInput
            style={[styles.searchInput, {color: theme.text}]}
            placeholder="Search"
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="Search conversations"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={styles.clearBtn}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              activeOpacity={0.6}>
              <Icon name="close" size={16} color={theme.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* ===== CHAT LIST ===== */}
        {filteredChats.length > 0 ? (
          <FlatList
            data={filteredChats}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemLayout={getItemLayout}
            style={styles.chatList}
            contentContainerStyle={styles.chatListContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            windowSize={11}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        ) : (
          /* ===== EMPTY STATE =====
              A search with no hits is not "no conversations". */
          searchQuery.trim() && chatList.length > 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, {color: theme.textSecondary}]}>
                No results for “{searchQuery.trim()}”
              </Text>
            </View>
          ) : (
          <View style={styles.emptyContainer}>
            <Animated.View entering={FadeInDown.duration(500)} style={styles.emptyContent}>
              <Text style={[styles.emptyTitle, {color: theme.text}]} accessibilityRole="header">
                No conversations yet
              </Text>
              <Text style={[styles.emptyDesc, {color: theme.textSecondary}]}>
                Add a peer with their Ghost Address, or share yours so they can add you.
              </Text>

              {/* Your Ghost Address. This replaced `state.inviteCode`, which was
                  never set by anything — the reducer has no such field — so this
                  box never rendered and the app appeared to have no address of
                  its own at all. */}
              {identity?.ghostAddress ? (
                <TouchableOpacity
                  onPress={handleCopyAddress}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Your Ghost Address, ${identity.ghostAddress}`}
                  accessibilityHint="Copies it so you can share it"
                  style={[styles.myCodeBox, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.myCodeLabel, {color: theme.textSecondary}]}>
                    Your Ghost Address
                  </Text>
                  <Text style={[styles.myCodeValue, {color: theme.accent}]} selectable>
                    {identity.ghostAddress}
                  </Text>
                  <View style={styles.myCodeHintRow}>
                    <Icon
                      name={addressCopied ? 'check' : 'copy'}
                      size={14}
                      color={addressCopied ? theme.accent : theme.textMuted}
                    />
                    <Text style={[styles.myCodeHint, {color: addressCopied ? theme.accent : theme.textMuted}]}>
                      {addressCopied ? 'Copied' : 'Tap to copy'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={[styles.emptyAction, {backgroundColor: theme.accent}]}
                onPress={handleFABPress}
                accessibilityRole="button"
                activeOpacity={0.8}>
                <Icon name="plus" size={18} color={theme.onAccent} />
                <Text style={[styles.emptyActionText, {color: theme.onAccent}]}>Add Peer</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
          )
        )}

        {/* ===== FAB (Add Peer) ===== */}
        {/* Only once there is a list: the empty state has its own labelled
            button, and two ways to do one thing on an empty screen is one too many. */}
        {chatList.length > 0 && (
          <Animated.View style={[styles.fabContainer, {bottom: insets.bottom + 20}, fabStyle]}>
            <TouchableOpacity
              style={[styles.fab, {backgroundColor: theme.accent}]}
              onPress={handleFABPress}
              accessibilityRole="button"
              accessibilityLabel="Add peer"
              activeOpacity={0.8}>
              <Icon name="plus" size={26} color={theme.onAccent} strokeWidth={2.5} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ===== ADD PEER MODAL ===== */}
        <Modal
          visible={addPeerModalVisible}
          animationType="none"
          transparent
          onRequestClose={() => setAddPeerModalVisible(false)}>
          <TouchableOpacity
            style={[styles.modalOverlay, {backgroundColor: theme.scrim}]}
            accessible={false}
            activeOpacity={1}
            onPress={() => setAddPeerModalVisible(false)}>
            <Animated.View entering={SlideInDown.springify().damping(18)} exiting={SlideOutDown.duration(200)}>
              <TouchableOpacity activeOpacity={1} onPress={() => {}}>
                <View
                  style={[
                    styles.modalContent,
                    {
                      backgroundColor: theme.bgSecondary,
                      borderColor: theme.border,
                      paddingBottom: insets.bottom + 20,
                    },
                  ]}
                  accessibilityViewIsModal>
                  <View style={styles.modalHandle}>
                    <View style={[styles.modalHandleBar, {backgroundColor: theme.textMuted}]} />
                  </View>

                  <Text style={[styles.modalTitle, {color: theme.text}]} accessibilityRole="header">
                    Add Peer
                  </Text>
                  <Text style={[styles.modalDesc, {color: theme.textSecondary}]}>
                    Enter a peer's Ghost Address — the short GHOST- name they share with you.
                  </Text>

                  {/* Invite code input */}
                  <View
                    style={[
                      styles.modalInputWrap,
                      {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                    ]}>
                    <TextInput
                      style={[styles.modalInput, {color: theme.text}]}
                      placeholder="GHOST-XXX-XXX-XXX"
                      placeholderTextColor={theme.textMuted}
                      accessibilityLabel="Ghost Address or invite code"
                      value={inviteCodeInput}
                      onChangeText={setInviteCodeInput}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleAddPeer}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.modalPrimaryBtn, {backgroundColor: theme.accent}]}
                    onPress={handleAddPeer}
                    accessibilityRole="button"
                    activeOpacity={0.7}>
                    <Text style={[styles.modalPrimaryBtnText, {color: theme.onAccent}]}>
                      Add Peer
                    </Text>
                  </TouchableOpacity>

                  {/* Divider */}
                  <View style={styles.modalDivider}>
                    <View style={[styles.modalDividerLine, {backgroundColor: theme.border}]} />
                    <Text style={[styles.modalDividerText, {color: theme.textMuted}]}>
                      or
                    </Text>
                    <View style={[styles.modalDividerLine, {backgroundColor: theme.border}]} />
                  </View>

                  {/* QR Scan button */}
                  <TouchableOpacity
                    style={[styles.modalQRBtn, {borderColor: theme.accent}]}
                    onPress={handleScanQR}
                    accessibilityRole="button"
                    activeOpacity={0.7}>
                    <Icon name="qr" size={20} color={theme.accent} style={styles.modalQRIcon} />
                    <Text style={[styles.modalQRText, {color: theme.accent}]}>
                      Scan QR Code
                    </Text>
                  </TouchableOpacity>

                  {/* Cancel */}
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => {
                      setInviteCodeInput('');
                      setAddPeerModalVisible(false);
                    }}
                    accessibilityRole="button"
                    activeOpacity={0.6}>
                    <Text style={[styles.modalCancelText, {color: theme.textSecondary}]}>
                      Cancel
                    </Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </Animated.View>
          </TouchableOpacity>
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: 20,
    paddingRight: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 30,
    fontWeight: '700',
  },
  headerBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingLeft: 12,
    minHeight: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 10,
  },
  clearBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Chat list
  chatList: {
    flex: 1,
  },
  chatListContent: {
    paddingBottom: 100,
  },

  // Chat item
  chatItemContainer: {
    overflow: 'hidden',
  },
  swipeActions: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: SWIPE_WIDTH,
    flexDirection: 'row',
  },
  swipeAction: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  swipeActionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },

  // Chat content
  chatContent: {
    flex: 1,
  },
  chatTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  chatNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  rowGlyph: {
    marginRight: 4,
  },
  rowGlyphAfter: {
    marginLeft: 6,
  },
  chatName: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  chatTime: {
    fontSize: 13,
  },
  chatBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chatPreview: {
    fontSize: 15,
    flex: 1,
    marginRight: 8,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyContent: {
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyDesc: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 24,
  },
  myCodeBox: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    width: '100%',
  },
  myCodeLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  myCodeValue: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  myCodeHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  myCodeHint: {
    fontSize: 13,
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 50,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 20,
    alignSelf: 'stretch',
  },
  emptyActionText: {
    fontSize: 16,
    fontWeight: '600',
  },

  // FAB
  fabContainer: {
    position: 'absolute',
    right: 20,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 24,
  },
  modalHandle: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 16,
  },
  modalHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 20,
  },
  modalInputWrap: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  modalInput: {
    fontSize: 16,
    paddingVertical: 13,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalPrimaryBtn: {
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 16,
  },
  modalPrimaryBtnText: {
    fontSize: 16,
    fontWeight: '600',
  },
  modalDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalDividerLine: {
    flex: 1,
    height: 1,
  },
  modalDividerText: {
    fontSize: 12,
    fontWeight: '500',
    marginHorizontal: 12,
  },
  modalQRBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  modalQRIcon: {
    marginRight: 8,
  },
  modalQRText: {
    fontSize: 15,
    fontWeight: '600',
  },
  modalCancelBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  modalCancelText: {
    fontSize: 16,
  },
});
