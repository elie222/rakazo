import type { MenuAction } from "@expo/ui/community/menu";
import { ChatMarkdown, markdownCodeBlocks } from "@rakazo/chat-ui/native";
import type {
  AgentSkillCatalogEntry,
  Connection,
  ConnectionCatalogItem,
  MessageBlock,
  MessageReaction,
  Routine,
} from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_COUNT,
  attachmentMaxBytes,
  canReactToThreadMessage,
  isAttachmentAudioMimeType,
  MESSAGE_REACTIONS,
} from "@rakazo/contracts";
import type { ReadBoundary, SlashActionId, ThreadItem } from "@rakazo/core";
import {
  abortableDelay,
  answerableAskMessageIds,
  appendNewerThreadPage,
  attachmentsForThread,
  buildComposerMentionOptions,
  canMarkMessageUnread,
  chatUserBubbleColors,
  cloudAgentHttpsUrl,
  createChatQueues,
  dismissableAskMessageIds,
  expandPeerReplies,
  foldPeerReplies,
  formatFileSize,
  forwardProbeAfterPage,
  groupVoiceChats,
  isApprovalAskBlock,
  isPeerReceiptBlocks,
  isRetryableError,
  isRunTerminalEvent,
  isRunWaitingOnUser,
  isRunWorking,
  isSecretAskBlock,
  jumpTargetId,
  leaveThreadWindow,
  liveActivityLine,
  liveMessageComposing,
  openThreadWindow,
  plainTextFromMarkdown,
  projectMessageReactions,
  reconcileThreadScrollState,
  replyAttachment,
  resolveComposerSendPlan,
  resolvePersonaColorDef,
  retryDelayMs,
  displayName as safeDisplayName,
  selectedAskActionLabel,
  settleReadBoundary,
  shouldShowBotSenderName,
  threadWindowMessages,
  timeSeparatorIds,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
  withLiveStreamingProgress,
} from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import {
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { ComponentProps } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  GestureResponderEvent,
  LayoutChangeEvent,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  TextProps,
} from "react-native";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
  useKeyboardHandler,
} from "react-native-keyboard-controller";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppConnectCard } from "../components/AppConnectCard";
import { AskActions } from "../components/AskActions";
import { ActivityMark } from "../components/activity-mark";
import { AudioAttachment } from "../components/audio-attachment";
import { BotAvatar } from "../components/bot-avatar";
import { ChoiceCard } from "../components/ChoiceCard";
import { ComputerCard } from "../components/ComputerCard";
import { ComposerReplyPreview } from "../components/composer-reply-preview";
import { FailedSendBubble } from "../components/failed-send-bubble";
import { GlassSurface } from "../components/glass-surface";
import type { ImageArtifactPreviewTarget } from "../components/image-artifact-viewer";
import { InlineImageAttachment } from "../components/inline-image-attachment";
import { InstructionUndo } from "../components/instruction-undo";
import { McpApprovalCard } from "../components/McpApprovalCard";
import type { MarkdownArtifactPreviewTarget } from "../components/markdown-artifact-preview";
import { MarkdownArtifactPreview } from "../components/markdown-artifact-preview";
import { presentMessageMenu } from "../components/message-action-menu";
import { MessageCaption } from "../components/message-caption";
import { MessageContextMenu } from "../components/message-context-menu";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { ReplyDismissButton } from "../components/reply-dismiss-button";
import { ReplyLine } from "../components/reply-line";
import { RunErrorSheet, useRunError } from "../components/run-error-sheet";
import { ScrollToBottomButton } from "../components/scroll-to-bottom-button";
import { SecretAskSheet } from "../components/secret-ask-sheet";
import { SelectTextSheet } from "../components/select-text-sheet";
import { trailingHeaderOptions } from "../components/sheet-header";
import type { ThreadComposerHandle } from "../components/thread-composer";
import { ThreadComposer } from "../components/thread-composer";
import { ThreadErrorNotice } from "../components/thread-error-notice";
import { createThreadHeaderStyles } from "../components/thread-header-styles";
import { ThreadScrollSurface } from "../components/thread-scroll-surface";
import { TimeSeparator } from "../components/time-separator";
import { UnreadDivider } from "../components/unread-divider";
import { VoiceChatCard } from "../components/VoiceChatCard";
import { readableGutters } from "../lib/adaptive-layout";
import type {
  MobileBot,
  MobileGroup,
  MobileMe,
  MobileMessage,
  MobileMessagePage,
  MobileSnapshot,
} from "../lib/api";
import {
  applyMobileThreadEvent,
  blockText,
  copyableMobileMessageText,
  currentApiBase,
  loadSessionToken,
  mergeMobileSnapshot,
  messagingProviderLabel,
  mobileThreadRefreshResult,
  prependMobileMessagePage,
  rpc,
  selectableMobileMessageText,
  selectedSpaceId,
  selectSpace,
  subscribeThread,
} from "../lib/api";
import { useAppForeground } from "../lib/app-foreground";
import { mobileTokens } from "../lib/appearance";
import { notifyArchivedChatsChanged } from "../lib/archived-chats";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { openMobileArtifact } from "../lib/artifact-open";
import { plainAskTitle } from "../lib/ask-title";
import { nextAutoSpeakAction } from "../lib/auto-speak";
import { confirmDeleteBot, restoreArchivedBot } from "../lib/bot-lifecycle";
import { retainUnchangedBotRoster } from "../lib/bot-roster";
import { findSwitchTarget, ringOnArrival, takeRingOnArrival } from "../lib/bot-switch";
import { setCallProviderTranscribe, startCall, useCallSession } from "../lib/call-session";
import { chatSettingsRoute } from "../lib/chat-settings-route";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { available as dictationAvailable } from "../lib/dictation";
import { canDoubleTapReact } from "../lib/double-tap";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { helperHeaderOffset, helperOpenTarget } from "../lib/helper-header-offset";
import { t, useI18n } from "../lib/i18n";
import {
  isIncomingShareCurrent,
  retryIncomingShare,
  takeIncomingShare,
} from "../lib/incoming-share";
import { isInlineImageMimeType } from "../lib/inline-image";
import { integrationsCacheScope, isIntegrationsScopeCurrent } from "../lib/integrations-cache";
import { useKeyboardLayout } from "../lib/keyboard-layout";
import { KeyboardScrollBack } from "../lib/keyboard-scroll-back";
import { saveLastBotId } from "../lib/last-bot";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
} from "../lib/live-notifications";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { buildMessageContextMenu, messageMenuReaction } from "../lib/message-context-menu";
import {
  applyLocalChoiceDismissals,
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messageHasInlineControls,
  messagePresentationSegments,
  quotableMessageSegments,
  truncateQuoteExcerpt,
} from "../lib/message-presentation";
import { openModelSettings } from "../lib/model-settings";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { HEADER_TITLE_MAX_FONT_SCALE, iosAtLeast } from "../lib/native-controls";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notification-open";
import { peerChipPress } from "../lib/peer-chip";
import type { PickedAttachment } from "../lib/pick-attachments";
import {
  pickDocuments,
  pickFromLibrary,
  readDroppedFiles,
  readSharedFiles,
  takePhoto,
} from "../lib/pick-attachments";
import { attachmentCountSkipReason } from "../lib/pick-attachments-filter";
import { threadRefreshDelayMs } from "../lib/refresh";
import {
  getCachedResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../lib/response-streaming";
import type { SavedChatsScope } from "../lib/saved-chats";
import {
  liveSavedChatsScope,
  loadSavedInbox,
  readSavedThread,
  savedChatsScope,
  savedChatTarget,
  writeSavedThread,
} from "../lib/saved-chats";
import { secretDestinationLabel } from "../lib/secret-destination";
import { secretFieldTraits } from "../lib/secret-field-traits";
import { selectableTextFromMarkdown } from "../lib/selectable-text";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadVerifiedIntegrationsScope,
  subscribeSessionGeneration,
} from "../lib/session";
import { setInboxHidden, useSplitView } from "../lib/split-view";
import { threadEdgeOptions, threadHeaderClearance, threadHeaderFloats } from "../lib/thread-edges";
import type { SendAttempt } from "../lib/thread-feedback";
import { subscribeDelivered, useThreadFeedback } from "../lib/thread-feedback";
import { ThreadJumpAnchor } from "../lib/thread-jump";
import { threadKeyboardOffset } from "../lib/thread-keyboard-offset";
import { ThreadReadOnlyContext } from "../lib/thread-read-only";
import type { ThreadScrollAction, ThreadScrollState } from "../lib/thread-scroll";
import {
  isOwnThreadMessage,
  latestArrivalMessage,
  latestThreadRowKey,
  ThreadScrollBehavior,
} from "../lib/thread-scroll";
import { reconcileVisibleThreadSnapshot } from "../lib/thread-snapshot";
import { prepareUnsentSends } from "../lib/unsent-sends";
import { useFileDrop } from "../lib/use-file-drop";
import type { UserBubble } from "../lib/user-bubble";
import { withUserBubble } from "../lib/user-bubble";
import { errorText } from "../lib/user-error";
import { speakQueue, speakText } from "../lib/voice";
import {
  loadCallCallerName,
  probeProviderTranscribe,
  resolveVoiceCallPlan,
} from "../lib/voice-call-entry";

type PendingAttachment = PickedAttachment & { threadKey: string };
type AskAction = NonNullable<Extract<MessageBlock, { kind: "ask" }>["actions"]>[number];

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatApprovalAnswer(
  answer: string | undefined,
  actions: AskAction[] | undefined,
  approval: boolean,
): string {
  if (!answer) return t("Answered");
  const selectedAction = actions?.find((action) => action.id === answer);
  const outcome = selectedAction?.outcome;
  if (approval && outcome === "created") return t("Created");
  if (approval && outcome === "cancelled") return t("Cancelled");
  if (approval && answer === "allow") return t("Allowed once");
  if (approval && answer === "always") return t("Always allowed");
  if (approval && answer === "deny") return t("Denied");
  return t("Answered: {answer}", { answer: selectedAskActionLabel(answer, actions) });
}

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason.startsWith("over "))
    return t("{name} (over {limit})", { name, limit: item.reason.slice(5) });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", { name, count: maxMatch[1] ?? "" });
  }
  return `${name} (${t(item.reason)})`;
}

function isActiveStatus(status: string | undefined): boolean {
  return isRunWorking(status) || isRunWaitingOnUser(status);
}

const ATTACHMENT_PLACEHOLDER_LINE = /^\[(?:image|file|chart): .*\]$/;

function speakableMessageText(message: MobileMessage): string {
  return blockText(message)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ATTACHMENT_PLACEHOLDER_LINE.test(line))
    .join("\n");
}

export default function ThreadRoute() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const [owner, setOwner] = useState<{ key: string; generation: number; userId: string } | null>(
    null,
  );
  useEffect(() => {
    if (generation !== ready) return;
    const apiBase = currentApiBase();
    let cancelled = false;
    let notified = false;
    let timer: ReturnType<typeof setTimeout>;
    const verify = () =>
      void loadVerifiedIntegrationsScope()
        .then((saved) => (saved?.apiBase === apiBase ? saved : integrationsCacheScope()))
        .then((scope) => {
          if (
            !cancelled &&
            scope &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          )
            setOwner({
              key: JSON.stringify([apiBase, scope.userId]),
              generation,
              userId: scope.userId,
            });
        })
        .catch((error) => {
          if (!cancelled && !notified) Alert.alert(t("Could not continue"), errorText(error));
          notified = true;
          if (!cancelled && isRetryableError(error)) timer = setTimeout(verify, 5_000);
        });
    verify();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [generation, ready]);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => selectedSpaceId());
  const [switchFailed, setSwitchFailed] = useState(false);
  const [appliedFocus, setAppliedFocus] = useState(focused);
  // Before paint, so a stacked route cannot render its thread against a space
  // a newer notification selected.
  const focusSync = threadRouteSpaceOnFocus({
    focused,
    appliedFocus,
    activeSpaceId,
    liveSpaceId: selectedSpaceId(),
    switchFailed,
  });
  if (focusSync.appliedFocus !== appliedFocus) setAppliedFocus(focusSync.appliedFocus);
  if (focusSync.activeSpaceId !== activeSpaceId) setActiveSpaceId(focusSync.activeSpaceId);
  if (focusSync.switchFailed !== switchFailed) setSwitchFailed(focusSync.switchFailed);
  const request = threadSpaceRequest(spaceId, focusSync.activeSpaceId);

  useEffect(() => {
    if (!focused) return;
    const next = threadSpaceRequest(spaceId, activeSpaceId);
    if (next.action === "show") {
      setSwitchFailed(false);
      return;
    }
    if (next.action === "unavailable") {
      setSwitchFailed(true);
      return;
    }
    let cancelled = false;
    setSwitchFailed(false);
    const requestedSpaceId = next.spaceId;
    void selectSpace(requestedSpaceId).then((switched) => {
      if (cancelled) return;
      // selectSpace commits the id before it resolves; a failed write rolls it back.
      if (threadSpaceSwitchResult(requestedSpaceId, switched, selectedSpaceId()) === "ready") {
        setActiveSpaceId(requestedSpaceId);
        return;
      }
      setSwitchFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, focused, spaceId]);

  if (request.action === "show" && !focusSync.switchFailed)
    return (
      <>
        {owner?.generation !== generation ? <ActivityIndicator color={tokens.foreground} /> : null}
        <View style={{ flex: 1, display: owner?.generation === generation ? "flex" : "none" }}>
          {owner ? <Thread key={owner.key} sessionEpoch={ready} userId={owner.userId} /> : null}
        </View>
      </>
    );
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {request.action === "switch" && !focusSync.switchFailed ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <View style={{ alignItems: "center", gap: 12 }}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>
            {t("Could not switch spaces")}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
            <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Return to inbox")}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Thread({ sessionEpoch, userId }: { sessionEpoch: number; userId: string }) {
  const keyboardLayout = useKeyboardLayout();
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const styles = useThemedStyles(createThreadHeaderStyles);
  const [botActionsOpen, setBotActionsOpen] = useState(false);
  const { t, locale } = useI18n();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const router = useRouter();
  // Beside the chat list on a wide window, the chat has only the width the list leaves.
  const { split, inboxHidden, contentWidth: windowWidth } = useSplitView();
  const nativeHeaderHeight = useHeaderHeight();
  const headerHeight = threadHeaderFloats() ? nativeHeaderHeight : 0;
  const headerClearance = threadHeaderClearance(headerHeight);
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps messages and the composer in a centred reading column.
  const columnInsets = readableGutters(windowWidth, {
    left: split && !inboxHidden ? 0 : insets.left,
    right: insets.right,
  });
  const columnWidth = windowWidth - columnInsets.left - columnInsets.right;
  // Frame by frame, including a swipe that drags the keyboard down.
  const keyboardProgress = useSharedValue(KeyboardController.isVisible() ? 1 : 0);
  useKeyboardHandler(
    {
      onMove: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
      onInteractive: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
      onEnd: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
    },
    [],
  );
  const composerRestingPadding =
    Platform.OS === "ios" ? insets.bottom : Math.max(insets.bottom + 12, 24);
  // Hands the composer from the keyboard to the safe area as the keyboard moves, so it never
  // dips into the home indicator and then jumps back up.
  const composerKeyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: interpolate(keyboardProgress.value, [0, 1], [composerRestingPadding, 12]),
  }));
  const {
    botId,
    groupId,
    name,
    messageId,
    threadId,
    readOnly: readOnlyParam,
  } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
    threadId?: string;
    readOnly?: string;
  }>();
  const readOnly = readOnlyParam === "1";
  const [restoring, setRestoring] = useState(false);
  const requestedThreadId = typeof threadId === "string" && threadId ? threadId : undefined;
  const inGroup = Boolean(groupId);
  const call = useCallSession();
  const onCall = Boolean(botId) && call?.botId === botId;
  const voiceCallStarting = useRef(false);
  const scroll = useRef<FlatList<ThreadItem<MobileMessage>>>(null);
  const helperViewport = useRef<View>(null);
  const helperScrollOffset = useRef(0);
  const helperResize = useRef<(() => void) | null>(null);
  const pinnedScroll = useRef<ScrollView>(null);
  const scrollBehavior = useRef(new ThreadScrollBehavior());
  const liveScrollBack = useRef(new KeyboardScrollBack({ inverted: true }));
  const pinnedScrollBack = useRef(new KeyboardScrollBack({ inverted: false }));
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nativeMomentumActive = useRef(false);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const liveSubscribed = useRef(false);
  const liveCursor = useRef<number | null>(null);
  const liveSubscriptionGeneration = useRef(0);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    newerCursor: number | null;
    coveredThroughSeq?: number;
    probeSeq?: number;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const jumpAnchor = useRef(new ThreadJumpAnchor());
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const routeName = useRef(name);
  routeName.current = name;
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  const readVisibleTarget = useRef<string | null>(null);
  // What the user had read up to when this chat opened; the "New" divider follows it all visit.
  // Each open or return to a chat is a new visit.
  const readVisit = useRef<{ target: string | undefined; visit: number; focused: boolean }>({
    target: undefined,
    visit: 0,
    focused,
  });
  const [readBoundary, setReadBoundary] = useState<ReadBoundary | null>(null);
  // A chat's markRead calls run one at a time so the request that opened it answers first.
  const [readInOrder] = useState(createChatQueues);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);
  const threadKey = groupId ?? botId;
  if (readVisit.current.target !== threadKey || (focused && !readVisit.current.focused)) {
    readVisit.current = { target: threadKey, visit: readVisit.current.visit + 1, focused };
    readVisibleTarget.current = null;
  }
  readVisit.current.focused = focused;
  const [threadScrollState, setThreadScrollState] = useState<ThreadScrollState>(() =>
    scrollBehavior.current.state(),
  );
  const publishThreadScrollState = useCallback((next: ThreadScrollState) => {
    setThreadScrollState((previous) => reconcileThreadScrollState(previous, next));
  }, []);
  useLayoutEffect(() => {
    scrollBehavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    jumpAnchor.current.release();
    joinPinnedAfterLayout.current = null;
    loadingOlderContent.current = false;
    publishThreadScrollState(scrollBehavior.current.state());
    return () => {
      clearTimeout(scrollIdleTimer.current);
      nativeMomentumActive.current = false;
    };
  }, [threadKey, publishThreadScrollState]);
  const reducedMotion = useReducedMotion();
  const artifactTarget: MobileArtifactTarget | undefined = groupId
    ? { groupId }
    : botId
      ? { botId }
      : undefined;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  /** Bots writing reply text right now, comma-separated. */
  const [composingBots, setComposingBots] = useState("");
  const snapRef = useRef<MobileSnapshot | null>(null);
  // The copy saved on this device stays on screen until a live snapshot replaces it.
  const [showingSaved, setShowingSaved] = useState(false);
  const snapshotOrigin = useRef<SavedChatsScope | null>(null);
  const pendingSave = useRef<(() => void) | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;

  function commitSnap(next: MobileSnapshot | null) {
    snapRef.current = next;
    const visible = withLiveStreamingProgress(next, streamResponsesRef.current);
    setSnap((previous) => reconcileVisibleThreadSnapshot(previous, visible));
    // Read before streamed text is hidden, so a writing bot shows it even with streaming off.
    setComposingBots(
      (next?.messages ?? [])
        .filter(
          (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
        )
        .map((message) => message.botId ?? next?.botId ?? "")
        .sort()
        .join(","),
    );
  }

  useEffect(() => {
    commitSnap(snapRef.current);
  }, [streamResponses]);
  const activeThreadId = useRef<string | undefined>(undefined);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [uploadConfig, setUploadConfig] = useState<{ maxUploadSizeBytes?: number }>();
  const [needsModel, setNeedsModel] = useState<boolean>();
  // Re-read on focus so returning from Models settings updates unsent missing-model messages.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void rpc<{ maxUploadSizeBytes?: number } & Partial<Pick<MobileMe, "needsModel">>>("me")
        .then((me) => {
          if (cancelled) return;
          setUploadConfig(me);
          setNeedsModel(me.needsModel);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const [mentionBots, setMentionBots] = useState<MobileBot[]>([]);
  // The call outlives renders, so its switch check reads the newest bot list from here.
  const mentionBotsRef = useRef<MobileBot[]>([]);
  mentionBotsRef.current = mentionBots;
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<MobileMessage | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const preparingSend = useRef(false);
  const echoed = useMemo(
    () =>
      snap && (snap.groupId ?? snap.botId) === threadKey
        ? new Set(
            snap.messages.flatMap((message) =>
              message.role === "user" && message.seq !== undefined ? [message.seq] : [],
            ),
          )
        : undefined,
    [snap, threadKey],
  );
  const feedback = useThreadFeedback(threadKey, newClientNonce, echoed);
  const { error, setError } = feedback;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [runErrorDetailsOpen, setRunErrorDetailsOpen] = useState(false);
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingNewerContent = useRef(false);
  // A failed newer page waits for the next drag instead of retrying on every scroll event.
  const newerLoadFailed = useRef(false);
  const pinnedScrollMetrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const joinPinnedAfterLayout = useRef<number | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const [dismissedChoiceQuestions, setDismissedChoiceQuestions] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const [expandedPeerMarkers, setExpandedPeerMarkers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const showBotSenderName = useMemo(
    () =>
      shouldShowBotSenderName({
        isGroup: inGroup,
        speakerBotIds: (snap?.messages ?? [])
          .filter((message) => message.role === "bot")
          .map((message) => message.botId),
      }),
    [inGroup, snap?.messages],
  );
  const peerTranscript = useMemo(
    () => foldPeerReplies(snap?.messages ?? [], { includePeerReceipts: true }),
    [snap?.messages],
  );
  const reactionView = useMemo(
    () =>
      projectMessageReactions(
        expandPeerReplies(peerTranscript, expandedPeerMarkers)
          .map((message) => {
            const dismissed = dismissedChoiceQuestions.get(message.id);
            if (!dismissed) return message;
            const blocks = applyLocalChoiceDismissals(message.blocks, dismissed);
            return blocks === message.blocks ? message : { ...message, blocks: [...blocks] };
          })
          .filter((message) => hasVisibleMessagePresentation(message.blocks)),
      ),
    [dismissedChoiceQuestions, expandedPeerMarkers, peerTranscript],
  );
  const visibleMessages = reactionView.visibleMessages;
  const latestMessage = latestArrivalMessage(visibleMessages, peerTranscript.markerOf);
  const latestMessageId = latestMessage?.id ?? null;
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  // Read by a second drop that starts before the first one commits.
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  const composerRef = useRef<ThreadComposerHandle>(null);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: mentionBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
        })),
        groups: mentionGroups.map((group) => ({
          id: group.id,
          name: group.name,
        })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [groupId, inGroup, mentionBots, mentionConnectors, mentionGroups, mentionRoutines],
  );
  const currentBot = botId ? mentionBots.find((bot) => bot.id === botId) : undefined;
  const displayName = safeDisplayName(currentBot?.name ?? name, inGroup ? t("Group") : t("Bot"));
  const composerPrompt = displayName ? t("Message {name}", { name: displayName }) : t("Message…");
  const notificationThreadId = snap?.threadId ?? requestedThreadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const currentBotStatus = snap ? snap.run?.status : currentBot?.status;
  // Only reply text being written replaces the footer; earlier sentences above a tool call don't.
  const hasLiveProgress = visibleMessages.some(
    (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
  );
  const activityLine = liveActivityLine(snap?.messages ?? []);
  const userBubble = useMemo(
    () =>
      !inGroup && currentBot ? chatUserBubbleColors(currentBot.color, currentBot.id) : undefined,
    [inGroup, currentBot?.color, currentBot?.id],
  );
  const activeGroupBots = useMemo(() => {
    if (!inGroup) return [];
    const seen = new Set<string>();
    const active = snap?.activeRuns ?? (snap?.run ? [snap.run] : []);
    return active.flatMap((run) => {
      if (!run.botId || seen.has(run.botId) || !isActiveStatus(run.status)) return [];
      const member = snap?.members?.find((candidate) => candidate.botId === run.botId);
      if (!member) return [];
      seen.add(run.botId);
      return [{ ...member, status: run.status }];
    });
  }, [inGroup, snap?.activeRuns, snap?.members, snap?.run]);
  // A bot waiting on the user (an ask card, a computer takeover) can still be stopped, but its
  // card is the state: no typing dots under it.
  const workingGroupBots = activeGroupBots.filter((bot) => isRunWorking(bot.status));
  const working = inGroup ? activeGroupBots.length > 0 : isActiveStatus(currentBotStatus);

  const speakFinishedReply = useCallback(() => {
    if (!botId || inGroup || !currentBot) return;
    const decision = nextAutoSpeakAction({
      botId: currentBot.id,
      autoSpeak: currentBot.autoSpeak,
      focused: AppState.currentState === "active" && navigation.isFocused(),
      snapshotReady: snap?.botId === currentBot.id && !showingSaved,
      lastSpokenBotId: autoSpokenBotId.current,
      lastSpokenMessageId: autoSpoken.current,
      runStatus: snap?.run?.status,
      messages: snap?.messages ?? [],
    });
    if (decision.action === "seed") {
      autoSpokenBotId.current = currentBot.id;
      autoSpoken.current = decision.messageId;
      return;
    }
    if (decision.action !== "speak") return;
    autoSpokenBotId.current = currentBot.id;
    autoSpoken.current = decision.messageId;
    void speakText(decision.text, {
      botId: currentBot.id,
      speaker: {
        name: currentBot.name,
        color: resolvePersonaColorDef(currentBot.id, currentBot.color).light,
      },
    }).catch(() => undefined);
  }, [
    botId,
    inGroup,
    currentBot,
    navigation,
    showingSaved,
    snap?.botId,
    snap?.messages,
    snap?.run?.status,
  ]);

  const speakFinishedReplyRef = useRef(speakFinishedReply);
  useLayoutEffect(() => {
    speakFinishedReplyRef.current = speakFinishedReply;
  }, [speakFinishedReply]);

  useEffect(() => {
    speakFinishedReply();
    const appState = AppState.addEventListener("change", speakFinishedReply);
    return () => appState.remove();
  }, [speakFinishedReply]);

  useEffect(() => {
    void rpc<AgentSkillCatalogEntry[]>("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    publishThreadScrollState(scrollBehavior.current.state());
  }, [threadKey, publishThreadScrollState]);

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    try {
      const bots = await rpc<MobileBot[]>("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      if (targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots((current) => retainUnchangedBotRoster(current, bots));
      if (targetBotId) {
        const next = bots.find((bot) => bot.id === targetBotId);
        // Read the route name from a ref so renaming does not recreate this
        // callback (and restart the SSE subscription that depends on it).
        if (next?.name && next.name !== routeName.current) {
          router.setParams({ name: next.name });
        }
      }
    } catch {
      // Keep the last known roster if refresh fails. Before any, use the bots saved with the
      // inbox, so a saved chat offline keeps its bot's colour and avatar.
      if (mentionBotsAppliedGeneration.current !== 0) return;
      const saved = await loadSavedInbox();
      if (!saved || mentionBotsAppliedGeneration.current !== 0) return;
      if (targetBotId !== activeBotId.current) return;
      setMentionBots((current) => (current.length ? current : saved.bots));
    }
  }, [botId, groupId, router]);

  useEffect(() => {
    void rpc<MobileGroup[]>("groups/list")
      .then(setMentionGroups)
      .catch(() => setMentionGroups([]));
  }, [refreshMentionBots]);

  useEffect(() => {
    if (mentionBots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(mentionBots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      mentionBots.map((bot) =>
        rpc<Routine[]>("routines/list", { botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc<Connection[]>("connections/list").catch(() => [] as Connection[]),
      rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(
        () => [] as ConnectionCatalogItem[],
      ),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionBots]);

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  useLayoutEffect(() => {
    // The title opens the chat's own settings: the group's in a group, the bot's otherwise.
    const titleSettings = chatSettingsRoute({ groupId, botId, readOnly });
    navigation.setOptions({
      title: displayName || t("Thread"),
      headerTitleAlign: "center",
      ...threadEdgeOptions(),
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            titleSettings
              ? t(inGroup ? "Group settings" : "Chat settings")
              : displayName || t("Thread")
          }
          disabled={!titleSettings}
          onPress={() => {
            if (titleSettings) router.push(titleSettings);
          }}
        >
          <GlassSurface style={styles.titleCapsule} fallbackStyle={styles.titleCapsuleFill}>
            {!inGroup && currentBot ? (
              <BotAvatar
                color={currentBot.color}
                identity={currentBot.id}
                size={28}
                status={currentBotStatus}
                composing={composingBots.split(",").includes(currentBot.id)}
                muted={currentBot.notifyOnFinish === false}
              />
            ) : null}
            <Text
              maxFontSizeMultiplier={HEADER_TITLE_MAX_FONT_SCALE}
              numberOfLines={1}
              style={styles.title}
            >
              {displayName || t("Thread")}
            </Text>
          </GlassSurface>
        </Pressable>
      ),
      ...(Platform.OS === "ios" && !readOnly && (!inGroup || iosAtLeast(26))
        ? {
            unstable_headerRightItems: () => [
              inGroup
                ? {
                    type: "button" as const,
                    label: t("Group settings"),
                    accessibilityLabel: t("Group settings"),
                    icon: { type: "sfSymbol" as const, name: "gearshape" },
                    onPress: () =>
                      router.push({
                        pathname: "/group-settings",
                        params: { groupId: groupId ?? "" },
                      }),
                  }
                : {
                    type: "menu" as const,
                    label: t("Bot actions"),
                    accessibilityLabel: t("Bot actions"),
                    icon: { type: "sfSymbol" as const, name: "ellipsis" },
                    disabled: !botId,
                    menu: {
                      items: botActions.map((action) => ({
                        type: "action" as const,
                        label: action.text,
                        destructive: action.destructive,
                        ...(action.text === t("Open computer")
                          ? { icon: { type: "sfSymbol" as const, name: "desktopcomputer" } }
                          : {}),
                        onPress: action.onPress,
                      })),
                    },
                  },
            ],
          }
        : {}),
      headerRight: () =>
        inGroup ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Group settings")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/group-settings",
                params: { groupId: groupId ?? "" },
              })
            }
          >
            <NativeSymbol
              ios="gearshape"
              android="settings-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ) : (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Bot actions")}
              hitSlop={8}
              onPress={showBotActions}
            >
              <NativeSymbol
                ios="ellipsis"
                android="ellipsis-horizontal"
                size={21}
                color={tokens.foreground}
              />
            </Pressable>
          </View>
        ),
      ...(split
        ? {
            headerBackVisible: false,
            ...(iosAtLeast(26)
              ? {
                  unstable_headerLeftItems: () => [
                    {
                      type: "button" as const,
                      label: inboxHidden ? t("Show chats") : t("Hide chats"),
                      icon: { type: "sfSymbol" as const, name: "sidebar.left" },
                      onPress: () => setInboxHidden(!inboxHidden),
                    },
                  ],
                }
              : {}),
            headerLeft: () => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={inboxHidden ? t("Show chats") : t("Hide chats")}
                hitSlop={8}
                onPress={() => setInboxHidden(!inboxHidden)}
              >
                <NativeSymbol
                  ios={inboxHidden ? "sidebar.left" : "arrow.up.left.and.arrow.down.right"}
                  android={inboxHidden ? "contract-outline" : "expand-outline"}
                  size={21}
                  color={tokens.foreground}
                />
              </Pressable>
            ),
          }
        : // Folding back takes the list away, so the chat gets its back button again.
          {
            headerBackVisible: true,
            headerLeft: undefined,
            ...(iosAtLeast(26) ? { unstable_headerLeftItems: () => [] } : {}),
          }),
      ...(readOnly
        ? trailingHeaderOptions(t("Restore"), () => void restoreConversation(), restoring)
        : {}),
    });
  }, [
    split,
    inboxHidden,
    readOnly,
    restoring,
    botId,
    currentBot,
    currentBotStatus,
    composingBots,
    displayName,
    groupId,
    inGroup,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
    styles,
  ]);

  async function restoreConversation() {
    if (!botId || restoring) return;
    setRestoring(true);
    try {
      await restoreArchivedBot(botId);
      notifyArchivedChatsChanged();
      router.setParams({ readOnly: "0" });
    } catch (cause) {
      Alert.alert(t("Could not restore bot"), errorText(cause, t("Try again.")));
    } finally {
      setRestoring(false);
    }
  }

  function leaveBot() {
    router.dismissAll();
    router.replace("/");
  }

  function clearConversation() {
    if (!botId) return;
    void rpc("threads/clear", { botId })
      .then(() => {
        expandedHistoryThread.current = null;
        pinnedAroundRef.current = null;
        historyEpoch.current += 1;
        commitSnap(
          snapRef.current
            ? { ...snapRef.current, messages: [], olderCursor: null, run: null }
            : snapRef.current,
        );
      })
      .catch((err: unknown) =>
        Alert.alert(t("Could not clear conversation"), errorText(err, t("Try again."))),
      );
  }

  function openBotComputer() {
    router.push({
      pathname: "/computer",
      params: { botId: botId ?? "", name: displayName ?? t("Bot") },
    });
  }

  const botActions = [
    ...(!readOnly && botId ? [{ text: t("Open computer"), onPress: openBotComputer }] : []),
    {
      text: t("Profile"),
      onPress: () =>
        router.push({
          pathname: "/bot-profile",
          params: { botId: botId ?? "", name: displayName ?? t("Bot") },
        }),
    },
    {
      text: t("Chat settings"),
      onPress: () =>
        router.push({
          pathname: "/bot-settings",
          params: { botId: botId ?? "" },
        }),
    },
    {
      text: t("Clear conversation"),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t("Clear conversation?"),
          t(
            "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
          ),
          [
            { text: t("Cancel"), style: "cancel" },
            { text: t("Clear"), style: "destructive", onPress: clearConversation },
          ],
        ),
    },
    {
      text: t("Archive"),
      onPress: () =>
        void rpc("bots/archive", { botId })
          .then(() => {
            notifyArchivedChatsChanged();
            leaveBot();
          })
          .catch((error) =>
            Alert.alert(t("Could not archive bot"), errorText(error, t("Try again."))),
          ),
    },
    {
      text: t("Delete…"),
      destructive: true,
      onPress: () =>
        confirmDeleteBot({ id: botId ?? "", name: displayName || t("Bot") }, () => {
          notifyArchivedChatsChanged();
          leaveBot();
        }),
    },
  ];

  function showBotActions() {
    if (!botId) return;
    setBotActionsOpen(true);
  }

  /** Shows the chat's saved copy until live data for it arrives; never under a search jump. */
  function showSavedThread(signal: AbortSignal) {
    const target = savedChatTarget({ botId, groupId });
    // Another chat's messages must never stay on screen under this chat's name.
    if (snapRef.current && savedChatTarget(snapRef.current) !== target) {
      commitSnap(null);
      setShowingSaved(false);
    }
    void savedChatsScope().then((scope) => {
      if (signal.aborted || !scope) return;
      const onScreen = snapRef.current;
      if (messageId || (onScreen && savedChatTarget(onScreen) === target)) return;
      const saved = readSavedThread(scope, target);
      if (!saved) return;
      snapshotOrigin.current = scope;
      commitSnap(saved);
      setShowingSaved(true);
    });
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const origin = {
      sessionGeneration: currentSessionGeneration(),
      selectionId: selectedSpaceId(),
    };
    const generation = ++refreshGeneration.current;
    const next = await rpc<MobileSnapshot>(
      "threads/get",
      targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
    );
    if (
      origin.sessionGeneration !== currentSessionGeneration() ||
      origin.selectionId !== selectedSpaceId()
    )
      return;
    const scope = await liveSavedChatsScope();
    if (
      !scope ||
      scope.sessionGeneration !== origin.sessionGeneration ||
      scope.selectionId !== origin.selectionId ||
      !isIntegrationsScopeCurrent(scope)
    )
      return;
    // Only the newest started refresh may commit. Threads also receive live
    // events; an older snapshot must not overwrite those while a newer refresh
    // is already in flight. The subscription starts from the snapshot returned
    // here, so a discarded fetch must not supply its cursor.
    const result = mobileThreadRefreshResult({
      fetched: next,
      onScreen: snapRef.current,
      requestGeneration: generation,
      currentGeneration: refreshGeneration.current,
      requestEpoch: epoch,
      currentEpoch: historyEpoch.current,
      targetBotId,
      targetGroupId,
      activeBotId: activeBotId.current,
      activeGroupId: activeGroupId.current,
    });
    if (result.commit) {
      snapshotOrigin.current = scope;
      pendingSave.current = null;
      writeSavedThread(scope, savedChatTarget(next), next);
      commitSnap(
        mergeMobileSnapshot(snapRef.current, next, expandedHistoryThread.current === next.threadId),
      );
      setShowingSaved(false);
    }
    if (isCurrentTarget(targetBotId, targetGroupId)) {
      feedback.refreshed(targetGroupId ?? targetBotId);
    }
    return result.snapshot ?? undefined;
  }

  async function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = target.groupId ? { groupId: target.groupId } : { botId: target.botId! };
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const scope = await liveSavedChatsScope();
    if (!scope || !isIntegrationsScopeCurrent(scope)) return;
    const [snap, page] = await Promise.all([
      rpc<MobileSnapshot>("threads/get", threadTarget),
      rpc<MobileMessagePage>("threads/messages", {
        ...threadTarget,
        around: { messageId: target.messageId },
      }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
    // generation check drops an older same-thread jump that finished after a newer one.
    if (
      epoch !== historyEpoch.current ||
      jumpId !== jumpGeneration.current ||
      !isIntegrationsScopeCurrent(scope)
    )
      return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    // A relay's dropped marker (e.g. a search hit) lands on its "Messaged X" receipt.
    const messageId = jumpTargetId(
      foldPeerReplies(page.messages, { includePeerReceipts: true }),
      target.messageId,
    );
    const targetInPage = page.messages.some((message) => message.id === messageId);
    const opened = targetInPage ? openThreadWindow(snap, page) : null;
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = opened
      ? {
          ...threadTarget,
          messageId,
          threadId: page.threadId,
          newerCursor: opened.newerCursor,
        }
      : null;
    jumpAnchor.current.begin(targetInPage ? messageId : null);
    jumpScrollTarget.current = targetInPage ? messageId : null;
    newerLoadFailed.current = false;
    joinPinnedAfterLayout.current = null;
    pinnedScrollMetrics.current = { offset: 0, viewport: 0, content: 0 };
    // Publish the jump refs even when the opened snapshot is already visible.
    setThreadScrollState(scrollBehavior.current.state());
    snapshotOrigin.current = scope;
    const next = opened?.snapshot ?? snap;
    // A reply folded under its peer marker is only drawn once the marker is expanded.
    const markerId = targetInPage
      ? foldPeerReplies(next.messages, { includePeerReceipts: true }).markerOf.get(messageId)
      : undefined;
    if (markerId) {
      setExpandedPeerMarkers((expanded) =>
        expanded.has(markerId) ? expanded : new Set(expanded).add(markerId),
      );
    }
    commitSnap(next);
    setShowingSaved(false);
  }

  async function loadNewerMessages() {
    const pinned = pinnedAroundRef.current;
    if (
      (!botId && !groupId) ||
      pinned?.newerCursor == null ||
      loadingNewerContent.current ||
      newerLoadFailed.current
    )
      return;
    loadingNewerContent.current = true;
    setLoadingNewer(true);
    const epoch = historyEpoch.current;
    const probe = pinned.probeSeq ?? pinned.newerCursor + 1;
    let visibleUnchanged = false;
    try {
      // Pages come back centered on the seq, so the one after the cursor overlaps what is loaded.
      const page = await rpc<MobileMessagePage & { coveredThroughSeq?: number }>(
        "threads/messages",
        {
          ...(groupId ? { groupId } : { botId: botId! }),
          around: { seq: probe },
        },
      );
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned || !snapRef.current)
        return;
      const visibleBefore = threadWindowMessages(
        snapRef.current.messages,
        pinned.newerCursor,
      ).length;
      const reported = page.coveredThroughSeq ?? null;
      const carried =
        reported == null ? undefined : Math.max(pinned.coveredThroughSeq ?? reported, reported);
      const next = appendNewerThreadPage(
        snapRef.current,
        pinned.newerCursor,
        page,
        reported == null ? null : carried,
      );
      const step = forwardProbeAfterPage({
        probe,
        newerCursor: pinned.newerCursor,
        nextCursor: next.newerCursor,
        reportedCoverage: reported,
        carriedCoverage: pinned.coveredThroughSeq,
      });
      if (step.stalled) newerLoadFailed.current = true;
      visibleUnchanged =
        threadWindowMessages(next.snapshot.messages, next.newerCursor).length === visibleBefore;
      pinnedAroundRef.current = {
        ...pinned,
        newerCursor: next.newerCursor,
        coveredThroughSeq: step.coverage,
        probeSeq: step.probe,
      };
      commitSnap(next.snapshot);
      if (next.newerCursor == null) {
        joinPinnedAfterLayout.current = pinnedScrollMetrics.current.content;
      }
    } catch (err) {
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) return;
      newerLoadFailed.current = true;
      setError(errorText(err, t("Could not open message")));
    } finally {
      loadingNewerContent.current = false;
      setLoadingNewer(false);
      if (visibleUnchanged) loadNewerNearEnd();
    }
  }

  function showLatest() {
    const pinned = pinnedAroundRef.current;
    pinnedAroundRef.current = null;
    joinPinnedAfterLayout.current = null;
    jumpScrollTarget.current = null;
    jumpAnchor.current.release();
    expandedHistoryThread.current = null;
    // The live list mounts at the latest message.
    scrollBehavior.current.jumpToLatest();
    // Clearing the pinned refs must render even when the snapshot and scroll flags are unchanged.
    setThreadScrollState(scrollBehavior.current.state());
    commitSnap(
      snapRef.current && pinned
        ? leaveThreadWindow(snapRef.current, pinned.newerCursor)
        : snapRef.current,
    );
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    const pinned = pinnedAroundRef.current;
    try {
      const page = await rpc<MobileMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
        includePeerReceipts: true,
      });
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      commitSnap(prependMobileMessagePage(snapRef.current, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(errorText(err, t("Could not load earlier messages")));
    } finally {
      setLoadingOlder(false);
    }
  }

  // After "Mark as unread" on a message, the chat stays unread for the rest of this visit. The
  // hold names the visit, so returning to the chat (a new visit) reads it again.
  const heldUnread = useRef<number | null>(null);
  const markUnreadFrom = (message: MobileMessage) => {
    const visit = readVisit.current.visit;
    const target = groupId ?? botId;
    if (!target) return;
    heldUnread.current = visit;
    // Through the chat's read queue, so a read already sent lands first and this one wins.
    void readInOrder(target, () =>
      rpc("threads/markUnread", {
        ...(groupId ? { groupId } : { botId: botId! }),
        messageId: message.id,
      }),
    ).catch((err) => {
      if (heldUnread.current === visit) heldUnread.current = null;
      Alert.alert(t("Could not update chat"), errorText(err, t("Try again.")));
    });
  };

  const markReadIfVisible = useCallback(() => {
    if (
      readOnly ||
      heldUnread.current === readVisit.current.visit ||
      AppState.currentState !== "active" ||
      !navigation.isFocused()
    )
      return;
    const target = groupId ?? botId;
    if (!target || readVisibleTarget.current === target) return;
    readVisibleTarget.current = target;
    const visit = readVisit.current.visit;
    if (activeThreadId.current) {
      void dismissThreadNotifications({ threadId: activeThreadId.current }).catch(() => undefined);
    }
    // A read that waited in the queue skips once the user has left the chat, or marked it
    // unread meanwhile.
    void readInOrder(target, () =>
      readVisit.current.visit === visit &&
      heldUnread.current !== visit &&
      AppState.currentState === "active" &&
      navigation.isFocused()
        ? rpc<{ unreadAfterSeq?: number | null }>(
            "threads/markRead",
            groupId ? { groupId } : { botId: botId! },
          )
        : Promise.resolve(null),
    )
      .then((answer) => {
        if (!answer) {
          if (readVisibleTarget.current === target) readVisibleTarget.current = null;
          return;
        }
        setReadBoundary((current) =>
          settleReadBoundary(current, readVisit.current.visit, {
            visit,
            seq: answer.unreadAfterSeq ?? null,
          }),
        );
      })
      .catch(() => {
        if (readVisibleTarget.current === target) readVisibleTarget.current = null;
      });
  }, [botId, groupId, navigation, readInOrder, readOnly]);

  useEffect(() => {
    if (!notificationThreadId || AppState.currentState !== "active" || !navigation.isFocused())
      return;
    void setOpenNotificationThread({ botId, threadId: notificationThreadId }).catch(
      () => undefined,
    );
    void dismissThreadNotifications({ threadId: notificationThreadId }).catch(() => undefined);
  }, [botId, navigation, notificationThreadId]);

  // Cancel delayed setup only when leaving this bot's thread (unmount or botId
  // change). Blur alone is not leave — settings/computer push must keep the timer.
  useEffect(() => {
    if (!botId) return;
    return () => {
      cancelFocusPrompt(botId);
    };
  }, [botId]);

  // Covers returning from a pushed screen; the AppState listener covers returning from background.
  useFocusEffect(
    useCallback(() => {
      if (botId && !readOnly) {
        focusPromptThreadActive(botId);
        void saveLastBotId(botId).catch(() => undefined);
      } else {
        // Group thread focus: prior bot screen may stay mounted, so clear any delayed setup.
        cancelFocusPrompt();
      }
      void refreshMentionBots();
      markReadIfVisible();
      if (!readOnly) speakFinishedReplyRef.current();
    }, [botId, readOnly, markReadIfVisible, refreshMentionBots]),
  );

  // Kept apart from the effect above: its callbacks change with every streamed message, and
  // each re-run would close and reopen the thread, restarting the Android notification poller.
  useFocusEffect(
    useCallback(() => {
      if (AppState.currentState === "active" && notificationThreadId) {
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
      }
      return () => {
        void setOpenNotificationThread(null).catch(() => undefined);
      };
    }, [botId, notificationThreadId]),
  );

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (!navigation.isFocused() || !notificationThreadId) return;
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
        markReadIfVisible();
        return;
      }
      void setOpenNotificationThread(null).catch(() => undefined);
    });
    return () => appState.remove();
  }, [botId, markReadIfVisible, navigation, notificationThreadId]);

  useEffect(() => {
    liveCursor.current = null;
  }, [botId, groupId, sessionEpoch]);

  useEffect(() => {
    // Resume the same chat from its applied cursor so pinned and expanded windows catch up.
    if ((!botId && !groupId) || !foreground) return;
    // Invalidate pending history loads while retaining pages already loaded for this chat.
    historyEpoch.current += 1;
    const abort = new AbortController();
    const subscriptionGeneration = ++liveSubscriptionGeneration.current;
    const sessionGeneration = currentSessionGeneration();
    liveSubscribed.current = false;
    showSavedThread(abort.signal);
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next =
        liveCursor.current !== null
          ? null
          : messageId
            ? await rpc<MobileSnapshot>(
                "threads/get",
                groupId ? { groupId } : { botId: botId! },
              ).catch((err: unknown) => {
                setError(errorText(err));
                return null;
              })
            : await refresh().catch((err: unknown) => {
                setError(errorText(err));
                return null;
              });
      if (abort.signal.aborted || readOnly) return;
      let cursor = liveCursor.current ?? next?.cursor ?? -1;
      liveCursor.current = cursor;
      let retryMs = 250;
      while (!abort.signal.aborted && sessionGeneration === currentSessionGeneration()) {
        let failure: unknown;
        try {
          liveSubscribed.current = true;
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              if (abort.signal.aborted || sessionGeneration !== currentSessionGeneration()) return;
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
                event.type === "agent.tool.called" ||
                event.type === "agent.tool.completed" ||
                event.type === "thread.message.created" ||
                event.type === "thread.message.updated" ||
                event.type === "thread.message.reaction" ||
                event.type === "thread.subagent" ||
                event.type === "thread.cloud_agent" ||
                event.type === "thread.cleared" ||
                event.type === "run.waiting_input" ||
                event.type === "computer.takeover.requested" ||
                event.type === "computer.takeover.released" ||
                isRunTerminalEvent(event)
              ) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  jumpScrollTarget.current = null;
                  jumpAnchor.current.release();
                  historyEpoch.current += 1;
                }
                commitSnap(applyMobileThreadEvent(snapRef.current, event));
              }
              liveCursor.current = cursor;
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                void refreshMentionBots();
              }
              if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
                // Reconcile run ownership for ask cards first seen through live events.
                if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
                  void refresh().catch(() => undefined);
                }
              }
            },
            abort.signal,
          );
        } catch (error) {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
          failure = error;
        } finally {
          if (liveSubscriptionGeneration.current === subscriptionGeneration) {
            liveSubscribed.current = false;
          }
        }
        // A 4xx other than 408/429 is the server's answer; reconnecting only polls it.
        if (abort.signal.aborted || !isRetryableError(failure)) break;
        let refreshFailure: unknown;
        if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
          refreshFailure = await refresh().then(
            () => undefined,
            (error: unknown) => error,
          );
          if (!isRetryableError(refreshFailure)) break;
        }
        // Wait as long as either request was asked to (a 429's Retry-After).
        const delay = Math.max(
          retryDelayMs(failure, retryMs),
          retryDelayMs(refreshFailure, retryMs),
        );
        await abortableDelay(delay, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [botId, groupId, foreground, readOnly, markReadIfVisible, refreshMentionBots, sessionEpoch]);

  useEffect(() => () => pendingSave.current?.(), [botId, groupId]);

  // Save the latest messages of the live chat (not a jump or loaded history) once updates settle.
  useEffect(() => {
    if (
      !snap ||
      showingSaved ||
      jumpScrollTarget.current ||
      pinnedAroundRef.current ||
      expandedHistoryThread.current
    )
      return;
    const target = savedChatTarget({ botId, groupId });
    const latest = snapRef.current;
    if (!latest || savedChatTarget(latest) !== target) return;
    const origin = snapshotOrigin.current;
    if (!origin) return;
    const write = () => writeSavedThread(origin, target, latest);
    pendingSave.current = write;
    const timer = setTimeout(() => {
      pendingSave.current?.();
      pendingSave.current = null;
    }, 600);
    return () => clearTimeout(timer);
  }, [snap, showingSaved, botId, groupId]);

  // The safety snapshot is a gap detector, not the live path: SSE already carries
  // deltas. Stop the timer while the app is backgrounded; the stream effect resumes
  // from its cursor when the app returns.
  useFocusEffect(
    useCallback(() => {
      if (!foreground || (!botId && !groupId)) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ticking = false;
      const refreshDelay = () =>
        threadRefreshDelayMs(snap?.run?.status, {
          liveSubscribed: liveSubscribed.current,
          readOnly,
        });
      function schedule() {
        if (!cancelled) timer = setTimeout(() => void tick(), refreshDelay());
      }
      async function tick() {
        if (cancelled || ticking) return;
        ticking = true;
        let failure: unknown;
        try {
          if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
            await refresh().catch((error: unknown) => {
              failure = error;
            });
          }
        } finally {
          ticking = false;
          if (isRetryableError(failure)) schedule();
        }
      }
      schedule();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [botId, foreground, groupId, readOnly, snap?.run?.status]),
  );

  useEffect(() => {
    if (!botId && !groupId) return;
    // A conversation hit is the thread itself: stay on the live tail, not an older page.
    if (!messageId) {
      const pinned = pinnedAroundRef.current != null || jumpAnchor.current.holds();
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
      pinnedAroundRef.current = null;
      if (pinned) {
        expandedHistoryThread.current = null;
        commitSnap(snapRef.current);
      }
      return;
    }
    jumpAnchor.current.begin(messageId);
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(errorText(err, t("Could not open message")));
      },
    );
  }, [botId, groupId, messageId, sessionEpoch]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    setReplyTarget(null);
    setReplyQuote(null);
    setQuoteTarget(null);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  // Import only once settings are available, and keep mixed text/files together.
  const importingShare = useRef(false);
  const [shareImporting, setShareImporting] = useState(false);
  // The share a settings refresh interrupted. It is retried on its own, so a
  // share that arrived in the meantime is left for the picker, not taken here.
  const interruptedShare = useRef<{ generation: number } | null>(null);
  const [shareImportTick, setShareImportTick] = useState(0);
  useEffect(() => {
    if (!threadKey || readOnly || !uploadConfig || importingShare.current) return;
    const interrupted = interruptedShare.current;
    interruptedShare.current = null;
    const share = takeIncomingShare();
    if (!share) return;
    if (interrupted && share.generation !== interrupted.generation) {
      // The interrupted share is gone; this newer one belongs to the picker.
      retryIncomingShare(share);
      return;
    }
    let active = true;
    importingShare.current = true;
    setShareImporting(true);
    void (async () => {
      try {
        const result = await readSharedFiles(
          share.files,
          activePendingAttachments.length,
          attachmentMaxBytes(uploadConfig),
        );
        if (!active || !isIncomingShareCurrent(share)) {
          retryIncomingShare(share);
          return;
        }
        if (result.failedFiles.length)
          retryIncomingShare({ ...share, text: "", files: result.failedFiles });
        setPendingAttachments((current) => [
          ...current,
          ...result.attachments.map((attachment) => ({ ...attachment, threadKey })),
        ]);
        setAttachmentNotice(
          result.skipped.length
            ? t("Skipped {items}", {
                items: result.skipped.map((item) => formatAttachmentSkip(item)).join(", "),
              })
            : null,
        );
        if (share.text) composerRef.current?.insert(share.text);
      } finally {
        importingShare.current = false;
        setShareImporting(false);
        // Only a pass that settings cancelled is tried again; a file the reader
        // rejected is reported once instead of looping until the share expires.
        if (!active && isIncomingShareCurrent(share)) {
          interruptedShare.current = share;
          retryIncomingShare(share);
          setShareImportTick((tick) => tick + 1);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [threadKey, readOnly, uploadConfig, shareImportTick]);

  function runSlashAction(action: SlashActionId) {
    if (action === "chat-settings") {
      const settings = chatSettingsRoute({ groupId, botId });
      if (settings) router.push(settings);
      return;
    }
    router.push({
      pathname: "/account",
      params: action === "settings-usage" ? { focus: "usage" } : undefined,
    });
  }

  function followOwnSend() {
    if (pinnedAroundRef.current || jumpScrollTarget.current) showLatest();
    performScroll(scrollBehavior.current.onOwnSend());
    publishThreadScrollState(scrollBehavior.current.state());
  }

  async function send() {
    if (readOnly || importingShare.current) return;
    const initialBotTarget = botId;
    const initialGroupTarget = groupId;
    if ((!initialBotTarget && !initialGroupTarget) || sending || preparingSend.current) return;
    const originThreadKey = initialGroupTarget ?? initialBotTarget;
    const submitted = composerRef.current?.snapshot();
    if (!submitted) return;
    const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
    const plan = resolveComposerSendPlan({
      text: submitted.promptText,
      mentions: submitted.mentions,
      hasAttachments: attachments.length > 0,
    });
    if (plan.isNoOp) return;
    const typedSwitch =
      initialBotTarget && attachments.length === 0
        ? findSwitchTarget(plan.trimmed, mentionBotsRef.current)
        : undefined;
    if (typedSwitch && typedSwitch.id !== initialBotTarget) {
      openBotChat(typedSwitch, false);
      return;
    }
    preparingSend.current = true;
    try {
      await prepareUnsentSends();
    } catch (error) {
      Alert.alert(t("Failed to send message"), errorText(error));
      return;
    } finally {
      preparingSend.current = false;
    }
    if (
      !isCurrentTarget(initialBotTarget, initialGroupTarget) ||
      JSON.stringify(submitted) !== JSON.stringify(composerRef.current?.snapshot())
    )
      return;
    const reroutedToGroup = Boolean(
      plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
    );
    const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
    const botTarget = reroutedToGroup ? undefined : initialBotTarget;
    let attempt: SendAttempt;
    try {
      attempt = feedback.sendAttempt({
        originThreadKey: originThreadKey!,
        displayText: submitted.promptText,
        replyPreview: replyQuote ?? (replyTarget ? previewMessageText(replyTarget) : null),
        initialBotTarget,
        botTarget,
        groupTarget,
        reroutedToGroup,
        plan,
        attachments,
        replyTargetId: replyTarget?.id,
        replyQuote,
      });
    } catch (error) {
      Alert.alert(t("Failed to send message"), errorText(error));
      return;
    }
    composerRef.current?.reset();
    setPendingAttachments((current) =>
      current.filter((attachment) => !submitted.attachmentIds.includes(attachment.id)),
    );
    setReplyTarget(null);
    setReplyQuote(null);
    setAttachmentNotice(null);
    followOwnSend();
    await deliver(attempt);
  }

  async function deliver(attempt: SendAttempt, force = false) {
    if (!readOnly) await feedback.send(attempt, force);
  }

  function afterDelivered(attempt: SendAttempt) {
    const { initialBotTarget, botTarget, groupTarget, reroutedToGroup, plan } = attempt.payload;
    if (initialBotTarget) cancelFocusPrompt(initialBotTarget);
    const generation = currentSessionGeneration();
    const apiBase = currentApiBase();
    const spaceId = selectedSpaceId();
    void loadSessionToken()
      .then((token) => {
        if (
          generation === currentSessionGeneration() &&
          apiBase === currentApiBase() &&
          spaceId === selectedSpaceId()
        )
          return resumeLiveNotifications(apiBase, token, spaceId ?? "");
      })
      .catch(() => undefined);
    if (
      attempt.payload.originThreadKey !== (activeGroupId.current ?? activeBotId.current) ||
      !navigation.isFocused()
    )
      return;
    if (reroutedToGroup && groupTarget) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: groupTarget, name: plan.rerouteGroupName ?? t("Group") },
      });
      return;
    }
    if (isCurrentTarget(botTarget, groupTarget)) {
      if (pinnedAroundRef.current) showLatest();
      void refresh().catch(() => undefined);
    }
  }

  const afterDeliveredRef = useRef(afterDelivered);
  afterDeliveredRef.current = afterDelivered;
  useEffect(() => subscribeDelivered((attempt) => afterDeliveredRef.current(attempt)), []);

  async function stop() {
    if (readOnly) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    setSending(true);
    try {
      await rpc(
        "threads/stop",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      );
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        Alert.alert(t("Failed to stop work"), errorText(err, t("Try again.")));
      }
      setSending(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        const detail = errorText(err, t("Failed to refresh"));
        setError(t("Work stopped, but the thread could not refresh: {detail}", { detail }));
      }
    } finally {
      setSending(false);
    }
  }

  const answerMessage = useCallback(
    async (message: MobileMessage, answer: string, username?: string, dismiss?: boolean) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if (readOnly || (!targetBotId && !targetGroupId) || !message.runId) return;
      await rpc("threads/answer", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        runId: message.runId,
        messageId: message.id,
        answer,
        ...(username ? { username } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved once the server accepts it; a failed refresh only delays the card.
      if (isCurrentTarget(targetBotId, targetGroupId)) await refresh().catch(() => undefined);
    },
    [botId, groupId, readOnly],
  );

  const openBot = useCallback(
    (id: string, botName: string) =>
      router.push({ pathname: "/thread", params: { botId: id, name: botName } }),
    [router],
  );

  const openComputer = useCallback(
    (id: string, botName: string) =>
      router.push({ pathname: "/computer", params: { botId: id, name: botName } }),
    [router],
  );

  const speak = useCallback(
    (message: MobileMessage) => {
      const startIndex = visibleMessages.findIndex((candidate) => candidate.id === message.id);
      const fromHere = startIndex === -1 ? [message] : visibleMessages.slice(startIndex);
      const items = fromHere.flatMap((candidate) => {
        if (candidate.role !== "bot") return [];
        const text = speakableMessageText(candidate);
        if (!text) return [];
        const speakerBotId = candidate.botId ?? botId ?? snap?.members?.[0]?.botId ?? "";
        return [
          {
            text,
            botId: speakerBotId,
            messageId: candidate.id,
            speaker: {
              name: memberName(snap?.members, speakerBotId) ?? displayName,
              color: speakerColorFor(mentionBots, snap?.members, speakerBotId),
            },
          },
        ];
      });
      if (items.length === 0) return;
      void speakQueue(items)
        .then((spoken) => {
          if (!spoken)
            Alert.alert(t("Could not speak"), t("Add a voice provider in Voice settings."), [
              { text: t("Cancel"), style: "cancel" },
              { text: t("Open Voice"), onPress: () => router.push("/voice") },
            ]);
        })
        .catch((err: unknown) =>
          Alert.alert(t("Could not speak"), errorText(err, t("Try again."))),
        );
    },
    [botId, displayName, mentionBots, snap?.members, visibleMessages],
  );

  /** A bot the caller was put through to answers ("Max here. Hi Riley."); a fresh call opens with hello. */
  function callGreeting(botName: string, callerName: string | undefined, switchedHere: boolean) {
    if (switchedHere) {
      return callerName
        ? t("{bot} here. Hi {name}.", { bot: botName, name: callerName })
        : t("{bot} here.", { bot: botName });
    }
    return callerName
      ? t("Hello {name}, {bot} here.", { name: callerName, bot: botName })
      : t("Hello, {bot} here.", { bot: botName });
  }

  /** `switchedHere`: the caller asked another bot to put them through, so this bot answers. */
  async function startVoiceCall(switchedHere = false) {
    if (readOnly) return;
    const targetBotId = botId;
    if (!targetBotId || voiceCallStarting.current) return;
    voiceCallStarting.current = true;
    const loadVoiceStatus = () => rpc<{ ready: boolean; transcribe: boolean }>("voice/status");
    try {
      const [plan, callerName] = await Promise.all([
        resolveVoiceCallPlan({
          loadDeviceVoiceEnabled,
          dictationAvailable,
          loadVoiceStatus,
        }),
        loadCallCallerName(() => rpc<MobileMe>("me")),
      ]);
      if (activeBotId.current !== targetBotId) return;
      if (plan.kind === "settings") {
        router.push("/voice");
        return;
      }
      if (plan.kind === "dictation") {
        Alert.alert(
          t("Calls need transcription"),
          t("Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio."),
          [
            { text: t("Not now"), style: "cancel" },
            { text: t("Open Voice"), onPress: () => router.push("/voice") },
          ],
        );
        return;
      }
      const botName = displayName ?? t("Bot");
      const startedCallId = startCall({
        botId: targetBotId,
        botName,
        botColor: mentionBots.find((bot) => bot.id === targetBotId)?.color,
        transcribe: plan.transcribe,
        greeting: callGreeting(botName, callerName, switchedHere),
        switchBot: (text) => {
          const target = findSwitchTarget(text, mentionBotsRef.current);
          if (!target || target.id === targetBotId) return undefined;
          return { name: target.name, ring: () => openBotChat(target, true) };
        },
      });
      if (plan.kind === "device") {
        void probeProviderTranscribe(loadVoiceStatus)
          .then((enabled) => {
            if (enabled) setCallProviderTranscribe(true, startedCallId);
          })
          .catch(() => undefined);
      }
    } catch {
      if (activeBotId.current === targetBotId) router.push("/voice");
    } finally {
      voiceCallStarting.current = false;
    }
  }

  /** Opens another bot's chat in place of this one, ringing it when the switch came from a call. */
  function openBotChat(target: MobileBot, ring: boolean): void {
    if (ring) ringOnArrival(target.id);
    router.replace({ pathname: "/thread", params: { botId: target.id, name: target.name } });
  }

  useEffect(() => {
    if (botId && takeRingOnArrival(botId)) void startVoiceCall(true);
  }, [botId]);

  const attachActions: MenuAction[] = [
    { id: "library", title: t("Photo library"), image: "photo.on.rectangle" },
    { id: "camera", title: t("Camera"), image: "camera" },
    { id: "file", title: t("File"), image: "doc" },
  ];

  function attachFrom(source: string) {
    if (importingShare.current) return;
    if (source === "library") void addAttachments(pickFromLibrary);
    else if (source === "camera") void addAttachments(takePhoto);
    else if (source === "file") void addAttachments(pickDocuments);
  }

  async function addAttachments(
    picker: (
      existingCount: number,
      maxBytes: number,
    ) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length, attachmentMaxBytes(uploadConfig));
    if ((groupId ?? botId) !== targetKey) return;
    // Two drops can overlap, so the room left is settled against the draft as it
    // is now, not as it was when this read began.
    const room = Math.max(
      0,
      ATTACHMENT_MAX_COUNT - attachmentsForThread(pendingAttachmentsRef.current, targetKey).length,
    );
    const accepted = result.attachments.slice(0, room);
    if (accepted.length) {
      setPendingAttachments((current) => [
        ...current,
        ...accepted.map((attachment) => ({
          ...attachment,
          threadKey: targetKey,
        })),
      ]);
    }
    const skipped = [
      ...result.skipped,
      ...result.attachments.slice(room).map((attachment) => ({
        name: attachment.name,
        reason: attachmentCountSkipReason(),
      })),
    ];
    setAttachmentNotice(
      skipped.length
        ? t("Skipped {items}", {
            items: skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  useFileDrop(
    threadKey ?? null,
    ({ files, skipped }) => {
      void addAttachments((count, maxBytes) => readDroppedFiles(files, count, maxBytes, skipped));
    },
    {
      enabled: !readOnly && Boolean(groupId ?? botId),
      maxBytes: attachmentMaxBytes(uploadConfig),
      maxFiles: ATTACHMENT_MAX_COUNT,
    },
  );

  const answerableAskIds = useMemo(() => answerableAskMessageIds(snap), [snap]);
  const dismissableAskIds = useMemo(() => dismissableAskMessageIds(snap, userId), [snap, userId]);
  const runError = snap?.run?.status === "failed" ? (snap.run.error ?? null) : null;
  const normalizedRunError = useRunError(runError, false);
  const failedRunId = runError ? snap?.run?.id : null;
  useEffect(() => setRunErrorDetailsOpen(false), [failedRunId]);
  function openErrorConnection() {
    setRunErrorDetailsOpen(false);
    openModelSettings();
  }
  function openErrorModel() {
    setRunErrorDetailsOpen(false);
    router.push({
      pathname: "/bot-settings",
      params: { botId: snap?.run?.botId ?? botId ?? "", focus: "model" },
    });
  }
  const separatorIds = useMemo(() => timeSeparatorIds(visibleMessages), [visibleMessages]);
  const unreadDividerId = useMemo(
    () =>
      unreadDividerMessageId(
        visibleMessages,
        readBoundary?.visit === readVisit.current.visit ? readBoundary.seq : null,
        snap?.olderCursor ?? null,
      ),
    [visibleMessages, readBoundary, snap?.olderCursor, threadKey],
  );
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );
  // Group calls in reading order, then reverse for the inverted list.
  const liveItems = useMemo(() => groupVoiceChats(visibleMessages).reverse(), [visibleMessages]);
  const messagesById = useMemo(
    () => new Map((snap?.messages ?? []).map((message) => [message.id, message])),
    [snap?.messages],
  );
  const pinnedTarget = pinnedAroundRef.current;
  const showPinnedPage = Boolean(
    jumpScrollTarget.current ||
      (pinnedTarget &&
        ((pinnedTarget.botId && pinnedTarget.botId === botId) ||
          (pinnedTarget.groupId && pinnedTarget.groupId === groupId))),
  );
  const pinnedNewerCursor = showPinnedPage ? (pinnedTarget?.newerCursor ?? null) : null;

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scrollBehavior.current.onProgrammaticScroll();
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  function pinnedDistanceFromEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    return contentSize.height - layoutMeasurement.height - contentOffset.y;
  }

  function pinnedNearEnd() {
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    return viewport > 0 && content - viewport - offset <= 80;
  }

  function scrollPinnedTo(offset: number) {
    pinnedScroll.current?.scrollTo({ y: offset, animated: false });
    pinnedScrollMetrics.current.offset = offset;
  }

  function loadNewerNearEnd() {
    // Wait until the matched row has a real offset. Prefetching from the top
    // of the page changes the content size and lands back on an older reply.
    // A hit that is not drawn (filtered out of the transcript) must not hold
    // that wait, or newer pages never load.
    const targetId = jumpScrollTarget.current ?? pinnedAroundRef.current?.messageId;
    const targetDrawn =
      targetId != null &&
      threadWindowMessages(visibleMessages, pinnedNewerCursor).some(
        (message) => message.id === targetId,
      );
    if (jumpAnchor.current.holds() && !targetDrawn) {
      jumpAnchor.current.release();
      jumpScrollTarget.current = null;
    } else if (jumpAnchor.current.blocksPaging(targetDrawn, headerClearance.anchor)) {
      return;
    }
    const { offset, viewport, content } = pinnedScrollMetrics.current;
    // Fetch the next page while a screen of this one is still left to read; a page shorter
    // than the screen never scrolls, so layout and content changes check too.
    if (viewport > 0 && content - viewport - offset < viewport) void loadNewerMessages();
  }

  function updatePinnedScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Once the page reaches the latest message, the end of it is the live thread.
    if (
      pinnedNewerCursor === null &&
      !jumpScrollTarget.current &&
      pinnedDistanceFromEnd(event) <= 80
    ) {
      showLatest();
    }
  }

  function scheduleScrollIdle() {
    clearTimeout(scrollIdleTimer.current);
    // Every scroll event renews the fallback. Native momentum gets a longer
    // grace period, but a missing momentum-end must still recover after silence.
    scrollIdleTimer.current = setTimeout(
      () => {
        nativeMomentumActive.current = false;
        performScroll(scrollBehavior.current.onUserMomentumEnd());
        publishThreadScrollState(scrollBehavior.current.state());
      },
      nativeMomentumActive.current ? 1000 : 200,
    );
  }

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    scheduleScrollIdle();
    const previous = scrollBehavior.current.state();
    const next = scrollBehavior.current.onUserScroll(event.nativeEvent.contentOffset.y);
    if (reconcileThreadScrollState(previous, next) !== previous) publishThreadScrollState(next);
  }

  async function reactToMessage(message: MobileMessage, reaction: MessageReaction) {
    if (readOnly) return false;
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return false;
    try {
      const result = await rpc<{ ok: true; runIds?: string[] }>("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        reaction,
        clientNonce: newClientNonce(),
      });
      if (result.runIds?.length && isCurrentTarget(targetBotId, targetGroupId)) {
        // The reaction is saved; a failed refresh is caught up by live events.
        await refresh().catch(() => {});
      }
      return true;
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return false;
      Alert.alert(t("Could not update reaction"), errorText(err, t("Try again.")));
      return false;
    }
  }

  // Event actions read the latest committed screen state without invalidating settled rows.
  const currentRowActions: MessageRowActions = {
    helperToggle: (measure, toggle, opening) => {
      if (Platform.OS !== "ios") {
        toggle();
        return;
      }
      measure((before) => {
        const correct = () => {
          requestAnimationFrame(() =>
            measure((after, cardBottom) => {
              helperViewport.current?.measureInWindow((_x, y, _width, height) => {
                const target = opening
                  ? helperOpenTarget({
                      headerY: before,
                      cardBottom: cardBottom + before - after,
                      topLimit: headerClearance.anchor,
                      visibleBottom: y + height - (readOnly ? insets.bottom : 0),
                    })
                  : before;
                if (showPinnedPage) {
                  pinnedScroll.current?.scrollTo({
                    y: helperHeaderOffset(pinnedScrollMetrics.current.offset, after, target),
                    animated: false,
                  });
                } else {
                  const offset = helperHeaderOffset(helperScrollOffset.current, target, after);
                  scroll.current?.scrollToOffset({ offset, animated: false });
                  // The settled list ignores this scroll's event, so record where it now sits.
                  helperScrollOffset.current = offset;
                  const previous = scrollBehavior.current.state();
                  const next = scrollBehavior.current.onUserScroll(offset);
                  if (reconcileThreadScrollState(previous, next) !== previous) {
                    publishThreadScrollState(next);
                  }
                }
              });
            }),
          );
        };
        helperResize.current = correct;
        toggle();
        // A helper without a body may not change the list's content size.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (helperResize.current === correct) {
              helperResize.current = null;
              correct();
            }
          }),
        );
      });
    },
    reply: (message) => {
      setReplyTarget(message);
      setReplyQuote(null);
    },
    quote: setQuoteTarget,
    select: setSelectableText,
    speak,
    react: (message, reaction) => reactToMessage(message, reaction),
    markUnread: markUnreadFrom,
    answer: answerMessage,
    openBot,
    openComputer,
    previewMarkdown: setMarkdownPreview,
    previewImage: (target) =>
      router.push({
        pathname: "/image",
        params: { ...target, ...(groupId ? { groupId } : { botId }) },
      }),
    jump: (messageId) => {
      void applyMessageJump({ botId, groupId, messageId }).catch(() => undefined);
    },
    dismissChoice: (messageId, question) => {
      setDismissedChoiceQuestions((current) => {
        const existing = current.get(messageId);
        if (existing?.has(question)) return current;
        const next = new Map(current);
        const questions = new Set(existing);
        questions.add(question);
        next.set(messageId, questions);
        return next;
      });
    },
    openPeerChat: (peer) => {
      if (!botId) return;
      router.push({
        pathname: "/peer-chat",
        params: { botId, botName: displayName, ...peer },
      });
    },
    togglePeerReplies: (markerId) => {
      setExpandedPeerMarkers((expanded) => {
        const next = new Set(expanded);
        if (!next.delete(markerId)) next.add(markerId);
        return next;
      });
    },
    layout: (messageId, y, index) => {
      const offset = jumpAnchor.current.onMessageLayout(
        messageId,
        y,
        index,
        headerClearance.anchor,
      );
      if (offset == null) return;
      scrollPinnedTo(offset);
      setHighlightedMessageId(messageId);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightedMessageId(null), 1200);
      requestAnimationFrame(() => {
        const again = jumpAnchor.current.align(headerClearance.anchor);
        if (again != null) scrollPinnedTo(again);
      });
    },
  };
  const rowActionsRef = useRef(currentRowActions);
  useLayoutEffect(() => {
    rowActionsRef.current = currentRowActions;
  });
  const rowActions = useMemo<MessageRowActions>(
    () => ({
      helperToggle: (measure, toggle, opening) =>
        rowActionsRef.current.helperToggle(measure, toggle, opening),
      reply: (message) => rowActionsRef.current.reply(message),
      quote: (message) => rowActionsRef.current.quote(message),
      select: (text) => rowActionsRef.current.select(text),
      speak: (message) => rowActionsRef.current.speak(message),
      react: (message, reaction) => rowActionsRef.current.react(message, reaction),
      markUnread: (message) => rowActionsRef.current.markUnread(message),
      answer: (message, answer, username, dismiss) =>
        rowActionsRef.current.answer(message, answer, username, dismiss),
      openBot: (id, name) => rowActionsRef.current.openBot(id, name),
      openComputer: (id, name) => rowActionsRef.current.openComputer(id, name),
      previewMarkdown: (target) => rowActionsRef.current.previewMarkdown(target),
      previewImage: (target) => rowActionsRef.current.previewImage(target),
      jump: (id) => rowActionsRef.current.jump(id),
      dismissChoice: (id, question) => rowActionsRef.current.dismissChoice(id, question),
      togglePeerReplies: (id) => rowActionsRef.current.togglePeerReplies(id),
      openPeerChat: (peer) => rowActionsRef.current.openPeerChat(peer),
      layout: (id, y, index) => rowActionsRef.current.layout(id, y, index),
    }),
    [],
  );

  const renderMessageRow = useCallback(
    (message: MobileMessage, options?: { enableJump?: boolean; index?: number }) => {
      const parent = message.replyToMessageId
        ? messagesById.get(message.replyToMessageId)
        : undefined;
      const replyBotId = message.replyPreview?.botId ?? parent?.botId;
      const replyAuthor =
        (message.replyPreview?.role ?? parent?.role) === "user"
          ? t("You")
          : (memberName(snap?.members, replyBotId) ??
            mentionBots.find((bot) => bot.id === replyBotId)?.name ??
            displayName ??
            t("Bot"));
      const messageReactions = reactionView.reactions.get(message.id);
      const activityBotId =
        !inGroup && message.role === "bot" && message.id.startsWith("progress:")
          ? (message.botId ?? botId)
          : undefined;
      const activityBot = activityBotId
        ? (snap?.members?.find((member) => member.botId === activityBotId) ??
          (currentBot?.id === activityBotId ? currentBot : undefined))
        : undefined;
      const activityStatus = activityBotId
        ? (snap?.activeRuns?.find((run) => run.botId === activityBotId)?.status ??
          (snap?.run?.botId === activityBotId ? snap.run.status : currentBotStatus))
        : undefined;
      return (
        <MessageRow
          key={message.id}
          message={message}
          actions={rowActions}
          botId={botId}
          bubbleBotId={botId ?? snap?.members?.[0]?.botId ?? ""}
          groupId={groupId}
          botName={displayName}
          showBotSenderName={showBotSenderName}
          bots={mentionBots}
          members={snap?.members}
          readOnly={readOnly}
          onCall={onCall}
          canAnswer={!readOnly && answerableAskIds.has(message.id)}
          canDismiss={dismissableAskIds.has(message.id)}
          highlighted={highlightedMessageId === message.id}
          separator={separatorIds.has(message.id)}
          headerAdjacent={threadHeaderFloats() && message.id === visibleMessages[0]?.id}
          unreadDivider={message.id === unreadDividerId}
          replyAuthor={replyAuthor}
          replyFallbackText={parent ? previewMessageText(parent) : undefined}
          waitingForUser={[...(snap?.activeRuns ?? []), ...(snap?.run ? [snap.run] : [])].some(
            (run) =>
              run.id === message.runId &&
              (run.status === "waiting_input" || run.status === "waiting_takeover"),
          )}
          messageReactions={messageReactions}
          peerReplies={
            peerTranscript.folded.has(message.id)
              ? expandedPeerMarkers.has(message.id)
                ? "expanded"
                : "collapsed"
              : undefined
          }
          activityBotId={activityBotId}
          activityColor={activityBot?.color}
          activityStatus={activityStatus}
          userBubble={userBubble}
          inGroup={inGroup}
          columnWidth={columnWidth}
          enableJump={options?.enableJump ?? false}
          index={options?.index ?? 0}
        />
      );
    },
    [
      messagesById,
      showBotSenderName,
      snap?.members,
      snap?.activeRuns,
      snap?.run,
      mentionBots,
      displayName,
      reactionView.reactions,
      peerTranscript,
      expandedPeerMarkers,
      inGroup,
      botId,
      groupId,
      currentBot,
      currentBotStatus,
      userBubble,
      rowActions,
      readOnly,
      onCall,
      answerableAskIds,
      dismissableAskIds,
      highlightedMessageId,
      separatorIds,
      visibleMessages[0]?.id,
      unreadDividerId,
      columnWidth,
      t,
      locale,
    ],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ThreadItem<MobileMessage>>) =>
      item.kind === "voiceChat" ? (
        <View
          style={[
            messageListStyles.row,
            threadHeaderFloats() && item.messages[0]?.id === visibleMessages[0]?.id
              ? { marginTop: 0 }
              : undefined,
          ]}
        >
          {item.messages[0] && separatorIds.has(item.messages[0].id) ? (
            <TimeSeparator createdAt={item.messages[0].createdAt} />
          ) : null}
          {voiceChatHoldsMessage(item, unreadDividerId) ? (
            <UnreadDivider
              afterSeparator={Boolean(item.messages[0] && separatorIds.has(item.messages[0].id))}
            />
          ) : null}
          <VoiceChatCard group={item} />
        </View>
      ) : (
        renderMessageRow(item.message)
      ),
    [renderMessageRow, separatorIds, unreadDividerId, visibleMessages[0]?.id],
  );
  const listContentStyle = useMemo(
    () => ({
      paddingBottom: headerClearance.padding,
      paddingTop: readOnly ? insets.bottom + 16 : 16,
    }),
    [headerClearance.padding, readOnly, insets.bottom],
  );

  const workingFooter =
    !inGroup && currentBot && isRunWorking(currentBotStatus) && !hasLiveProgress ? (
      <View
        accessibilityLabel={t("{name} is working", { name: currentBot.name })}
        accessibilityRole="text"
        style={{ minHeight: 40, marginTop: 12, justifyContent: "center" }}
      >
        <ActivityMark
          bots={[
            {
              id: currentBot.id,
              color: currentBot.color,
              status: currentBotStatus,
              composing: composingBots.split(",").includes(currentBot.id),
            },
          ]}
          atBottom={!threadScrollState.detached}
          label={activityLine ?? t("Working…")}
        />
      </View>
    ) : inGroup && workingGroupBots.length > 0 ? (
      <View
        accessibilityLabel={
          workingGroupBots.length === 1
            ? t("{name} is working", { name: workingGroupBots[0]?.name ?? t("Agent") })
            : t("{count} agents working", { count: workingGroupBots.length })
        }
        accessibilityRole="text"
        style={{ minHeight: 40, marginTop: 12, justifyContent: "center" }}
      >
        <ActivityMark
          bots={workingGroupBots.map((bot) => ({
            id: bot.botId,
            color: bot.color,
            status: bot.status,
            composing: composingBots.split(",").includes(bot.botId),
          }))}
          atBottom={!threadScrollState.detached}
          label={activityLine ?? t("Working…")}
        />
      </View>
    ) : null;

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <Pressable
        disabled={loadingOlder}
        onPress={() => void loadOlderMessages()}
        style={{
          alignSelf: "center",
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        {loadingOlder ? (
          <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
        ) : null}
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {t("Load earlier messages")}
        </Text>
      </Pressable>
    ) : null;

  const failedSendBubbles = feedback.unsentSends.map((attempt) => (
    <FailedSendBubble
      key={attempt.clientNonce}
      attempt={attempt}
      needsModel={needsModel}
      onRetry={() => {
        followOwnSend();
        void deliver(attempt, true);
      }}
      onDelete={() => feedback.discard(attempt)}
      userBubble={userBubble}
    />
  ));

  // Fetch failures stay visible at either paging edge; provider recovery belongs to the live end.
  const visibleRunError = showPinnedPage && pinnedNewerCursor !== null ? null : normalizedRunError;
  const errorNotice = (
    <ThreadErrorNotice
      error={null}
      summary={visibleRunError?.summary ?? null}
      resetAt={visibleRunError?.resetAt}
      onDetails={() => setRunErrorDetailsOpen(true)}
      onConnection={visibleRunError?.recovery === "connection" ? openErrorConnection : undefined}
      onModel={
        visibleRunError?.recovery && (snap?.run?.botId ?? botId) ? openErrorModel : undefined
      }
    />
  );

  const fetchErrorNotice = error ? (
    <View style={{ paddingBottom: 24 }}>
      <ThreadErrorNotice
        error={showingSaved ? t("Couldn't refresh — showing the last loaded messages.") : error}
        summary={null}
      />
    </View>
  ) : null;

  return (
    <View ref={keyboardLayout.container} onLayout={keyboardLayout.onLayout} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        // Padding always settles to zero. "height" stays shrunk when the keyboard hides without
        // move frames, such as when a pushed screen closes with its own keyboard up.
        behavior="padding"
        keyboardVerticalOffset={threadKeyboardOffset({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight,
          measuredOffset: keyboardLayout.offset,
        })}
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          paddingLeft: 20 + columnInsets.left,
          paddingRight: 20 + columnInsets.right,
        }}
      >
        {/* The floor keeps a tall suggestion list from sliding under the transparent header. */}
        <View
          ref={helperViewport}
          collapsable={false}
          style={{ flex: 1, minHeight: headerClearance.minHeight, position: "relative" }}
        >
          {showPinnedPage ? (
            <ThreadScrollSurface
              key={`pinned:${jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}`}
            >
              <ScrollView
                key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
                ref={pinnedScroll}
                style={{ flex: 1 }}
                // A pinned page always shows the floating jump button (44pt, 12pt from the
                // bottom), so its last message must be able to scroll clear of it.
                contentContainerStyle={{
                  paddingTop: headerClearance.padding,
                  paddingBottom: 12 + 44 + 16,
                }}
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                maintainVisibleContentPosition={messageListPosition}
                scrollEventThrottle={16}
                onLayout={(event) => {
                  pinnedScrollMetrics.current.viewport = event.nativeEvent.layout.height;
                  loadNewerNearEnd();
                }}
                onContentSizeChange={(_, height) => {
                  pinnedScrollMetrics.current.content = height;
                  const correctHelper = helperResize.current;
                  if (correctHelper) {
                    helperResize.current = null;
                    correctHelper();
                    return;
                  }
                  const jumpOffset = jumpAnchor.current.align(headerClearance.anchor);
                  if (jumpOffset != null) scrollPinnedTo(jumpOffset);
                  const armedAt = joinPinnedAfterLayout.current;
                  if (armedAt != null && height !== armedAt) {
                    joinPinnedAfterLayout.current = null;
                    if (
                      !jumpAnchor.current.holds() &&
                      pinnedAroundRef.current?.newerCursor == null &&
                      pinnedNearEnd()
                    ) {
                      showLatest();
                      return;
                    }
                  }
                  loadNewerNearEnd();
                }}
                onScroll={(event) => {
                  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                  pinnedScrollMetrics.current = {
                    offset: contentOffset.y,
                    viewport: layoutMeasurement.height,
                    content: contentSize.height,
                  };
                  if (
                    pinnedScrollBack.current.onScroll(event.nativeEvent) &&
                    Platform.OS === "ios"
                  ) {
                    KeyboardController.dismiss();
                  }
                  loadNewerNearEnd();
                }}
                onScrollBeginDrag={(event) => {
                  pinnedScrollBack.current.onDragStart(event.nativeEvent);
                  newerLoadFailed.current = false;
                  if (!jumpAnchor.current.holds()) return;
                  jumpAnchor.current.release();
                  jumpScrollTarget.current = null;
                }}
                onScrollEndDrag={(event) => {
                  pinnedScrollBack.current.onDragEnd();
                  updatePinnedScroll(event);
                }}
                onMomentumScrollEnd={updatePinnedScroll}
              >
                {loadEarlierControl}
                {threadWindowMessages(visibleMessages, pinnedNewerCursor).map((message, index) =>
                  renderMessageRow(message, { enableJump: true, index }),
                )}
                {pinnedNewerCursor === null ? failedSendBubbles : null}
                {errorNotice}
                {pinnedNewerCursor === null ? (
                  workingFooter
                ) : loadingNewer ? (
                  <ActivityIndicator
                    color={tokens.mutedForeground}
                    style={{ marginVertical: 12 }}
                  />
                ) : null}
              </ScrollView>
            </ThreadScrollSurface>
          ) : (
            <ThreadScrollSurface key={`live:${threadKey}`}>
              <FlatList
                key={threadKey}
                ref={scroll}
                data={liveItems}
                inverted
                keyExtractor={threadItemKey}
                // This callback tracks every row input, including reply, reaction and highlight state.
                extraData={renderMessageRow}
                style={messageListStyles.list}
                // Swiping down hides the keyboard; on iOS it follows the finger.
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                // Inverted, so the bottom padding is the visual top, clear of the transparent header.
                contentContainerStyle={listContentStyle}
                // Follow changes to the recovery card while already at the newest content.
                maintainVisibleContentPosition={liveMessageListPosition}
                scrollEventThrottle={16}
                onScrollBeginDrag={(event) => {
                  clearTimeout(scrollIdleTimer.current);
                  nativeMomentumActive.current = false;
                  scrollBehavior.current.onUserDragStart();
                  liveScrollBack.current.onDragStart(event.nativeEvent);
                }}
                onScroll={(event) => {
                  helperScrollOffset.current = event.nativeEvent.contentOffset.y;
                  if (liveScrollBack.current.onScroll(event.nativeEvent) && Platform.OS === "ios") {
                    KeyboardController.dismiss();
                  }
                  if (scrollBehavior.current.isTrackingUserScroll()) updateUserScroll(event);
                }}
                // Keep tracking after release: a fling can cross the threshold mid-momentum.
                onScrollEndDrag={(event) => {
                  if (scrollBehavior.current.isTrackingUserScroll()) updateUserScroll(event);
                  scrollBehavior.current.onUserDragEnd();
                  liveScrollBack.current.onDragEnd();
                  scheduleScrollIdle();
                }}
                onMomentumScrollBegin={() => {
                  nativeMomentumActive.current = true;
                  scheduleScrollIdle();
                }}
                onMomentumScrollEnd={(event) => {
                  nativeMomentumActive.current = false;
                  if (scrollBehavior.current.isTrackingUserScroll()) updateUserScroll(event);
                  clearTimeout(scrollIdleTimer.current);
                  performScroll(scrollBehavior.current.onUserMomentumEnd());
                  publishThreadScrollState(scrollBehavior.current.state());
                }}
                onLayout={(event) => {
                  performScroll(scrollBehavior.current.onLayout(event.nativeEvent.layout.height));
                  publishThreadScrollState(scrollBehavior.current.state());
                }}
                onContentSizeChange={(_, height) => {
                  const correctHelper = helperResize.current;
                  if (correctHelper) {
                    helperResize.current = null;
                    publishThreadScrollState(scrollBehavior.current.onContentSizeChanged(height));
                    correctHelper();
                    return;
                  }
                  publishThreadScrollState(scrollBehavior.current.onContentSizeChanged(height));
                  if (loadingOlderContent.current) {
                    loadingOlderContent.current = false;
                    return;
                  }
                  const blocked = Boolean(
                    jumpScrollTarget.current ||
                      (pinnedAroundRef.current &&
                        ((pinnedAroundRef.current.botId &&
                          pinnedAroundRef.current.botId === botId) ||
                          (pinnedAroundRef.current.groupId &&
                            pinnedAroundRef.current.groupId === groupId))) ||
                      expandedHistoryThread.current === snap?.threadId,
                  );
                  performScroll(
                    scrollBehavior.current.onContentChanged(
                      blocked,
                      latestThreadRowKey(
                        latestMessageId,
                        feedback.unsentSends.map((attempt) => attempt.clientNonce),
                        isOwnThreadMessage(latestMessage, userId),
                      ),
                    ),
                  );
                  publishThreadScrollState(scrollBehavior.current.state());
                }}
                ListFooterComponent={loadEarlierControl}
                ListHeaderComponent={
                  <View onLayout={() => performScroll(scrollBehavior.current.onLayout())}>
                    {errorNotice}
                    {failedSendBubbles}
                    {workingFooter}
                  </View>
                }
                renderItem={renderItem}
              />
            </ThreadScrollSurface>
          )}
          {showPinnedPage || threadScrollState.detached ? (
            <View style={{ position: "absolute", end: 0, bottom: 12 }}>
              <ScrollToBottomButton
                accessibilityLabel={
                  threadScrollState.unread ? t("Jump to latest, new messages") : t("Jump to latest")
                }
                onPress={() => {
                  if (showPinnedPage) {
                    showLatest();
                    return;
                  }
                  performScroll(scrollBehavior.current.jumpToLatest());
                  publishThreadScrollState(scrollBehavior.current.state());
                }}
              />
              {threadScrollState.unread ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 3,
                    end: 3,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.primary,
                  }}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        {fetchErrorNotice}
        {/* Shrinks (the suggestion lists scroll) so the input and Send stay above the keyboard. */}
        <Animated.View
          style={[{ display: readOnly ? "none" : "flex", flexShrink: 1 }, composerKeyboardPadding]}
        >
          {/* Fades messages out immediately above the composer. */}
          <View pointerEvents="none" style={styles.composerFade} />
          {replyTarget ? (
            <GlassSurface
              style={{
                marginTop: 12,
                borderRadius: 999,
                paddingStart: 16,
                paddingEnd: 10,
                paddingVertical: 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
              fallbackStyle={{
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.glassStroke,
                backgroundColor: tokens.glassFill,
                paddingStart: 12,
                paddingEnd: 12,
                paddingVertical: 10,
              }}
            >
              <ComposerReplyPreview
                author={
                  replyTarget.role === "user"
                    ? t("You")
                    : (memberName(snap?.members, replyTarget.botId) ?? displayName ?? t("Bot"))
                }
                quote={replyQuote}
                text={previewMessageText(replyTarget)}
                attachment={replyAttachment(replyTarget.blocks)}
                threadTarget={artifactTarget}
              />
              <ReplyDismissButton
                onPress={() => {
                  setReplyTarget(null);
                  setReplyQuote(null);
                }}
              />
            </GlassSurface>
          ) : null}
          {attachmentNotice ? (
            <Text style={{ color: tokens.warning, marginTop: 12, fontSize: 13 }}>
              {attachmentNotice}
            </Text>
          ) : null}
          {activePendingAttachments.length ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 12,
              }}
            >
              {activePendingAttachments.map((attachment) => (
                <View
                  key={attachment.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: tokens.border,
                    backgroundColor: tokens.card,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  {attachment.previewUri ? (
                    <Image
                      source={{ uri: attachment.previewUri }}
                      style={{ width: 28, height: 28, borderRadius: 6 }}
                    />
                  ) : (
                    <NativeSymbol
                      ios="paperclip"
                      android="attach"
                      size={16}
                      color={tokens.mutedForeground}
                    />
                  )}
                  <Text style={{ color: tokens.foreground, maxWidth: 140 }} numberOfLines={1}>
                    {attachment.name}
                  </Text>
                  <Pressable
                    accessibilityLabel={t("Remove {name}", { name: attachment.name })}
                    onPress={() =>
                      setPendingAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                  >
                    <NativeSymbol
                      ios="xmark"
                      android="close"
                      size={14}
                      color={tokens.mutedForeground}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          <ThreadComposer
            onFocus={keyboardLayout.onFocus}
            key={threadKey}
            ref={composerRef}
            agentSkills={agentSkills}
            composerMentionTargets={composerMentionTargets}
            composerPrompt={composerPrompt}
            replyTargetId={replyTarget?.id}
            replyQuote={replyQuote}
            attachmentIds={activePendingAttachments.map((attachment) => attachment.id)}
            botId={botId}
            onCall={onCall}
            working={working}
            sending={sending || shareImporting}
            styles={styles}
            attachActions={attachActions}
            attachFrom={attachFrom}
            send={send}
            stop={stop}
            startVoiceCall={startVoiceCall}
            onSlashAction={runSlashAction}
          />
        </Animated.View>
        {botActionsOpen ? (
          <Modal
            visible
            transparent
            animationType="fade"
            onRequestClose={() => setBotActionsOpen(false)}
          >
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                padding: 24,
                backgroundColor: tokens.overlay,
              }}
            >
              <Pressable
                accessibilityLabel={t("Cancel")}
                onPress={() => setBotActionsOpen(false)}
                style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
              />
              <View
                accessibilityViewIsModal
                style={{ backgroundColor: tokens.popover, borderRadius: 24, paddingVertical: 12 }}
              >
                {botActions.map((action) => (
                  <Pressable
                    key={action.text}
                    accessibilityRole="button"
                    onPress={() => {
                      setBotActionsOpen(false);
                      action.onPress();
                    }}
                    style={{ minHeight: 56, justifyContent: "center", paddingHorizontal: 24 }}
                  >
                    <Text
                      style={{
                        color: action.destructive ? tokens.destructive : tokens.popoverForeground,
                        fontSize: 16,
                      }}
                    >
                      {action.text}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </Modal>
        ) : null}
        {selectableText !== null ? (
          <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
        ) : null}
        <RunErrorSheet
          details={runErrorDetailsOpen ? runError : null}
          onClose={() => setRunErrorDetailsOpen(false)}
          onConnection={openErrorConnection}
          onModel={(snap?.run?.botId ?? botId) ? openErrorModel : undefined}
        />
        {markdownPreview && artifactTarget ? (
          <MarkdownArtifactPreview
            threadTarget={artifactTarget}
            target={markdownPreview}
            onClose={() => setMarkdownPreview(null)}
          />
        ) : null}
        {quoteTarget ? (
          <QuoteSheet
            message={quoteTarget}
            onCancel={() => setQuoteTarget(null)}
            onQuote={(excerpt) => {
              setReplyTarget(quoteTarget);
              setReplyQuote(excerpt);
              setQuoteTarget(null);
            }}
          />
        ) : null}
        {headerHeight > 0 ? (
          <View
            pointerEvents="none"
            style={[styles.headerFade, { height: headerClearance.opaqueHeight }]}
          >
            <View style={styles.headerFadeEdge} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

function QuoteSheet({
  message,
  onCancel,
  onQuote,
}: {
  message: MobileMessage;
  onCancel: () => void;
  onQuote: (excerpt: string) => void;
}) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const segments = useMemo(() => quotableMessageSegments(message.role, message.blocks), [message]);
  const [selection, setSelection] = useState<{
    segment: number;
    start: number;
    end: number;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const selectedText = selection === null ? undefined : segments[selection.segment];
  const start = selection ? Math.min(selection.start, selection.end) : 0;
  const end = selection ? Math.max(selection.start, selection.end) : 0;
  const excerpt =
    selectedText === undefined ? "" : truncateQuoteExcerpt(selectedText.slice(start, end).trim());

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 12,
          }}
        >
          <NativeActionButton label={t("Cancel")} onPress={onCancel} prominence="plain" />
          <NativeActionButton
            disabled={!excerpt}
            fill={false}
            label={t("Quote")}
            onPress={() => onQuote(excerpt)}
            prominence={excerpt ? "primary" : "plain"}
          />
        </View>
        <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
          {segments.map((text, index) => (
            <TextInput
              key={`${index}:${revision}`}
              multiline
              scrollEnabled={false}
              showSoftInputOnFocus={false}
              value={text}
              // Any edit (paste, hardware keyboard, dictation) remounts the
              // field with the source text — the excerpt slices the original,
              // so the displayed text must never diverge from it.
              onChangeText={() => setRevision((value) => value + 1)}
              style={{
                color: tokens.foreground,
                ...typeScale.body,
                padding: 0,
                marginTop: index === 0 ? 0 : 12,
                textAlignVertical: "top",
              }}
              onSelectionChange={(event) => {
                const range = event.nativeEvent.selection;
                // A collapsed caret (tap, focus change, the Quote press
                // itself) keeps the last real span armed.
                if (range.start === range.end) return;
                setSelection({ segment: index, ...range });
              }}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      if (block.kind === "text" && block.text) {
        // Bot text is Markdown; user text is already plain.
        return [message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text];
      }
      return [];
    })
    .join(" ")
    .trim();
  if (text) return text;
  const attachment = replyAttachment(message.blocks);
  if (attachment)
    return attachment.kind === "image" ? t("Photo") : attachment.name || t("Attachment");
  return t("Message");
}

function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

/** Each bot keeps one identity color across web and mobile — same lookup as the avatar. */
function speakerColorFor(
  bots: MobileBot[],
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId) return undefined;
  const raw =
    bots.find((bot) => bot.id === botId)?.color ??
    members?.find((member) => member.botId === botId)?.color;
  return resolvePersonaColorDef(botId, raw).light;
}

type MessageActionProps = Pick<
  TextProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
>;

const messageListStyles = StyleSheet.create({
  list: { flex: 1 },
  row: { marginTop: 12, width: "100%" },
});
const messageListPosition = { minIndexForVisible: 0 };
const liveMessageListPosition = { ...messageListPosition, autoscrollToTopThreshold: 80 };
function threadItemKey(item: ThreadItem<MobileMessage>) {
  return item.kind === "voiceChat" ? item.key : item.message.id;
}

type MessageRowActions = {
  helperToggle: (
    measure: (done: (y: number, cardBottom: number) => void) => void,
    toggle: () => void,
    opening: boolean,
  ) => void;
  reply: (message: MobileMessage) => void;
  quote: (message: MobileMessage) => void;
  select: (text: string) => void;
  speak: (message: MobileMessage) => void;
  react: (message: MobileMessage, reaction: MessageReaction) => Promise<boolean>;
  markUnread: (message: MobileMessage) => void;
  answer: (
    message: MobileMessage,
    answer: string,
    username?: string,
    dismiss?: boolean,
  ) => Promise<void>;
  openBot: (id: string, name: string) => void;
  openComputer: (id: string, name: string) => void;
  previewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  previewImage: (target: ImageArtifactPreviewTarget) => void;
  jump: (messageId: string) => void;
  dismissChoice: (messageId: string, question: string) => void;
  togglePeerReplies: (markerId: string) => void;
  openPeerChat: (peer: { peerBotId: string; peerBotName: string }) => void;
  layout: (messageId: string, y: number, index: number) => void;
};

type MessageRowProps = {
  message: MobileMessage;
  actions: MessageRowActions;
  botId?: string;
  bubbleBotId: string;
  groupId?: string;
  botName?: string;
  showBotSenderName: boolean;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  readOnly: boolean;
  onCall: boolean;
  canAnswer: boolean;
  canDismiss: boolean;
  highlighted: boolean;
  separator: boolean;
  headerAdjacent: boolean;
  unreadDivider: boolean;
  replyAuthor: string;
  replyFallbackText?: string;
  waitingForUser: boolean;
  messageReactions?: ReadonlyMap<MessageReaction, number>;
  /** Set on a received marker whose peer run has folded replies. */
  peerReplies?: "collapsed" | "expanded";
  activityBotId?: string;
  activityColor?: string;
  activityStatus?: MobileBot["status"];
  userBubble?: UserBubble;
  inGroup: boolean;
  columnWidth: number;
  enableJump: boolean;
  index: number;
};

function isWideAskBlock(blocks: MobileMessage["blocks"]) {
  return blocks.some(isSecretAskBlock);
}

// Connect cards fill the bubble width instead of shrinking to their button.
function hasAppConnectBlock(blocks: MobileMessage["blocks"]) {
  return blocks.some((block) => block.kind === "app_connect");
}

const MessageRow = memo(function MessageRow({
  message,
  actions,
  botId,
  bubbleBotId,
  groupId,
  botName,
  showBotSenderName,
  bots,
  members,
  readOnly,
  onCall,
  canAnswer,
  canDismiss,
  highlighted,
  separator,
  headerAdjacent,
  unreadDivider,
  replyAuthor,
  replyFallbackText,
  messageReactions,
  waitingForUser,
  peerReplies,
  activityBotId,
  activityColor,
  activityStatus,
  userBubble,
  inGroup,
  columnWidth,
  enableJump,
  index,
}: MessageRowProps) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t, locale } = useI18n();
  const artifactTarget = useMemo<MobileArtifactTarget | undefined>(
    () => (groupId ? { groupId } : botId ? { botId } : undefined),
    [botId, groupId],
  );
  const onChoiceDismissed = useCallback(
    (question: string) => actions.dismissChoice(message.id, question),
    [actions, message.id],
  );
  const onLayout = useMemo(
    () =>
      enableJump
        ? (event: LayoutChangeEvent) =>
            actions.layout(message.id, event.nativeEvent.layout.y, index)
        : undefined,
    [actions, message.id, enableJump, index],
  );
  const [optimisticLike, setOptimisticLike] = useState(false);
  const likeInFlight = useRef(false);
  const reducedMotion = useReducedMotion();
  const hasLike = messageReactions?.has("👍") ?? false;
  useEffect(() => {
    if (hasLike) setOptimisticLike(false);
  }, [hasLike]);
  const displayedReactions = new Map(messageReactions);
  if (optimisticLike && !hasLike) displayedReactions.set("👍", 1);
  const { actionProps, menu, onMenuAction, likeMessage } = useMemo<{
    actionProps: MessageActionProps;
    menu: ReturnType<typeof buildMessageContextMenu>;
    onMenuAction: (id: string) => void;
    likeMessage?: () => void;
  }>(() => {
    const messageText = selectableMobileMessageText(message);
    const includeQuote =
      !readOnly &&
      !message.id.startsWith("progress:") &&
      quotableMessageSegments(message.role, message.blocks).length > 0;
    const includeReact = !readOnly && canReactToThreadMessage(message);
    // The call already reads replies aloud; a second voice would talk over it.
    const includeSpeak = message.role === "bot" && !onCall && Boolean(blockText(message));
    const includeSelect = messageText.trim().length > 0;
    // Any sent message can be marked unread; the next open starts New at the first reply from it.
    const includeUnread = !readOnly && canMarkMessageUnread(message);
    const reply = () => actions.reply(message);
    const quote = () => actions.quote(message);
    const speakMessage = () => actions.speak(message);
    const select = () =>
      actions.select(
        message.role === "user" ? messageText : selectableTextFromMarkdown(messageText),
      );
    const copy = () => {
      const text = copyableMobileMessageText(message);
      if (text) void Clipboard.setStringAsync(text).catch(() => undefined);
    };
    const react = (reaction: MessageReaction) => actions.react(message, reaction);
    const markUnread = () => actions.markUnread(message);
    // VoiceOver reads the bubble as one element and can't reach a code block's copy button.
    const codeBlocks = message.role === "user" ? [] : markdownCodeBlocks(blockText(message));
    const copyCode = () => {
      if (codeBlocks[0]) void Clipboard.setStringAsync(codeBlocks[0]).catch(() => undefined);
    };
    const menuActions = [
      ...(!readOnly ? [{ name: "reply", text: t("Reply"), onPress: reply }] : []),
      ...(includeUnread
        ? [{ name: "unread", text: t("Mark as unread"), onPress: markUnread }]
        : []),
      ...(includeQuote ? [{ name: "quote", text: t("Quote"), onPress: quote }] : []),
      ...(includeReact
        ? [
            {
              name: "react",
              text: t("React"),
              onPress: () =>
                presentMessageActionSheet({
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                  actions: MESSAGE_REACTIONS.map((emoji) => ({
                    text: emoji,
                    onPress: () => react(emoji),
                  })),
                }),
            },
          ]
        : []),
      ...(includeSpeak ? [{ name: "speak", text: t("Speak message"), onPress: speakMessage }] : []),
      ...(includeSelect ? [{ name: "select", text: t("Select text"), onPress: select }] : []),
      { name: "copy", text: t("Copy"), onPress: copy },
      ...(codeBlocks.length === 1
        ? [{ name: "copyCode", text: t("Copy code"), onPress: copyCode }]
        : []),
    ];
    const menu = buildMessageContextMenu({
      labels: {
        reply: t("Reply"),
        copy: t("Copy"),
        react: t("React"),
        quote: t("Quote"),
        speak: t("Speak message"),
        select: t("Select text"),
        unread: t("Mark as unread"),
      },
      reactions: MESSAGE_REACTIONS,
      include: {
        reply: !readOnly,
        quote: includeQuote,
        react: includeReact,
        speak: includeSpeak,
        select: includeSelect,
        unread: includeUnread,
      },
    });
    const openSheet = (event: GestureResponderEvent) =>
      presentMessageMenu({
        anchor: { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
        reactions: includeReact
          ? MESSAGE_REACTIONS.map((emoji) => ({ emoji, onPress: () => react(emoji) }))
          : [],
        groups: [
          [
            ...(!readOnly
              ? [
                  {
                    name: "reply",
                    text: t("Reply"),
                    icon: "arrow-undo-outline" as const,
                    onPress: reply,
                  },
                ]
              : []),
            ...(includeUnread
              ? [
                  {
                    name: "unread",
                    text: t("Mark as unread"),
                    icon: "mail-unread-outline" as const,
                    onPress: markUnread,
                  },
                ]
              : []),
            ...(includeQuote
              ? [
                  {
                    name: "quote",
                    text: t("Quote"),
                    icon: "chatbox-ellipses-outline" as const,
                    onPress: quote,
                  },
                ]
              : []),
          ],
          [
            { name: "copy", text: t("Copy"), icon: "copy-outline" as const, onPress: copy },
            ...(includeSelect
              ? [
                  {
                    name: "select",
                    text: t("Select text"),
                    icon: "text-outline" as const,
                    onPress: select,
                  },
                ]
              : []),
            ...(includeSpeak
              ? [
                  {
                    name: "speak",
                    text: t("Speak message"),
                    icon: "volume-high-outline" as const,
                    onPress: speakMessage,
                  },
                ]
              : []),
          ],
        ],
      });
    return {
      menu,
      likeMessage: canDoubleTapReact(includeReact, message.blocks, waitingForUser)
        ? () => {
            if (hasLike || optimisticLike || likeInFlight.current) return;
            likeInFlight.current = true;
            setOptimisticLike(true);
            void react("👍")
              .then((success) => {
                if (!success) setOptimisticLike(false);
              })
              .finally(() => {
                likeInFlight.current = false;
              });
          }
        : undefined,
      onMenuAction: (id) => {
        const reaction = messageMenuReaction(id);
        if (reaction && (MESSAGE_REACTIONS as readonly string[]).includes(reaction)) {
          react(reaction as MessageReaction);
          return;
        }
        if (id === "reply") reply();
        if (id === "copy") copy();
        if (id === "quote") quote();
        if (id === "speak") speakMessage();
        if (id === "select") select();
        if (id === "unread") markUnread();
      },
      actionProps: {
        onLongPress: Platform.OS === "ios" ? undefined : openSheet,
        accessibilityActions: menuActions.map((action) => ({
          name: action.name,
          label: action.text,
        })),
        onAccessibilityAction: (event) => {
          menuActions.find((action) => action.name === event.nativeEvent.actionName)?.onPress();
        },
      },
    };
  }, [
    message,
    actions,
    readOnly,
    onCall,
    colorScheme,
    t,
    locale,
    waitingForUser,
    hasLike,
    optimisticLike,
  ]);
  return (
    <View
      key={message.id}
      onLayout={onLayout}
      style={{
        backgroundColor: highlighted ? tokens.muted : undefined,
        marginTop: headerAdjacent ? 0 : 12,
        width: "100%",
      }}
    >
      {separator ? <TimeSeparator createdAt={message.createdAt} /> : null}
      {unreadDivider ? <UnreadDivider afterSeparator={separator} /> : null}
      <View
        style={{
          width: "100%",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          justifyContent: message.role === "user" ? "flex-end" : "flex-start",
        }}
      >
        {activityBotId ? (
          <View style={{ paddingTop: 22 }}>
            <BotAvatar
              color={activityColor ?? tokens.mutedForeground}
              identity={activityBotId}
              size={inGroup ? 20 : 28}
              status={activityStatus}
              motion="running"
              composing={liveMessageComposing(message.blocks)}
              pokeable
            />
          </View>
        ) : null}
        <View
          style={{
            width:
              isCenteredAgentEvent(message.blocks) || isWideAskBlock(message.blocks)
                ? "100%"
                : hasAppConnectBlock(message.blocks) && !activityBotId
                  ? "90%"
                  : undefined,
            maxWidth:
              isCenteredAgentEvent(message.blocks) || isWideAskBlock(message.blocks)
                ? "100%"
                : activityBotId
                  ? undefined
                  : "90%",
            flex: activityBotId ? 1 : undefined,
            flexShrink: 1,
          }}
        >
          {isPeerReceiptBlocks(message.blocks) ? null : (
            <ReplyLine
              threadTarget={artifactTarget}
              targetId={message.replyToMessageId}
              quote={message.replyQuote}
              preview={message.replyPreview}
              author={replyAuthor}
              fallbackText={replyFallbackText}
              onJump={actions.jump}
            />
          )}
          <MessageContextMenu
            actions={menu}
            fullWidth={isWideAskBlock(message.blocks) || hasAppConnectBlock(message.blocks)}
            maxWidth={
              isWideAskBlock(message.blocks)
                ? columnWidth - 40 - (activityBotId ? (inGroup ? 28 : 36) : 0)
                : isCenteredAgentEvent(message.blocks)
                  ? columnWidth - 40
                  : activityBotId
                    ? columnWidth - 40 - (inGroup ? 28 : 36)
                    : (columnWidth - 40) * 0.9
            }
            colorScheme={colorScheme}
            onAction={onMenuAction}
            onLongPress={actionProps.onLongPress}
            onDoubleTap={messageHasInlineControls(message.blocks) ? undefined : likeMessage}
          >
            <ThreadReadOnlyContext.Provider value={readOnly}>
              <MessageBubble
                botId={bubbleBotId}
                groupId={groupId}
                message={message}
                botName={botName}
                showBotSenderName={showBotSenderName}
                bots={bots}
                members={members}
                canAnswer={canAnswer}
                canDismiss={canDismiss}
                onAnswer={actions.answer}
                onOpenBot={actions.openBot}
                onOpenComputer={actions.openComputer}
                onChoiceDismissed={onChoiceDismissed}
                onPreviewMarkdown={actions.previewMarkdown}
                onPreviewImage={actions.previewImage}
                peerReplies={peerReplies}
                onTogglePeerReplies={actions.togglePeerReplies}
                onOpenPeerChat={actions.openPeerChat}
                actionProps={actionProps}
                doubleTapSurface={Boolean(likeMessage)}
                onHelperToggle={actions.helperToggle}
                userBubble={userBubble}
              />
            </ThreadReadOnlyContext.Provider>
          </MessageContextMenu>
          {displayedReactions.size > 0 ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 4,
                justifyContent: message.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {[...displayedReactions].map(([emoji, count]) => (
                <Animated.Text
                  entering={
                    emoji === "👍" && optimisticLike && !reducedMotion
                      ? ZoomIn.duration(150).withInitialValues({ transform: [{ scale: 0.9 }] })
                      : undefined
                  }
                  key={emoji}
                  style={{
                    color: tokens.foreground,
                    backgroundColor: tokens.muted,
                    borderRadius: 16,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    fontSize: 13,
                  }}
                >
                  {emoji}
                  {count > 1 ? ` ${count}` : ""}
                </Animated.Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
});

// A running helper's live card and the saved message that replaces it have different ids, so
// its row mounts again when the helper finishes. Remember open cards by agent id across that.
const openHelpers = new Set<string>();

const MessageBubble = memo(function MessageBubble(
  props: ComponentProps<typeof MessageBubbleContent>,
) {
  const { message } = props;
  if (!message.blocks.some(isSpecialMessageBlock)) return <MessageBubbleContent {...props} />;

  const pieces: MessageBlock[][] = [];
  for (const block of message.blocks) {
    const previous = pieces.at(-1);
    if (isSpecialMessageBlock(block) || !previous || isSpecialMessageBlock(previous[0]!)) {
      pieces.push([block]);
    } else {
      previous.push(block);
    }
  }
  const content = pieces.map((blocks, index) => {
    const first = blocks[0]!;
    return isSpecialMessageBlock(first) ? (
      <SpecialMessageCard
        key={first.kind === "subagent" ? first.agentId : `${first.kind}-${index}`}
        special={first}
        actionProps={props.actionProps}
        onOpenBot={props.onOpenBot}
        onHelperToggle={props.onHelperToggle}
        userBubble={props.userBubble}
      />
    ) : (
      <MessageBubbleContent
        {...props}
        key={`content-${index}`}
        message={{ ...message, blocks }}
        onAnswer={(_, ...answer) => props.onAnswer(message, ...answer)}
      />
    );
  });
  return content.length === 1 ? (
    content[0]
  ) : (
    <View style={{ gap: 8, width: "100%" }}>{content}</View>
  );
});

type SpecialMessageBlock = Extract<
  MessageBlock,
  { kind: "subagent" | "child_bot" | "cloud_agent" }
>;

function isSpecialMessageBlock(block: MessageBlock): block is SpecialMessageBlock {
  return block.kind === "subagent" || block.kind === "child_bot" || block.kind === "cloud_agent";
}

const MessageBubbleContent = memo(function MessageBubbleContent({
  botId,
  botName,
  showBotSenderName,
  bots,
  groupId,
  message,
  members,
  canAnswer,
  canDismiss,
  onAnswer,
  onOpenComputer,
  onChoiceDismissed,
  onPreviewMarkdown,
  onPreviewImage,
  peerReplies,
  onTogglePeerReplies,
  onOpenPeerChat,
  actionProps,
  doubleTapSurface = false,
  userBubble,
}: {
  onHelperToggle?: MessageRowActions["helperToggle"];
  botId: string;
  botName?: string;
  showBotSenderName: boolean;
  bots: MobileBot[];
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  canAnswer: boolean;
  canDismiss: boolean;
  onAnswer: (
    message: MobileMessage,
    answer: string,
    username?: string,
    dismiss?: boolean,
  ) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onOpenComputer: (botId: string, name: string) => void;
  onChoiceDismissed?: (question: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  onPreviewImage: (target: ImageArtifactPreviewTarget) => void;
  peerReplies?: "collapsed" | "expanded";
  onTogglePeerReplies: (markerId: string) => void;
  onOpenPeerChat: (peer: { peerBotId: string; peerBotName: string }) => void;
  actionProps: MessageActionProps;
  doubleTapSurface?: boolean;
  userBubble?: UserBubble;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  const [peerExpanded, setPeerExpanded] = useState(false);
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  const computerBotId = message.botId ?? (groupId ? undefined : botId);
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
  );
  const mcpApprovalBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "mcp_approval" }> =>
      block.kind === "mcp_approval",
  );
  const undoBlock = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && Boolean(block.instructionUpdate?.undoVersionId),
  );
  if (undoBlock?.instructionUpdate?.undoVersionId) {
    return (
      <InstructionUndo
        botId={undoBlock.instructionUpdate.botId}
        versionId={undoBlock.instructionUpdate.undoVersionId}
        instructions={undoBlock.instructionUpdate.after}
      />
    );
  }
  const ask = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && !isApprovalAskBlock(block) && !block.actions?.length,
  );
  if (ask) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <AskBlock
          ask={ask}
          actionProps={actionProps}
          canAnswer={canAnswer}
          canDismiss={canDismiss}
          onAnswer={(answer, username) => onAnswer(message, answer, username)}
          onDismiss={() => onAnswer(message, "", undefined, true)}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            threadId={message.threadId}
            messageId={message.id}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const handoff = message.blocks.find((block) => block.kind === "handoff");
  if (handoff) {
    const from = memberName(members, handoff.fromBotId) ?? t("bot");
    const to = memberName(members, handoff.toBotId) ?? t("bot");
    return (
      <AgentEventLabel
        actionProps={actionProps}
        label={t("{from} messaged {to}", { from, to })}
        detail={handoff.text}
        expanded={peerExpanded}
        onToggle={() => setPeerExpanded((expanded) => !expanded)}
      />
    );
  }
  const peerMessage = message.blocks.find(
    (
      block,
    ): block is Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }> =>
      block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (peerMessage) {
    const sent = peerMessage.kind === "bot_message_sent";
    const peer = sent ? peerMessage.toBotName : peerMessage.fromBotName;
    const peerBotId = sent ? peerMessage.toBotId : peerMessage.fromBotId;
    const label = sent
      ? t("Messaged {peer}", { peer: peer ?? t("Bot") })
      : t("Message from {peer}", { peer: peer ?? t("Bot") });
    const peerColor =
      bots.find((bot) => bot.id === peerBotId)?.color ??
      members?.find((member) => member.botId === peerBotId)?.color ??
      tokens.mutedForeground;
    // A received chip with folded replies expands them in place; otherwise, in a bot's own chat,
    // the chip opens the view-only bot-to-bot exchange, as on web.
    const replies = sent ? undefined : peerReplies;
    const press = peerChipPress({
      sent,
      replies,
      threadBotId: groupId ? undefined : botId,
      peerBotId,
    });
    return (
      <Pressable
        {...actionProps}
        accessible
        onPress={
          press === "toggle"
            ? () => onTogglePeerReplies(message.id)
            : press === "open"
              ? () => onOpenPeerChat({ peerBotId, peerBotName: peer ?? t("Bot") })
              : undefined
        }
        accessibilityRole={press ? "button" : undefined}
        accessibilityState={replies ? { expanded: replies === "expanded" } : undefined}
        accessibilityLabel={
          replies === "expanded"
            ? t("Hide {label}", { label })
            : replies === "collapsed"
              ? t("Show {label}", { label })
              : label
        }
        style={{
          width: "100%",
          paddingVertical: 4,
          alignItems: "center",
          justifyContent: "flex-start",
          flexDirection: "row",
          gap: 6,
        }}
      >
        <BotAvatar color={peerColor} identity={peerBotId} size={16} />
        <Text
          numberOfLines={1}
          style={{ color: tokens.mutedForeground, fontSize: 13.5, flexShrink: 1 }}
        >
          {label}
        </Text>
        {press ? (
          <NativeSymbol
            ios={replies === "expanded" ? "chevron.down" : "chevron.right"}
            android={replies === "expanded" ? "chevron-down" : "chevron-forward"}
            size={12}
            color={tokens.mutedForeground}
          />
        ) : null}
      </Pressable>
    );
  }
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return (
      <Pressable
        {...actionProps}
        style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" }}>
          {messagingProviderLabel(channelMessage.provider, channelMessage.transport)} ·{" "}
          {channelMessage.fromLabel}: {channelMessage.text}
        </Text>
      </Pressable>
    );
  }
  const inlineCardCount = appConnectBlocks.length + mcpApprovalBlocks.length;
  if (inlineCardCount > 0 && inlineCardCount === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            threadId={message.threadId}
            messageId={message.id}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const askBlock = message.blocks.find(
    (block) => block.kind === "ask" && Boolean(block.actions?.length),
  );
  if (askBlock?.kind === "ask" && askBlock.actions?.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <View
          style={{
            // No percentage width: the iOS menu host has no definite width to resolve it against.
            maxWidth: 576,
            borderRadius: 18,
            backgroundColor: tokens.card,
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          {askBlock.instructionUpdate?.undoVersionId ? (
            <InstructionUndo
              botId={askBlock.instructionUpdate.botId}
              versionId={askBlock.instructionUpdate.undoVersionId}
              instructions={askBlock.instructionUpdate.after}
            />
          ) : (
            <>
              {askBlock.text ? (
                <Text {...actionProps} style={{ color: tokens.foreground, ...typeScale.cardTitle }}>
                  {askBlock.instructionUpdate
                    ? t("Update instructions?")
                    : plainAskTitle(askBlock.text)}
                </Text>
              ) : null}
              {askBlock.detail ? (
                <Text
                  {...(askBlock.text ? {} : actionProps)}
                  style={{
                    color:
                      askBlock.detailFormat === "text" ? tokens.foreground : tokens.mutedForeground,
                    marginTop: askBlock.text ? 8 : 0,
                    // Commands and an approval's tool arguments read as code; a bot's own note
                    // under its question is text.
                    ...(askBlock.detailFormat === "code" ||
                    (!askBlock.detailFormat && askBlock.approvalEffectId)
                      ? { ...typeScale.caption, fontFamily: "Menlo" }
                      : typeScale.secondary),
                  }}
                >
                  {askBlock.detail}
                </Text>
              ) : null}
              {askBlock.status === "answered" ? (
                <Text
                  {...actionProps}
                  style={{
                    color: askBlock.answer === "deny" ? tokens.mutedForeground : tokens.success,
                    marginTop: 12,
                    ...typeScale.secondary,
                    fontWeight: fontWeight.medium,
                  }}
                >
                  {askBlock.instructionUpdate
                    ? t(askBlock.answer === "deny" ? "Dismissed" : "Allowed once")
                    : formatApprovalAnswer(
                        askBlock.answer,
                        askBlock.actions,
                        isApprovalAskBlock(askBlock),
                      )}
                </Text>
              ) : canAnswer && onAnswer ? (
                <AskActions
                  actions={askBlock.actions}
                  instructions={askBlock.instructionUpdate?.after}
                  accessibilityActions={actionProps.accessibilityActions}
                  onAccessibilityAction={actionProps.onAccessibilityAction}
                  onAnswer={(answer) => onAnswer(message, answer)}
                />
              ) : (
                <Text
                  {...actionProps}
                  style={{ color: tokens.mutedForeground, marginTop: 12, ...typeScale.caption }}
                >
                  {t("No longer active")}
                </Text>
              )}
            </>
          )}
        </View>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            threadId={message.threadId}
            messageId={message.id}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const caption = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
    })
    .join("\n");
  if (attachments.length > 0) {
    const speaker =
      message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
    const speakerColor =
      message.role === "bot" ? speakerColorFor(bots, members, message.botId) : undefined;
    return (
      <View
        style={{
          maxWidth: "100%",
          borderRadius: 20,
          backgroundColor: message.role === "user" ? tokens.chatUser : tokens.muted,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {showBotSenderName && speaker ? (
          <Text style={{ color: speakerColor ?? tokens.mutedForeground, ...typeScale.footnote }}>
            {speaker}
          </Text>
        ) : null}
        {caption ? (
          <MessageCaption
            role={message.role}
            text={caption}
            tokens={tokens}
            colorScheme={colorScheme}
            streaming={message.id.startsWith("progress:")}
          />
        ) : null}
        {attachments.map((attachment, index) =>
          attachment.kind === "image" ? (
            attachment.artifactId && isInlineImageMimeType(attachment.mimeType) ? (
              <InlineImageAttachment
                key={`${attachment.artifactId}-${index}`}
                threadTarget={artifactTarget}
                artifactId={attachment.artifactId}
                name={attachment.name ?? t("Image")}
                mimeType={attachment.mimeType ?? "image/png"}
                labelColor={message.role === "user" ? tokens.chatUserForeground : tokens.foreground}
                pressableProps={actionProps}
                onOpen={() =>
                  onPreviewImage({
                    artifactId: attachment.artifactId!,
                    name: attachment.name ?? t("Image"),
                    mimeType: attachment.mimeType ?? "image/png",
                  })
                }
              />
            ) : (
              <Pressable
                {...actionProps}
                key={`${attachment.artifactId ?? attachment.name ?? "image"}-${index}`}
                onPress={() =>
                  attachment.artifactId
                    ? void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? t("Image"),
                        attachment.mimeType ?? "image/png",
                      ).catch((err) =>
                        Alert.alert(t("Could not open image"), errorText(err, t("Try again."))),
                      )
                    : undefined
                }
              >
                <Text
                  style={{
                    color: message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
                    fontSize: 15,
                  }}
                >
                  🖼 {attachment.name ?? t("Image")}
                </Text>
              </Pressable>
            )
          ) : attachment.artifactId && isAttachmentAudioMimeType(attachment.mimeType ?? "") ? (
            <AudioAttachment
              pressableProps={actionProps}
              key={`${attachment.artifactId}-${index}`}
              target={artifactTarget}
              artifactId={attachment.artifactId}
              name={attachment.name ?? t("File")}
              mimeType={attachment.mimeType!}
              labelColor={message.role === "user" ? tokens.chatUserForeground : undefined}
            />
          ) : (
            <Pressable
              {...actionProps}
              key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? attachment.mimeType === "text/markdown"
                    ? onPreviewMarkdown({
                        artifactId: attachment.artifactId,
                        name: attachment.name ?? t("Markdown file"),
                        mimeType: attachment.mimeType,
                      })
                    : void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? t("File"),
                        attachment.mimeType ?? "text/plain",
                      ).catch((err) =>
                        Alert.alert(t("Could not open file"), errorText(err, t("Try again."))),
                      )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
                  fontSize: 15,
                }}
              >
                📎 {attachment.name ?? t("File")}
              </Text>
              {formatFileSize(attachment.size) ? (
                <Text
                  style={{
                    color:
                      message.role === "user" ? tokens.chatUserForeground : tokens.mutedForeground,
                    marginTop: 4,
                    fontSize: 13,
                  }}
                >
                  {formatFileSize(attachment.size)}
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            threadId={message.threadId}
            messageId={message.id}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {mcpApprovalBlocks.map((block) => (
          <McpApprovalCard
            key={block.serverId}
            botId={cardBotId}
            threadId={message.threadId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const segments = messagePresentationSegments(message.blocks);
  const speaker =
    message.role === "bot" ? (memberName(members, message.botId) ?? botName) : undefined;
  const speakerColor =
    message.role === "bot" ? speakerColorFor(bots, members, message.botId) : undefined;
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  const choiceBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "choice" }> => block.kind === "choice",
  );
  const computerBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "computer" }> => block.kind === "computer",
  );
  return (
    <View style={{ gap: 8, width: "100%" }}>
      {segments.map((segment, index) => (
        <MessageTextCard
          key={`${message.id}-content-${index}`}
          message={{ ...message, blocks: segment.blocks }}
          speaker={showBotSenderName && index === firstContent ? speaker : undefined}
          speakerColor={showBotSenderName && index === firstContent ? speakerColor : undefined}
          actionProps={actionProps}
          doubleTapSurface={doubleTapSurface}
          userBubble={userBubble}
        />
      ))}
      {choiceBlocks.map((block, index) => (
        <ChoiceCard
          key={`choice-${index}`}
          botId={cardBotId}
          block={block}
          onDismissed={onChoiceDismissed ? () => onChoiceDismissed(block.question) : undefined}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
      {computerBlocks.map((block, index) => (
        <ComputerCard
          key={`computer-${index}`}
          block={block}
          onOpen={
            computerBotId ? () => onOpenComputer(computerBotId, speaker ?? t("Bot")) : undefined
          }
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard
          key={`${block.provider}-${index}`}
          botId={cardBotId}
          threadId={message.threadId}
          messageId={message.id}
          block={block}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
    </View>
  );
});

type SpecialMessageCardProps = Pick<
  ComponentProps<typeof MessageBubbleContent>,
  "actionProps" | "onOpenBot" | "onHelperToggle" | "userBubble"
> & { special: SpecialMessageBlock };

function HelperMessageCard({
  special,
  actionProps,
  onHelperToggle,
  userBubble,
}: Pick<SpecialMessageCardProps, "actionProps" | "onHelperToggle" | "userBubble"> & {
  special: Extract<MessageBlock, { kind: "subagent" }>;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  const helperHeader = useRef<View>(null);
  const helperCard = useRef<View>(null);
  const helperReducedMotion = useReducedMotion();
  const [subagentOpen, setSubagentOpen] = useState(() => openHelpers.has(special.agentId));
  const helperRotation = useSharedValue(subagentOpen ? 180 : 0);
  useEffect(() => {
    helperRotation.value = helperReducedMotion
      ? subagentOpen
        ? 180
        : 0
      : withTiming(subagentOpen ? 180 : 0, { duration: 150 });
  }, [subagentOpen, helperReducedMotion, helperRotation]);
  const helperChevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${helperRotation.value}deg` }],
  }));
  const running = special.status === "running";
  const failed = special.status === "failed";
  return (
    <Pressable
      {...actionProps}
      ref={helperCard}
      collapsable={false}
      style={{
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
      }}
    >
      <Pressable
        {...actionProps}
        onPress={() => {
          const toggle = () => {
            if (subagentOpen) openHelpers.delete(special.agentId);
            else openHelpers.add(special.agentId);
            setSubagentOpen(!subagentOpen);
          };
          if (onHelperToggle) {
            onHelperToggle(
              (done) =>
                helperHeader.current?.measureInWindow((_x, y) => {
                  helperCard.current?.measureInWindow((_cardX, cardY, _width, height) =>
                    done(y, cardY + height),
                  );
                }),
              toggle,
              !subagentOpen,
            );
          } else toggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: subagentOpen }}
        style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, minHeight: 44 }}
      >
        <View ref={helperHeader} collapsable={false}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              style={{
                flexShrink: 1,
                flexGrow: 1,
                color: tokens.foreground,
                ...typeScale.cardTitle,
              }}
            >
              {safeDisplayName(special.name, t("subagent"))}
            </Text>
            <Text
              style={{
                color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
                ...typeScale.caption,
              }}
            >
              {running
                ? t("Running")
                : special.status === "failed"
                  ? t("Failed")
                  : special.status === "completed"
                    ? t("Completed")
                    : special.status}
            </Text>
            <Animated.View style={helperChevronStyle}>
              <NativeSymbol
                ios="chevron.down"
                android="chevron-down"
                size={12}
                color={tokens.mutedForeground}
              />
            </Animated.View>
          </View>
          {special.task ? (
            <Text
              numberOfLines={subagentOpen ? undefined : 1}
              style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}
            >
              {special.task}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {subagentOpen && (special.result || special.progress) ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, marginTop: -6 }}>
          <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
            {special.result || special.progress || ""}
          </ChatMarkdown>
        </View>
      ) : null}
    </Pressable>
  );
}

function SpecialMessageCard(props: SpecialMessageCardProps) {
  const { special, actionProps, onOpenBot, userBubble } = props;
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const { t } = useI18n();
  if (special.kind === "subagent") return <HelperMessageCard {...props} special={special} />;
  if (special.kind === "cloud_agent") {
    const title = special.title || t("Cloud agent");
    const statusLabel =
      special.status === "running"
        ? t("running")
        : special.status === "finished"
          ? t("finished")
          : special.status === "cancelled"
            ? t("cancelled")
            : special.status === "expired"
              ? t("expired")
              : t("failed");
    const running = special.status === "running";
    const failed = special.status !== "running" && special.status !== "finished";
    const prHref = cloudAgentHttpsUrl(special.prUrl);
    const href = prHref ?? cloudAgentHttpsUrl(special.url);
    return (
      <Pressable
        {...actionProps}
        onPress={() => {
          if (href) Linking.openURL(href).catch(() => undefined);
        }}
        testID="cloud-agent-card"
        accessibilityRole={href ? "link" : "text"}
        accessibilityLabel={`${title}: ${statusLabel}`}
        disabled={!href}
        style={{
          width: "90%",
          borderRadius: 18,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ flexShrink: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}>
            {title}
          </Text>
          <Text
            style={{
              color: failed ? tokens.destructive : running ? tokens.warning : tokens.success,
              ...typeScale.caption,
            }}
          >
            {statusLabel}
          </Text>
        </View>
        {prHref ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {t("Pull request")}
          </Text>
        ) : special.branch ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
            {special.branch}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  if (special.kind === "child_bot") {
    const removed = special.status === "deleted" || special.status === "archived";
    return (
      <Pressable
        {...actionProps}
        onPress={
          removed ? undefined : () => onOpenBot(special.botId ?? "", special.name ?? t("Bot"))
        }
        style={{
          width: "90%",
          borderRadius: 18,
          backgroundColor: tokens.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
          opacity: removed ? 0.6 : 1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={{ flexShrink: 1, color: tokens.foreground, ...typeScale.cardTitle }}>
            {special.name || t("Bot")}
          </Text>
          <Text
            style={{ color: removed ? tokens.destructive : tokens.success, ...typeScale.caption }}
          >
            {special.status === "archived"
              ? t("archived")
              : special.status === "deleted"
                ? t("deleted")
                : t("bot")}
          </Text>
        </View>
        <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...typeScale.secondary }}>
          {removed
            ? special.status === "archived"
              ? t("Archived. Chat, memory, and files kept.")
              : t("Removed with chat, computer, and memory.")
            : special.title || t("Opened its thread.")}
        </Text>
      </Pressable>
    );
  }
  return null;
}

function MessageTextCard({
  message,
  speaker,
  speakerColor,
  actionProps,
  doubleTapSurface = false,
  userBubble,
}: {
  message: MobileMessage;
  speaker?: string;
  speakerColor?: string;
  actionProps: MessageActionProps;
  doubleTapSurface?: boolean;
  userBubble?: UserBubble;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = withUserBubble(mobileTokens(), userBubble);
  const contentText = blockText(message);
  if (!contentText) return null;
  // The menu wrapper owns surface gestures; links and code controls remain responders.
  const Surface = doubleTapSurface ? View : Pressable;
  return (
    <Surface
      {...actionProps}
      accessible
      onLongPress={doubleTapSurface ? undefined : actionProps.onLongPress}
      style={{
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "100%",
        backgroundColor: message.role === "user" ? tokens.chatUser : tokens.muted,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 20,
      }}
    >
      {speaker ? (
        <Text
          style={{
            color: speakerColor ?? tokens.mutedForeground,
            ...typeScale.footnote,
            marginBottom: 4,
          }}
        >
          {speaker}
        </Text>
      ) : null}
      <MessageCaption
        role={message.role}
        text={contentText}
        tokens={tokens}
        colorScheme={colorScheme}
        streaming={message.id.startsWith("progress:")}
      />
    </Surface>
  );
}

function AgentEventLabel({
  label,
  detail,
  expanded,
  onToggle,
  actionProps,
}: {
  label: string;
  detail?: string;
  expanded: boolean;
  onToggle: () => void;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <Pressable
      {...actionProps}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={expanded ? t("Hide {label}", { label }) : t("Show {label}", { label })}
      style={{ width: "100%", paddingVertical: 4, alignItems: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <NativeSymbol
          ios="arrow.left.arrow.right"
          android="swap-horizontal"
          size={12}
          color={tokens.mutedForeground}
        />
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" }}>
          {label}
        </Text>
      </View>
      {expanded && detail ? (
        <View
          style={{
            width: "100%",
            marginTop: 6,
            borderRadius: 14,
            backgroundColor: tokens.card,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
            {detail}
          </ChatMarkdown>
        </View>
      ) : null}
    </Pressable>
  );
}

function AskBlock({
  ask,
  canAnswer,
  canDismiss,
  onAnswer,
  onDismiss,
  actionProps,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  canDismiss: boolean;
  onAnswer: (answer: string, username?: string) => Promise<void>;
  /** Turns down a secret request without a value. */
  onDismiss: () => Promise<void>;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetSession = useRef(0);
  const session = sheetSession.current;
  const [saved, setSaved] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const answered = saved || dismissed || ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);
  const loginInput = secretInput && ask.credential?.auth.type === "login";
  // A login or credential is saved for the run's user, so only they can fill one in; others see
  // the card without fields or buttons.
  const ownerOnly = secretInput && Boolean(ask.credential) && !canDismiss;
  const incomplete = secretInput ? answer.length === 0 : !answer.trim();
  const secretLabel =
    ask.purpose === "password"
      ? t("Password")
      : ask.purpose === "api_key"
        ? t("API key")
        : t("Code");
  const submitLabel = secretInput ? t("Save") : t("Send answer");

  async function dismiss() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setAnswer("");
    try {
      await onDismiss();
      setDismissed(true);
    } catch {
      setError(t("Could not send answer"));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    if (submitting) return;
    if (incomplete) return;
    const submitValue = secretInput ? answer : answer.trim();
    setSubmitting(true);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue);
      if (secretInput) setSaved(true);
    } catch (cause) {
      setError(
        secretInput ? t("Could not send answer") : errorText(cause, t("Could not send answer")),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View
      style={{
        width: secretInput ? "100%" : "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text
        {...actionProps}
        numberOfLines={secretInput ? 2 : undefined}
        style={{ color: tokens.foreground, ...typeScale.cardTitle }}
      >
        {plainAskTitle(ask.text)}
      </Text>
      {secretInput && ask.credential ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {secretDestinationLabel(ask.credential)}
        </Text>
      ) : null}
      {ask.detail && !secretInput ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>{ask.detail}</Text>
      ) : null}
      {answered ? (
        <Text
          style={{
            // Dismissed reads like a declined approval, not a success.
            color: dismissed || ask.dismissed ? tokens.mutedForeground : tokens.success,
            ...typeScale.secondary,
            fontWeight: fontWeight.medium,
            ...(secretInput ? { marginTop: 12 } : null),
          }}
        >
          {secretInput
            ? t(dismissed || ask.dismissed ? "Dismissed" : "Saved")
            : t("Answered: {answer}", { answer: ask.answer ?? t("Done") })}
        </Text>
      ) : canAnswer && ownerOnly ? null : canAnswer && loginInput ? (
        <View style={askInputStyles.buttons}>
          <NativeActionButton
            label={t("Continue")}
            disabled={submitting}
            fill={secretInput}
            style={secretInput ? askInputStyles.button : undefined}
            onPress={() => {
              sheetSession.current += 1;
              setSheetOpen(true);
            }}
          />
          {canDismiss ? (
            <NativeActionButton
              label={t("Dismiss")}
              disabled={submitting}
              fill={secretInput}
              style={secretInput ? askInputStyles.button : undefined}
              prominence="secondary"
              onPress={() => void dismiss()}
            />
          ) : null}
        </View>
      ) : canAnswer ? (
        <>
          <TextInput
            accessibilityLabel={secretInput ? secretLabel : t("Answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? secretLabel : t("Type your answer")}
            placeholderTextColor={tokens.faintForeground}
            secureTextEntry={secretInput}
            autoComplete="off"
            {...(secretInput ? secretFieldTraits(ask.purpose, ask.credential) : {})}
            autoCorrect={secretInput ? false : undefined}
            autoCapitalize={secretInput ? "none" : "sentences"}
            editable={!submitting}
            onSubmitEditing={() => void submit()}
            style={[
              askInputStyles.field,
              secretInput ? { alignSelf: "stretch" } : undefined,
              { borderColor: tokens.border, color: tokens.foreground },
            ]}
          />
          <View style={askInputStyles.buttons}>
            <NativeActionButton
              label={submitLabel}
              disabled={incomplete}
              busy={submitting}
              fill={secretInput}
              style={secretInput ? askInputStyles.button : undefined}
              onPress={() => void submit()}
            />
            {secretInput && canDismiss ? (
              <NativeActionButton
                label={t("Dismiss")}
                disabled={submitting}
                fill={secretInput}
                style={secretInput ? askInputStyles.button : undefined}
                prominence="secondary"
                onPress={() => void dismiss()}
              />
            ) : null}
          </View>
        </>
      ) : (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {t("Waiting for this bot’s response.")}
        </Text>
      )}
      {error ? (
        <Text style={{ color: tokens.destructive, ...typeScale.caption }}>{error}</Text>
      ) : null}
      {sheetOpen && loginInput && ask.credential ? (
        <SecretAskSheet
          title={plainAskTitle(ask.text)}
          destination={secretDestinationLabel(ask.credential)}
          // Once any save is accepted, or the viewer is no longer the run's user, the open sheet
          // clears its own fields, then closes itself.
          pending={canAnswer && !answered && !ownerOnly}
          onClose={() => {
            if (session === sheetSession.current) setSheetOpen(false);
          }}
          onSave={async (password, username) => {
            await onAnswer(password, username);
            setSaved(true);
            if (session === sheetSession.current) setSheetOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const askInputStyles = StyleSheet.create({
  field: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  button: {
    flex: 1,
    minWidth: 100,
  },
  // Wraps at large text sizes so neither button is pushed off the card.
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: 6,
  },
});
