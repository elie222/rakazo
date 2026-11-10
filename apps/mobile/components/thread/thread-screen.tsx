import type { AgentSkillCatalogEntry, ModelRoleChoice } from "@rakazo/contracts";
import {
  buildComposerMentionOptions,
  channelMessageSender,
  chatUserBubbleColors,
  isRunWaitingOnUser,
  isRunWorking,
  liveActivityLine,
  liveMessageComposing,
  memberName,
  modelOptionKey,
  newClientId,
  newestPageCards,
  otherAuthor,
  displayName as safeDisplayName,
  selectableMessageText,
  workingRoutineName,
} from "@rakazo/core";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { I18nManager, Platform, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readableGutters } from "../../lib/adaptive-layout";
import { rpc } from "../../lib/api";
import { useAppForeground } from "../../lib/app-foreground";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { useCallSession } from "../../lib/call-session";
import { useChatBackground } from "../../lib/chat-background";
import { composerDraftScope } from "../../lib/composer-draft";
import { useComposerThinkingLevel } from "../../lib/composer-thinking-level";
import { useComputerFloatEnabled } from "../../lib/computer-float-settings";
import { cronLabels } from "../../lib/cron";
import { useI18n } from "../../lib/i18n";
import type { MobileModel, MobileModelCredential } from "../../lib/mobile-types";
import { useThemedStyles } from "../../lib/native";
import { useChatOnScreen } from "../../lib/page-card-detail";
import { useInboxBot } from "../../lib/search-inbox";
import { useSplitView } from "../../lib/split-view";
import { useIncomingShareImport, useThreadAttachments } from "../../lib/thread-attachments";
import { useThreadBots } from "../../lib/thread-bots";
import { threadColumnPadding, threadHeaderFloats } from "../../lib/thread-edges";
import {
  favoriteSnippet,
  toggleThreadFavorite,
  useThreadFavorites,
} from "../../lib/thread-favorites";
import { useThreadFeedback } from "../../lib/thread-feedback";
import { useThreadFocus } from "../../lib/thread-focus";
import { useThreadSnapshot } from "../../lib/thread-history";
import { threadKeyboardAvoidance } from "../../lib/thread-keyboard-offset";
import { useThreadListScroll } from "../../lib/thread-list-scroll";
import { useThreadMentionCatalog } from "../../lib/thread-mention-catalog";
import { useThreadPaging } from "../../lib/thread-paging";
import { useThreadRead } from "../../lib/thread-read";
import { buildRegeneratePayload, previousUserMessageText } from "../../lib/thread-regenerate";
import {
  isOwnThreadMessage,
  latestArrivalMessage,
  latestThreadRowKey,
} from "../../lib/thread-scroll";
import { searchThreadMessages, stepSearchIndex } from "../../lib/thread-search";
import { useThreadSend } from "../../lib/thread-send";
import { threadGroupMembers } from "../../lib/thread-snapshot";
import { useThreadSync } from "../../lib/thread-sync";
import { useThreadTranscript } from "../../lib/thread-transcript";
import { useAutoSpeakReply, useSpeakMessages, useThreadVoiceCall } from "../../lib/thread-voice";
import { liveEndRunError } from "../../lib/thread-window";
import { getVoicePlaybackState, stopVoicePlayback, subscribeVoicePlayback } from "../../lib/voice";
import { CHAT_TITLE_HERO_MAX_HEIGHT, ChatTitleHero } from "../chat-title-hero";
import { FailedSendBubble } from "../failed-send-bubble";
import { NativeSymbol } from "../native-symbol";
import { NewestPageCards } from "../pages/page-card";
import { RunErrorSheet } from "../run-error-sheet";
import { SelectTextSheet } from "../select-text-sheet";
import { ThreadComposer } from "../thread-composer";
import { ThreadErrorNotice, ThreadFetchErrorNotice } from "../thread-error-notice";
import { createThreadHeaderStyles } from "../thread-header-styles";
import { ChatBackgroundLayer } from "./chat-background-layer";
import { ComputerFloatWindow } from "./computer-float-window";
import { QuoteSheet } from "./quote-sheet";
import { ThreadBackgroundSheet } from "./thread-background-sheet";
import { ThreadBotMenuSheet } from "./thread-bot-menu-sheet";
import { ThreadComposerChips } from "./thread-composer-chips";
import { ThreadComposerDock } from "./thread-composer-dock";
import { ThreadFavoritesSheet } from "./thread-favorites-sheet";
import { useThreadHeader } from "./thread-header";
import { LoadEarlierButton, ThreadWorkingFooter } from "./thread-list-controls";
import { ThreadMessageList } from "./thread-message-list";
import type { ThreadModelPickerRole, ThreadModelSave } from "./thread-model-picker-sheet";
import { ThreadModelPickerSheet } from "./thread-model-picker-sheet";
import { useLatestRowActions, useThreadRows } from "./thread-rows";
import { useThreadRunError } from "./thread-run-error";

function isActiveStatus(status: string | undefined): boolean {
  return isRunWorking(status) || isRunWaitingOnUser(status);
}

/**
 * The chat screen. Hook order is effect order: the snapshot, scroll, sync and send hooks run their
 * effects at the positions the screen ran them before they were split out.
 */
export function Thread({ sessionEpoch, userId }: { sessionEpoch: number; userId: string }) {
  useChatOnScreen();
  const tokens = mobileTokens();
  const styles = useThemedStyles(createThreadHeaderStyles);
  const { t, locale } = useI18n();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const router = useRouter();
  // Beside the chat list on a wide window, the chat has only the width the list leaves.
  const { inboxShown, contentWidth: windowWidth } = useSplitView();
  const nativeHeaderHeight = useHeaderHeight();
  const headerHeight = threadHeaderFloats() ? nativeHeaderHeight : 0;
  // The hero sits flush against the native header's bottom edge, zero gap: on Android
  // the screen content already starts below the solid header, so top 0 is flush; on iOS
  // the header floats over the content, so the hero starts at the header's bottom edge.
  // Any gap here lets the scrolling conversation show through above the avatar, and the
  // hollowed-out hero (transparent, no white box) has nothing to hide it behind.
  const heroTop = threadHeaderFloats() ? nativeHeaderHeight : 0;
  // The conversation search bar, a 48pt pill under the native header: the hero
  // and the list's top clearance shift down while it is open.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchBarHeight = searchOpen ? 48 : 0;
  // The list's top clearance always reserves the hero's full height, so the
  // oldest message starts below the hero instead of scrolling underneath it. The
  // height is a layout constant, never measured, so the clearance and the hero can never
  // disagree and leave a gap for the conversation to show through.
  const listClearance = {
    padding: heroTop + CHAT_TITLE_HERO_MAX_HEIGHT + searchBarHeight,
    anchor: heroTop + 20,
    minHeight: heroTop,
  };
  // The model catalog and connections, shared by the shortcut row and the
  // composer's reasoning control; the shortcut row used to fetch them itself.
  const [modelCatalog, setModelCatalog] = useState<MobileModel[] | null>(null);
  const [modelCredentials, setModelCredentials] = useState<MobileModelCredential[] | null>(null);
  // The model saved from the sheet, until the chat's bot list catches up with it.
  const [mainOverride, setMainOverride] = useState<ThreadModelSave | null>(null);
  // The computer model, fetched here so the shortcut row and the bot menu share one picker.
  const [computerChoice, setComputerChoice] = useState<ModelRoleChoice | null>(null);
  const [sheetRole, setSheetRole] = useState<ThreadModelPickerRole | null>(null);
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps messages and the composer in a centred reading column.
  const columnInsets = readableGutters(windowWidth, {
    left: inboxShown ? 0 : insets.left,
    right: insets.right,
  });
  const columnWidth = windowWidth - columnInsets.left - columnInsets.right;
  const columnPadding = useMemo(
    () => threadColumnPadding(columnInsets, I18nManager.isRTL),
    [columnInsets.left, columnInsets.right],
  );
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
  // The composer floats over the list, which scrolls underneath; this keeps the newest message
  // clear of it. A read-only chat has no composer.
  const [dockHeight, setDockHeight] = useState(0);
  const bottomInset = Math.max(dockHeight, readOnly ? insets.bottom : 0);
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
  const markCaughtUp = () => setReadBoundary({ visit: readVisit.current.visit, seq: null });
  const artifactTarget: MobileArtifactTarget | undefined = groupId
    ? { groupId }
    : botId
      ? { botId }
      : undefined;
  const history = useThreadSnapshot();
  const { snap, composingBots, showingSaved } = history;
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [uploadConfig, setUploadConfig] = useState<{
    maxUploadSizeBytes?: number;
    maxAttachmentsPerMessage?: number;
  }>();
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
  const draftScope = useMemo(
    () => composerDraftScope(userId, botId, groupId),
    [userId, botId, groupId],
  );
  const attachments = useThreadAttachments({ botId, groupId, readOnly, uploadConfig, draftScope });
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
  const [selectableText, setSelectableText] = useState<string | null>(null);
  const transcript = useThreadTranscript(snap?.messages, inGroup);
  const { reactionView, peerTranscript, setExpandedPeerMarkers } = transcript;
  const visibleMessages = transcript.visibleMessages;
  // The thread's favorites and background, both local to the device; the
  // search matches only the loaded window.
  const favorites = useThreadFavorites(threadKey);
  const favoriteIds = useMemo(() => new Set(favorites.map((item) => item.messageId)), [favorites]);
  const background = useChatBackground(threadKey);
  const searchMatches = useMemo(
    () => (searchQuery.trim() ? searchThreadMessages(visibleMessages, searchQuery) : []),
    [visibleMessages, searchQuery],
  );
  const searchHitIds = useMemo(
    () => new Set(searchMatches.map((message) => message.id)),
    [searchMatches],
  );
  const searchCurrentId = searchMatches[searchIndex]?.id ?? null;
  const newestPages = useMemo(() => newestPageCards(visibleMessages), [visibleMessages]);
  const latestMessage = latestArrivalMessage(reactionView.visibleMessages, peerTranscript.markerOf);
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
          avatarSet: bot.avatarSet,
        })),
        groups: mentionGroups.map((group) => ({ id: group.id, name: group.name })),
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
  useEffect(() => {
    setMainOverride(null);
  }, [currentBot?.modelProvider, currentBot?.modelId]);
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void Promise.all([rpc("models/list"), rpc("models/credentials")])
      .then(([list, credentials]) => {
        if (cancelled) return;
        setModelCatalog(list as MobileModel[]);
        setModelCredentials(credentials as MobileModelCredential[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void rpc("models/role", { role: "computer", expectedUserId: userId, scope: "account" })
      .then((view: { primary?: ModelRoleChoice | null }) => {
        if (cancelled) return;
        setComputerChoice(view.primary ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, userId]);
  const thinkingLevel = useComposerThinkingLevel({
    botId,
    bot: currentBot,
    mainOverride,
    catalog: modelCatalog,
    credentials: modelCredentials,
  });
  // Until the chat's own roster arrives, the bot as the inbox last loaded it.
  const inboxBot = useInboxBot(botId);
  const titleBot = currentBot ?? inboxBot;
  // Without a name yet (a notification can leave it out), the title shows a placeholder.
  const titleName = currentBot?.name ?? name ?? inboxBot?.name;
  const displayName = safeDisplayName(titleName, inGroup ? t("Group") : t("Bot"));
  const composerPrompt = t("Message or hold to talk…");
  const notificationThreadId = snap?.threadId ?? requestedThreadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const currentBotStatus =
    snap && (!showingSaved || error)
      ? snap.run?.status
      : (titleBot?.threadStatus ?? snap?.run?.status);
  // The group's members in its order, once the chat or its group list has loaded them; the
  // title seats the inbox's copy until then.
  const groupMembers = threadGroupMembers(groupId, snap, mentionGroups);
  // Only reply text being written replaces the footer; earlier sentences above a tool call don't.
  const hasLiveProgress = visibleMessages.some(
    (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
  );
  const activityLine = liveActivityLine(snap?.messages ?? []);
  const workingRoutine = workingRoutineName(snap?.activeRuns ?? (snap?.run ? [snap.run] : []));
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

  const scroll = useThreadListScroll({
    history,
    threadKey,
    botId,
    groupId,
    anchor: listClearance.anchor,
    visibleBottomInset: bottomInset,
    latestRowKey: latestThreadRowKey(
      latestMessage?.id ?? null,
      feedback.unsentSends.map((attempt) => attempt.clientNonce),
      isOwnThreadMessage(latestMessage, userId),
    ),
  });

  // Header auto-read toggle: flips this bot's autoSpeak and refreshes the roster so the
  // header re-renders. A failed save leaves the toggle where it was. Turning auto-read
  // off stops a reply that is being read aloud right now.
  const toggleAutoSpeak = useCallback(() => {
    if (!botId || !currentBot || inGroup || readOnly) return;
    const next = !currentBot.autoSpeak;
    if (currentBot.autoSpeak) stopVoicePlayback();
    void rpc("bots/update", { botId, autoSpeak: next })
      .then(() => refreshMentionBots())
      .catch(() => undefined);
  }, [botId, currentBot, inGroup, readOnly, refreshMentionBots]);

  // The computer screen float opens only from its header entry, never on its own. The
  // settings switch gates it per bot; off means no entry and no window, even mid-run.
  // The header entry opens the system popup: the live screen pops out to the system
  // floating window, which the phone can enlarge and operate; the in-app float is
  // only the fallback when the system window cannot show.
  const computerFloatEnabled = useComputerFloatEnabled(botId);
  const [computerFloatOpen, setComputerFloatOpen] = useState(false);
  const [computerFloatSystemOnly, setComputerFloatSystemOnly] = useState(false);

  useThreadHeader({
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
    onCleared: history.clear,
    autoSpeak: !inGroup ? currentBot?.autoSpeak : undefined,
    onToggleAutoSpeak: !inGroup && !readOnly && botId && currentBot ? toggleAutoSpeak : undefined,
    onOpenSearch: () => setSearchOpen(true),
    computerFloatEnabled,
    onOpenComputerFloat:
      !inGroup && !readOnly && botId && computerFloatEnabled
        ? () => {
            setComputerFloatSystemOnly(true);
            setComputerFloatOpen(true);
          }
        : undefined,
  });

  useThreadFocus({
    botId,
    readOnly,
    notificationThreadId,
    refreshMentionBots,
    markReadIfVisible,
    speakFinishedReplyRef,
  });

  const { isCurrentTarget, refresh, applyMessageJump, showLatest } = useThreadSync({
    history,
    scroll,
    botId,
    groupId,
    messageId,
    readOnly,
    foreground,
    focused,
    sessionEpoch,
    activeBotId,
    activeGroupId,
    readVisibleTarget,
    setExpandedPeerMarkers,
    setError,
    onRefreshed: feedback.refreshed,
    refreshMentionBots,
    markReadIfVisible,
  });

  // The search steps only on an explicit prev/next tap, never per keystroke: a
  // jump per keystroke would re-page the conversation on every character.
  const stepSearch = (delta: 1 | -1) => {
    const next = stepSearchIndex(searchIndex, searchMatches.length, delta);
    setSearchIndex(next);
    const hit = searchMatches[next];
    if (hit) void applyMessageJump({ botId, groupId, messageId: hit.id }).catch(() => undefined);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
    showLatest();
  };

  const paging = useThreadPaging({
    history,
    scroll,
    botId,
    groupId,
    visibleMessages,
    anchor: listClearance.anchor,
    setError,
    showLatest,
  });

  const composer = useThreadSend({
    botId,
    groupId,
    readOnly,
    threadKey,
    history,
    scroll,
    feedback,
    attachments,
    mentionBotsRef,
    activeBotId,
    activeGroupId,
    isCurrentTarget,
    refresh,
    showLatest,
    markCaughtUp,
    // The voice hook below owns bot switching; a send only switches after this render.
    openBotChat: (target, ring) => openBotChat(target, ring),
  });
  const { replyTarget, setReplyTarget, replyQuote, setReplyQuote, quoteTarget, setQuoteTarget } =
    composer;
  // A reply tapped on one of this chat's pages, full screen, lands in the composer unsent.
  useFocusEffect(composer.receivePageReply);
  useIncomingShareImport({
    attachments,
    composerRef: composer.composerRef,
    readOnly,
    threadKey,
    uploadConfig,
  });

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

  const { runError, normalizedRunError, runErrorAction, detailsOpen, setDetailsOpen } =
    useThreadRunError(snap?.run, botId);

  // Event actions read the latest committed screen state without invalidating settled rows.
  const rowActions = useLatestRowActions({
    helperToggle: scroll.helperToggle,
    reply: (message) => {
      setReplyTarget(message);
      setReplyQuote(null);
    },
    quote: setQuoteTarget,
    select: setSelectableText,
    speak,
    react: composer.react,
    favorite: (message) => {
      if (!threadKey) return;
      toggleThreadFavorite(threadKey, {
        messageId: message.id,
        snippet: favoriteSnippet(selectableMessageText(message)),
        createdAt: Date.now(),
      });
    },
    regenerate: (message) => {
      if (readOnly) return;
      const originThreadKey = groupId ?? botId;
      if (!originThreadKey) return;
      const text = previousUserMessageText(history.snapRef.current?.messages ?? [], message.id);
      if (!text) return;
      try {
        composer.retry(
          feedback.sendAttempt(
            buildRegeneratePayload({
              text,
              originThreadKey,
              botTarget: botId,
              groupTarget: groupId,
            }),
          ),
        );
      } catch {
        feedback.setError(t("Failed to send message"));
        return;
      }
    },
    markUnread: markUnreadFrom,
    answer: composer.answer,
    openBot,
    openComputer,
    // A chat attachment opens the version it was sent with, not the newest.
    previewFile: (artifactId) =>
      router.push({ pathname: "/artifact", params: { artifactId, exact: "1" } }),
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
    dismissChoice: transcript.dismissChoice,
    openPeerChat: (peer) => {
      if (!botId) return;
      router.push({
        pathname: "/peer-chat",
        params: {
          botId,
          botName: displayName,
          botColor: currentBot?.color,
          peerBotColor: mentionBots.find((bot) => bot.id === peer.peerBotId)?.color,
          ...peer,
        },
      });
    },
    layout: scroll.layoutJumpRow,
  });

  // The player bar reads the same state; a row's speaker icon pulses only
  // while its own message is the one playing.
  const playback = useSyncExternalStore(subscribeVoicePlayback, getVoicePlaybackState);

  const { liveItems, renderMessageRow, renderItem } = useThreadRows({
    snap,
    userId,
    transcript,
    rowActions,
    botId,
    groupId,
    inGroup,
    readOnly,
    onCall,
    displayName,
    mentionBots,
    currentBot,
    currentBotStatus,
    userBubble,
    columnWidth,
    readSeq: readBoundary?.visit === readVisit.current.visit ? readBoundary.seq : null,
    markedUnreadMessageId,
    highlightedMessageId: scroll.highlightedMessageId,
    speakingMessageId: playback.status === "playing" ? playback.messageId : undefined,
    favoriteIds,
    searchHitIds,
    searchCurrentId,
  });

  const workingBots =
    !inGroup && titleBot && isRunWorking(currentBotStatus) && !hasLiveProgress
      ? [
          {
            id: titleBot.id,
            name: titleBot.name,
            color: titleBot.color,
            avatarSet: titleBot.avatarSet,
            status: currentBotStatus,
          },
        ]
      : inGroup
        ? workingGroupBots.map((bot) => ({
            id: bot.botId,
            name: bot.name,
            color: bot.color,
            avatarSet: bot.avatarSet,
            status: bot.status,
          }))
        : [];
  const workingFooter = (
    <ThreadWorkingFooter
      bots={workingBots.map((bot) => ({
        ...bot,
        composing: composingBots.split(",").includes(bot.id),
      }))}
      atBottom={!scroll.state.detached}
      label={
        activityLine ??
        (workingRoutine ? t("Running {name}…", { name: workingRoutine }) : t("Working…"))
      }
    />
  );

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <LoadEarlierButton
        loading={paging.loadingOlder}
        onPress={() => void paging.loadOlderMessages()}
      />
    ) : null;

  // The big title hero, at the top of a one-to-one chat: the 88pt state-linked avatar with
  // the bot's name under it. Groups keep only their native title. It floats above the message list
  // instead of scrolling with it, so it stays visible; the list's top clearance makes room
  // for it, and the capsule in the native bar stays as the title when scrolled. No live
  // process line here — the top bar shows no real-time process. Tapping the avatar opens
  // the bot menu.
  const titleComposing = Boolean(botId) && composingBots.split(",").includes(botId ?? "");
  const chatHero =
    !inGroup && botId ? (
      <ChatTitleHero
        bot={titleBot}
        status={currentBotStatus}
        composing={titleComposing}
        name={titleName}
        onAvatarPress={() => setBotMenuOpen(true)}
      />
    ) : null;

  const failedSendBubbles = feedback.unsentSends.map((attempt) => (
    <FailedSendBubble
      key={attempt.clientNonce}
      attempt={attempt}
      needsModel={needsModel}
      onRetry={() => composer.retry(attempt)}
      onDelete={() => feedback.discard(attempt)}
      userBubble={userBubble}
    />
  ));

  // Fetch failures stay visible at either paging edge; provider recovery belongs to the live end.
  const visibleRunError = liveEndRunError(normalizedRunError, scroll.pinnedNewerCursor);
  const errorNotice = (
    <ThreadErrorNotice
      error={null}
      summary={visibleRunError?.summary ?? null}
      resetAt={visibleRunError?.resetAt}
      onDetails={() => setDetailsOpen(true)}
      action={visibleRunError ? runErrorAction : null}
    />
  );

  const mainProvider = mainOverride !== null ? mainOverride.provider : currentBot?.modelProvider;
  const mainModelId = mainOverride !== null ? mainOverride.modelId : currentBot?.modelId;
  const sheetKey =
    sheetRole === "main"
      ? mainProvider && mainModelId
        ? modelOptionKey(mainProvider, mainModelId)
        : ""
      : computerChoice
        ? modelOptionKey(computerChoice.provider, computerChoice.modelId)
        : "";

  return (
    <View style={{ flex: 1 }}>
      <KeyboardAvoidingView
        // Padding always settles to zero. "height" stays shrunk when the keyboard hides without
        // move frames, such as when a pushed screen closes with its own keyboard up.
        behavior="padding"
        {...threadKeyboardAvoidance({
          os: Platform.OS,
          floatingHeader: threadHeaderFloats(),
          nativeHeaderHeight,
        })}
        style={{
          flex: 1,
          backgroundColor: tokens.background,
        }}
      >
        {/* The keyboard's padding shrinks this, so the floating composer rides above it. */}
        <View style={{ flex: 1, position: "relative" }}>
          <ChatBackgroundLayer threadKey={threadKey} />
          <NewestPageCards.Provider value={newestPages}>
            <ThreadMessageList
              scroll={scroll}
              pinnedListHandlers={paging.pinnedListHandlers}
              threadKey={threadKey}
              headerClearance={listClearance}
              bottomInset={bottomInset}
              columnPadding={columnPadding}
              visibleMessages={visibleMessages}
              liveItems={liveItems}
              renderItem={renderItem}
              renderMessageRow={renderMessageRow}
              loadEarlierControl={loadEarlierControl}
              failedSendBubbles={failedSendBubbles}
              errorNotice={errorNotice}
              workingFooter={workingFooter}
              loadingNewer={paging.loadingNewer}
              showLatest={showLatest}
            />
          </NewestPageCards.Provider>
          {/* The title hero floats above the list, flush against the native header with
              zero gap, and never scrolls away; it paints a solid background, so the
              scrolling conversation can never show through it. Only the avatar
              intercepts touches, so the list still scrolls under the hero. */}
          {chatHero ? (
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                top: heroTop + searchBarHeight,
                left: 0,
                right: 0,
                backgroundColor: tokens.background,
              }}
            >
              {chatHero}
            </View>
          ) : null}
          {searchOpen ? (
            <View
              style={{
                position: "absolute",
                top: heroTop,
                left: 0,
                right: 0,
                height: 48,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                backgroundColor: tokens.background,
              }}
            >
              <NativeSymbol
                ios="magnifyingglass"
                android="search-outline"
                size={18}
                color={tokens.mutedForeground}
              />
              <TextInput
                value={searchQuery}
                onChangeText={(text) => {
                  setSearchQuery(text);
                  setSearchIndex(0);
                }}
                placeholder={t("Search conversation…")}
                placeholderTextColor={tokens.mutedForeground}
                autoFocus
                returnKeyType="search"
                onSubmitEditing={() => stepSearch(1)}
                style={{ flex: 1, fontSize: 16, color: tokens.foreground }}
              />
              {searchQuery.trim() ? (
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {searchMatches.length > 0
                    ? t("Result {current} of {total}", {
                        current: searchIndex + 1,
                        total: searchMatches.length,
                      })
                    : t("No results")}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Previous result")}
                disabled={searchMatches.length === 0}
                hitSlop={8}
                onPress={() => stepSearch(-1)}
              >
                <NativeSymbol
                  ios="chevron.up"
                  android="chevron-up-outline"
                  size={18}
                  color={tokens.foreground}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Next result")}
                disabled={searchMatches.length === 0}
                hitSlop={8}
                onPress={() => stepSearch(1)}
              >
                <NativeSymbol
                  ios="chevron.down"
                  android="chevron-down-outline"
                  size={18}
                  color={tokens.foreground}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Close search")}
                hitSlop={8}
                onPress={closeSearch}
              >
                <NativeSymbol
                  ios="xmark"
                  android="close-outline"
                  size={18}
                  color={tokens.foreground}
                />
              </Pressable>
            </View>
          ) : null}
          {/* Shrinks (the suggestion lists scroll) so the input and Send stay above the keyboard. */}
          <ThreadComposerDock
            hidden={readOnly}
            columnPadding={columnPadding}
            notice={<ThreadFetchErrorNotice error={error} showingSaved={showingSaved} />}
            onHeight={setDockHeight}
            replyTarget={replyTarget}
            replyAuthor={
              replyTarget?.role === "user"
                ? (otherAuthor(replyTarget.author, userId)?.name ??
                  channelMessageSender(replyTarget.blocks) ??
                  t("You"))
                : (memberName(snap?.members, replyTarget?.botId) ?? displayName ?? t("Bot"))
            }
            replyQuote={replyQuote}
            threadTarget={artifactTarget}
            onDismissReply={() => {
              setReplyTarget(null);
              setReplyQuote(null);
            }}
            attachmentNotice={attachments.attachmentNotice}
            attachments={attachments.activePendingAttachments}
            onRemoveAttachment={(id) =>
              attachments.setPendingAttachments((current) =>
                current.filter((item) => item.id !== id),
              )
            }
          >
            <ThreadComposerChips
              botId={botId}
              currentBot={currentBot}
              userId={userId}
              catalog={modelCatalog}
              mainOverride={mainOverride}
              computerChoice={computerChoice}
              onPickModel={setSheetRole}
              favoriteCount={favorites.length}
              onOpenFavorites={() => setFavoritesOpen(true)}
              backgroundLabel={
                !background
                  ? t("Default")
                  : background.kind === "image"
                    ? t("Local image")
                    : background.kind === "video"
                      ? t("Video")
                      : t("URL subscription")
              }
              onOpenBackground={() => setBackgroundOpen(true)}
            />
            <ThreadComposer
              key={threadKey}
              ref={composer.composerRef}
              draftScope={draftScope}
              agentSkills={agentSkills}
              composerMentionTargets={composerMentionTargets}
              onMentionRequested={onMentionRequested}
              composerPrompt={composerPrompt}
              thinkingLevel={thinkingLevel}
              replyTargetId={replyTarget?.id}
              replyQuote={replyQuote}
              attachmentIds={attachments.activePendingAttachments.map(
                (attachment) => attachment.id,
              )}
              botId={botId}
              onCall={onCall}
              working={working}
              sending={composer.sending || attachments.shareImporting}
              styles={styles}
              attachActions={attachments.attachActions}
              attachFrom={attachments.attachFrom}
              send={composer.send}
              stop={composer.stop}
              startVoiceCall={startVoiceCall}
              onSlashAction={composer.runSlashAction}
              onEmptied={composer.composerEmptied}
            />
          </ThreadComposerDock>
        </View>
        {selectableText !== null ? (
          <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
        ) : null}
        {sheetRole ? (
          <ThreadModelPickerSheet
            visible
            role={sheetRole}
            botId={botId ?? ""}
            userId={userId}
            selectedKey={sheetKey}
            onClose={() => setSheetRole(null)}
            onSaved={(choice) => {
              if (sheetRole === "main") {
                setMainOverride(choice);
              } else {
                setComputerChoice(
                  choice.provider && choice.modelId
                    ? { provider: choice.provider, modelId: choice.modelId }
                    : null,
                );
              }
            }}
          />
        ) : null}
        <ThreadBotMenuSheet
          visible={botMenuOpen}
          botId={botId}
          onClose={() => setBotMenuOpen(false)}
          onPickModel={setSheetRole}
        />
        <ThreadFavoritesSheet
          visible={favoritesOpen}
          threadKey={threadKey}
          onClose={() => setFavoritesOpen(false)}
          onJump={(messageId) => {
            void applyMessageJump({ botId, groupId, messageId }).catch(() => undefined);
          }}
        />
        <ThreadBackgroundSheet
          visible={backgroundOpen}
          threadKey={threadKey}
          onClose={() => setBackgroundOpen(false)}
        />
        <RunErrorSheet
          details={detailsOpen ? runError : null}
          onClose={() => setDetailsOpen(false)}
          action={runErrorAction}
        />
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
      <ComputerFloatWindow
        botId={botId}
        open={computerFloatOpen && computerFloatEnabled}
        systemOnly={computerFloatSystemOnly}
        onClose={() => {
          setComputerFloatOpen(false);
          setComputerFloatSystemOnly(false);
        }}
      />
    </View>
  );
}
