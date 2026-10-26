import type { AgentSkillCatalogEntry, MessageReaction } from "@rakazo/contracts";
import type { SlashActionId, ThreadItem } from "@rakazo/core";
import {
  answerableAskMessageIds,
  appendNewerThreadPage,
  attachmentsForThread,
  buildComposerMentionOptions,
  channelMessageSender,
  chatUserBubbleColors,
  dismissableAskMessageIds,
  forwardProbeAfterPage,
  groupVoiceChats,
  isRetryableError,
  isRunWaitingOnUser,
  isRunWorking,
  liveActivityLine,
  liveMessageComposing,
  memberName,
  newClientId,
  reconcileThreadScrollState,
  resolveComposerSendPlan,
  displayName as safeDisplayName,
  threadWindowMessages,
  timeSeparatorIds,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
  withLiveStreamingProgress,
} from "@rakazo/core";
import {
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { KeyboardAvoidingView, KeyboardController } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readableGutters } from "../../lib/adaptive-layout";
import type { MobileMessage, MobileSnapshot } from "../../lib/api";
import {
  currentApiBase,
  loadSessionToken,
  mergeMobileSnapshot,
  mobileThreadRefreshResult,
  prependMobileMessagePage,
  rpc,
  selectedSpaceId,
} from "../../lib/api";
import { useAppForeground } from "../../lib/app-foreground";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { findSwitchTarget } from "../../lib/bot-switch";
import { useCallSession } from "../../lib/call-session";
import { chatSettingsRoute } from "../../lib/chat-settings-route";
import { cronLabels } from "../../lib/cron";
import { cancelFocusPrompt, focusPromptThreadActive } from "../../lib/focus-prompt";
import { helperHeaderOffset, helperOpenTarget } from "../../lib/helper-header-offset";
import { useI18n } from "../../lib/i18n";
import { isIntegrationsScopeCurrent } from "../../lib/integrations-cache";
import { useKeyboardLayout } from "../../lib/keyboard-layout";
import { KeyboardScrollBack } from "../../lib/keyboard-scroll-back";
import { saveLastBotId } from "../../lib/last-bot";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
} from "../../lib/live-notifications";
import { openModelSettings } from "../../lib/model-settings";
import { useThemedStyles } from "../../lib/native";
import { threadRefreshDelayMs } from "../../lib/refresh";
import {
  getCachedResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../../lib/response-streaming";
import { runErrorActionLabel } from "../../lib/run-error-presentation";
import type { SavedChatsScope } from "../../lib/saved-chats";
import {
  liveSavedChatsScope,
  readSavedThread,
  savedChatsScope,
  savedChatTarget,
  writeSavedThread,
} from "../../lib/saved-chats";
import { useInboxBot } from "../../lib/search-inbox";
import { currentSessionGeneration } from "../../lib/session";
import { useSplitView } from "../../lib/split-view";
import { answerThreadMessage } from "../../lib/thread-answer";
import { useThreadAttachments } from "../../lib/thread-attachments";
import { useThreadBots } from "../../lib/thread-bots";
import { threadHeaderClearance, threadHeaderFloats } from "../../lib/thread-edges";
import type { SendAttempt } from "../../lib/thread-feedback";
import { subscribeDelivered, useThreadFeedback } from "../../lib/thread-feedback";
import { ThreadJumpAnchor } from "../../lib/thread-jump";
import { threadKeyboardOffset } from "../../lib/thread-keyboard-offset";
import { useThreadLiveSubscription } from "../../lib/thread-live";
import { useThreadMentionCatalog } from "../../lib/thread-mention-catalog";
import { previewMessageText } from "../../lib/thread-message-text";
import { useThreadRead } from "../../lib/thread-read";
import type { ThreadScrollAction, ThreadScrollState } from "../../lib/thread-scroll";
import {
  isOwnThreadMessage,
  latestArrivalMessage,
  latestThreadRowKey,
  ThreadScrollBehavior,
} from "../../lib/thread-scroll";
import { reconcileVisibleThreadSnapshot, threadGroupMembers } from "../../lib/thread-snapshot";
import { useThreadTranscript } from "../../lib/thread-transcript";
import { useAutoSpeakReply, useSpeakMessages, useThreadVoiceCall } from "../../lib/thread-voice";
import type { PinnedThreadWindow, ThreadJump } from "../../lib/thread-window";
import { applyThreadMessageJump, liveEndRunError, showLatestThread } from "../../lib/thread-window";
import { prepareUnsentSends } from "../../lib/unsent-sends";
import { useOpenNotificationThread } from "../../lib/use-open-notification-thread";
import { errorText } from "../../lib/user-error";
import { FailedSendBubble } from "../failed-send-bubble";
import type { MarkdownArtifactPreviewTarget } from "../markdown-artifact-preview";
import { MarkdownArtifactPreview } from "../markdown-artifact-preview";
import { RunErrorSheet, useRunError } from "../run-error-sheet";
import { SelectTextSheet } from "../select-text-sheet";
import type { ThreadComposerHandle } from "../thread-composer";
import { ThreadComposer } from "../thread-composer";
import { ThreadErrorNotice, ThreadFetchErrorNotice } from "../thread-error-notice";
import { createThreadHeaderStyles } from "../thread-header-styles";
import { ThreadScrollSurface } from "../thread-scroll-surface";
import { TimeSeparator } from "../time-separator";
import { UnreadDivider } from "../unread-divider";
import { VoiceChatCard } from "../VoiceChatCard";
import type { MessageRowActions } from "./message-row";
import { MessageRow } from "./message-row";
import { QuoteSheet } from "./quote-sheet";
import { ThreadComposerDock } from "./thread-composer-dock";
import { BotActionsModal, useThreadHeader } from "./thread-header";
import { JumpToLatestButton, LoadEarlierButton, ThreadWorkingFooter } from "./thread-list-controls";

function isActiveStatus(status: string | undefined): boolean {
  return isRunWorking(status) || isRunWaitingOnUser(status);
}

const messageListStyles = StyleSheet.create({
  list: { flex: 1 },
  row: { marginTop: 12, width: "100%" },
});
const messageListPosition = { minIndexForVisible: 0 };
const liveMessageListPosition = { ...messageListPosition, autoscrollToTopThreshold: 80 };
function threadItemKey(item: ThreadItem<MobileMessage>) {
  return item.kind === "voiceChat" ? item.key : item.message.id;
}

export function Thread({ sessionEpoch, userId }: { sessionEpoch: number; userId: string }) {
  const keyboardLayout = useKeyboardLayout();
  const tokens = mobileTokens();
  const styles = useThemedStyles(createThreadHeaderStyles);
  const { t, locale } = useI18n();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const router = useRouter();
  // Beside the chat list on a wide window, the chat has only the width the list leaves.
  const { inboxShown, contentWidth: windowWidth } = useSplitView();
  const nativeHeaderHeight = useHeaderHeight();
  const headerHeight = threadHeaderFloats() ? nativeHeaderHeight : 0;
  const headerClearance = threadHeaderClearance(headerHeight);
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps messages and the composer in a centred reading column.
  const columnInsets = readableGutters(windowWidth, {
    left: inboxShown ? 0 : insets.left,
    right: insets.right,
  });
  const columnWidth = windowWidth - columnInsets.left - columnInsets.right;
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
  const requestedThreadId = typeof threadId === "string" && threadId ? threadId : undefined;
  const inGroup = Boolean(groupId);
  const call = useCallSession();
  const onCall = Boolean(botId) && call?.botId === botId;
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
  const pinnedAroundRef = useRef<PinnedThreadWindow | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const jumpAnchor = useRef(new ThreadJumpAnchor());
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const {
    threadKey,
    activeThreadId,
    readVisit,
    readVisibleTarget,
    readBoundary,
    setReadBoundary,
    markedUnreadMessageId,
    markUnreadFrom,
    markReadIfVisible,
  } = useThreadRead({ botId, groupId, focused, readOnly });
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
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [uploadConfig, setUploadConfig] = useState<{ maxUploadSizeBytes?: number }>();
  const [needsModel, setNeedsModel] = useState<boolean>();
  // Re-read on focus so returning from Models settings updates unsent missing-model messages.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void rpc("me")
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

  const { mentionBots, mentionBotsRef, mentionGroups, refreshMentionBots } = useThreadBots({
    botId,
    groupId,
    name,
    activeBotId,
  });
  const {
    routines: mentionRoutines,
    connectors: mentionConnectors,
    onMentionRequested,
  } = useThreadMentionCatalog(
    JSON.stringify([userId, sessionEpoch, botId, groupId, requestedThreadId]),
    mentionBots,
  );
  const {
    pendingAttachments,
    setPendingAttachments,
    activePendingAttachments,
    attachmentNotice,
    setAttachmentNotice,
    attachActions,
    attachFrom,
  } = useThreadAttachments({ botId, groupId, readOnly, uploadConfig });
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<MobileMessage | null>(null);
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
  const feedback = useThreadFeedback(threadKey, newClientId, echoed);
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
  const {
    showBotSenderName,
    peerTranscript,
    reactionView,
    expandedPeerMarkers,
    setExpandedPeerMarkers,
    dismissChoice,
    togglePeerReplies,
  } = useThreadTranscript(snap?.messages, inGroup);
  const visibleMessages = reactionView.visibleMessages;
  const latestMessage = latestArrivalMessage(visibleMessages, peerTranscript.markerOf);
  const latestMessageId = latestMessage?.id ?? null;
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
        cronLabels: cronLabels(locale),
      }),
    [groupId, inGroup, locale, mentionBots, mentionConnectors, mentionGroups, mentionRoutines],
  );
  const currentBot = botId ? mentionBots.find((bot) => bot.id === botId) : undefined;
  // Until the chat's own roster arrives, the bot as the inbox last loaded it.
  const inboxBot = useInboxBot(botId);
  const titleBot = currentBot ?? inboxBot;
  // Without a name yet (a notification can leave it out), the title shows a placeholder.
  const titleName = currentBot?.name ?? name ?? inboxBot?.name;
  const displayName = safeDisplayName(titleName, inGroup ? t("Group") : t("Bot"));
  const composerPrompt = displayName ? t("Message {name}", { name: displayName }) : t("Message…");
  const notificationThreadId = snap?.threadId ?? requestedThreadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const currentBotStatus = snap ? snap.run?.status : titleBot?.status;
  // The group's members in its order, once the chat or its group list has loaded them; the
  // title seats the inbox's copy until then.
  const groupMembers = threadGroupMembers(groupId, snap, mentionGroups);
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

  const speakFinishedReplyRef = useAutoSpeakReply({
    botId,
    inGroup,
    currentBot,
    snap,
    showingSaved,
  });

  useEffect(() => {
    void rpc("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    publishThreadScrollState(scrollBehavior.current.state());
  }, [threadKey, publishThreadScrollState]);

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  const { botActions, botActionsOpen, closeBotActions } = useThreadHeader({
    botId,
    groupId,
    inGroup,
    readOnly,
    displayName,
    titleBot,
    titleName,
    groupMembers,
    currentBotStatus,
    composingBots,
    styles,
    onCleared: () => {
      expandedHistoryThread.current = null;
      pinnedAroundRef.current = null;
      historyEpoch.current += 1;
      commitSnap(
        snapRef.current
          ? { ...snapRef.current, messages: [], olderCursor: null, run: null }
          : snapRef.current,
      );
    },
  });

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
    const next = await rpc(
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

  const threadJump: ThreadJump = {
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
    joinPinnedAfterLayout,
    expandedHistoryThread,
    scrollBehavior,
    snapRef,
    setThreadScrollState,
    commitSnap,
    historyEpoch,
    jumpGeneration,
    activeBotId,
    activeGroupId,
    newerLoadFailed,
    pinnedScrollMetrics,
    snapshotOrigin,
    setExpandedPeerMarkers,
    setShowingSaved,
  };

  function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    return applyThreadMessageJump(threadJump, target);
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
      const page = await rpc("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        around: { seq: probe },
      });
      if (epoch !== historyEpoch.current || pinnedAroundRef.current !== pinned || !snapRef.current)
        return;
      const visibleBefore = threadWindowMessages(
        snapRef.current.messages,
        pinned.newerCursor,
      ).length;
      const reported = page.coveredThroughSeq ?? null;
      const carried =
        reported == null ? undefined : Math.max(pinned.coveredThroughSeq ?? reported, reported);
      const next = appendNewerThreadPage<MobileMessage, MobileSnapshot>(
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
    showLatestThread(threadJump);
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    const pinned = pinnedAroundRef.current;
    try {
      const page = await rpc("threads/messages", {
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

  useOpenNotificationThread({
    botId,
    threadId: notificationThreadId,
    navigation,
    markReadIfVisible,
  });

  const liveSubscribed = useThreadLiveSubscription({
    botId,
    groupId,
    foreground,
    readOnly,
    sessionEpoch,
    messageId,
    historyEpoch,
    expandedHistoryThread,
    pinnedAroundRef,
    jumpScrollTarget,
    jumpAnchor,
    snapRef,
    readVisibleTarget,
    showSavedThread,
    refresh,
    commitSnap,
    setError,
    refreshMentionBots,
    markReadIfVisible,
  });

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
    // Writing in the chat means the user has caught up, so the "New" divider goes.
    setReadBoundary({ visit: readVisit.current.visit, seq: null });
    if (pinnedAroundRef.current || jumpScrollTarget.current) showLatest();
    performScroll(scrollBehavior.current.onOwnSend());
    publishThreadScrollState(scrollBehavior.current.state());
  }

  async function send() {
    if (readOnly) return;
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
    (message: MobileMessage, answer: string, username?: string, dismiss?: boolean) =>
      answerThreadMessage(
        {
          botId,
          groupId,
          readOnly,
          rpc,
          isCurrentTarget,
          refresh,
          markRead: () => setReadBoundary({ visit: readVisit.current.visit, seq: null }),
        },
        message,
        answer,
        username,
        dismiss,
      ),
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

  const speak = useSpeakMessages({
    visibleMessages,
    botId,
    members: snap?.members,
    displayName,
    mentionBots,
  });

  const { startVoiceCall, openBotChat } = useThreadVoiceCall({
    botId,
    readOnly,
    displayName,
    mentionBots,
    mentionBotsRef,
    activeBotId,
  });

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
  const runErrorLabel = normalizedRunError ? runErrorActionLabel(t, normalizedRunError) : null;
  const runErrorAction = runErrorLabel
    ? {
        label: runErrorLabel,
        // Without a bot to change, the model settings pick the default model instead.
        onPress:
          normalizedRunError?.recovery === "model" && (snap?.run?.botId ?? botId)
            ? openErrorModel
            : openErrorConnection,
      }
    : null;

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
      const result = await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        reaction,
        clientNonce: newClientId(),
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
      void applyMessageJump({
        botId,
        groupId,
        messageId: reactionView.foldedInto.get(messageId) ?? messageId,
      }).catch(() => undefined);
    },
    dismissChoice,
    openPeerChat: (peer) => {
      if (!botId) return;
      router.push({
        pathname: "/peer-chat",
        params: { botId, botName: displayName, ...peer },
      });
    },
    togglePeerReplies,
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
          markedUnread={message.id === markedUnreadMessageId}
          replyAuthor={replyAuthor}
          replyFallbackText={parent ? previewMessageText(parent) : undefined}
          waitingForUser={[...(snap?.activeRuns ?? []), ...(snap?.run ? [snap.run] : [])].some(
            (run) =>
              run.id === message.runId &&
              (run.status === "waiting_input" || run.status === "waiting_takeover"),
          )}
          messageReactions={messageReactions}
          mentions={reactionView.mentions.get(message.id)}
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
      reactionView,
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
      markedUnreadMessageId,
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

  const workingBots =
    !inGroup && currentBot && isRunWorking(currentBotStatus) && !hasLiveProgress
      ? [
          {
            id: currentBot.id,
            name: currentBot.name,
            color: currentBot.color,
            status: currentBotStatus,
          },
        ]
      : inGroup
        ? workingGroupBots.map((bot) => ({
            id: bot.botId,
            name: bot.name,
            color: bot.color,
            status: bot.status,
          }))
        : [];
  const workingFooter = (
    <ThreadWorkingFooter
      bots={workingBots.map((bot) => ({
        ...bot,
        composing: composingBots.split(",").includes(bot.id),
      }))}
      atBottom={!threadScrollState.detached}
      label={activityLine ?? t("Working…")}
    />
  );

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <LoadEarlierButton loading={loadingOlder} onPress={() => void loadOlderMessages()} />
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
  const visibleRunError = liveEndRunError(normalizedRunError, pinnedNewerCursor);
  const errorNotice = (
    <ThreadErrorNotice
      error={null}
      summary={visibleRunError?.summary ?? null}
      resetAt={visibleRunError?.resetAt}
      onDetails={() => setRunErrorDetailsOpen(true)}
      action={visibleRunError ? runErrorAction : null}
    />
  );

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
            <JumpToLatestButton
              unread={threadScrollState.unread}
              onPress={() => {
                if (showPinnedPage) {
                  showLatest();
                  return;
                }
                performScroll(scrollBehavior.current.jumpToLatest());
                publishThreadScrollState(scrollBehavior.current.state());
              }}
            />
          ) : null}
        </View>
        <ThreadFetchErrorNotice error={error} showingSaved={showingSaved} />
        {/* Shrinks (the suggestion lists scroll) so the input and Send stay above the keyboard. */}
        <ThreadComposerDock
          hidden={readOnly}
          fadeStyle={styles.composerFade}
          replyTarget={replyTarget}
          replyAuthor={
            replyTarget?.role === "user"
              ? (channelMessageSender(replyTarget.blocks) ?? t("You"))
              : (memberName(snap?.members, replyTarget?.botId) ?? displayName ?? t("Bot"))
          }
          replyQuote={replyQuote}
          threadTarget={artifactTarget}
          onDismissReply={() => {
            setReplyTarget(null);
            setReplyQuote(null);
          }}
          attachmentNotice={attachmentNotice}
          attachments={activePendingAttachments}
          onRemoveAttachment={(id) =>
            setPendingAttachments((current) => current.filter((item) => item.id !== id))
          }
        >
          <ThreadComposer
            onFocus={keyboardLayout.onFocus}
            key={threadKey}
            ref={composerRef}
            agentSkills={agentSkills}
            composerMentionTargets={composerMentionTargets}
            onMentionRequested={onMentionRequested}
            composerPrompt={composerPrompt}
            replyTargetId={replyTarget?.id}
            replyQuote={replyQuote}
            attachmentIds={activePendingAttachments.map((attachment) => attachment.id)}
            botId={botId}
            onCall={onCall}
            working={working}
            sending={sending}
            styles={styles}
            attachActions={attachActions}
            attachFrom={attachFrom}
            send={send}
            stop={stop}
            startVoiceCall={startVoiceCall}
            onSlashAction={runSlashAction}
          />
        </ThreadComposerDock>
        {botActionsOpen ? <BotActionsModal actions={botActions} onClose={closeBotActions} /> : null}
        {selectableText !== null ? (
          <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
        ) : null}
        <RunErrorSheet
          details={runErrorDetailsOpen ? runError : null}
          onClose={() => setRunErrorDetailsOpen(false)}
          action={runErrorAction}
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
        {/* The header buttons float over the chat; only the clock gets a soft backdrop. */}
        {headerHeight > 0 ? (
          <View pointerEvents="none" style={[styles.statusBarFade, { height: insets.top }]} />
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}
