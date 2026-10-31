import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import {
  buildComposerMentionOptions,
  channelMessageSender,
  chatUserBubbleColors,
  isRunWaitingOnUser,
  isRunWorking,
  liveActivityLine,
  liveMessageComposing,
  memberName,
  newClientId,
  displayName as safeDisplayName,
} from "@rakazo/core";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readableGutters } from "../../lib/adaptive-layout";
import { rpc } from "../../lib/api";
import { useAppForeground } from "../../lib/app-foreground";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { useCallSession } from "../../lib/call-session";
import { composerDraftScope } from "../../lib/composer-draft";
import { cronLabels } from "../../lib/cron";
import { useI18n } from "../../lib/i18n";
import { useThemedStyles } from "../../lib/native";
import { useInboxBot } from "../../lib/search-inbox";
import { useSplitView } from "../../lib/split-view";
import { useIncomingShareImport, useThreadAttachments } from "../../lib/thread-attachments";
import { useThreadBots } from "../../lib/thread-bots";
import {
  threadColumnPadding,
  threadHeaderClearance,
  threadHeaderFloats,
} from "../../lib/thread-edges";
import { useThreadFeedback } from "../../lib/thread-feedback";
import { useThreadFocus } from "../../lib/thread-focus";
import { useThreadSnapshot } from "../../lib/thread-history";
import { threadKeyboardAvoidance } from "../../lib/thread-keyboard-offset";
import { useThreadListScroll } from "../../lib/thread-list-scroll";
import { useThreadMentionCatalog } from "../../lib/thread-mention-catalog";
import { useThreadPaging } from "../../lib/thread-paging";
import { useThreadRead } from "../../lib/thread-read";
import {
  isOwnThreadMessage,
  latestArrivalMessage,
  latestThreadRowKey,
} from "../../lib/thread-scroll";
import { useThreadSend } from "../../lib/thread-send";
import { threadGroupMembers } from "../../lib/thread-snapshot";
import { useThreadSync } from "../../lib/thread-sync";
import { useThreadTranscript } from "../../lib/thread-transcript";
import { useAutoSpeakReply, useSpeakMessages, useThreadVoiceCall } from "../../lib/thread-voice";
import { liveEndRunError } from "../../lib/thread-window";
import { FailedSendBubble } from "../failed-send-bubble";
import type { MarkdownArtifactPreviewTarget } from "../markdown-artifact-preview";
import { MarkdownArtifactPreview } from "../markdown-artifact-preview";
import { RunErrorSheet } from "../run-error-sheet";
import { SelectTextSheet } from "../select-text-sheet";
import { ThreadComposer } from "../thread-composer";
import { ThreadErrorNotice, ThreadFetchErrorNotice } from "../thread-error-notice";
import { createThreadHeaderStyles } from "../thread-header-styles";
import { QuoteSheet } from "./quote-sheet";
import { ThreadComposerDock } from "./thread-composer-dock";
import { BotActionsModal, useThreadHeader } from "./thread-header";
import { LoadEarlierButton, ThreadWorkingFooter } from "./thread-list-controls";
import { ThreadMessageList } from "./thread-message-list";
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
  const headerClearance = threadHeaderClearance(headerHeight);
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps messages and the composer in a centred reading column.
  const columnInsets = readableGutters(windowWidth, {
    left: inboxShown ? 0 : insets.left,
    right: insets.right,
  });
  const columnWidth = windowWidth - columnInsets.left - columnInsets.right;
  // Pad the column, not the scroll view, so the indicator stays on the screen edge.
  const columnPadding = useMemo(
    () => threadColumnPadding(columnInsets),
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
  // The list's space that the composer does not cover; a read-only chat has no composer.
  const bottomInset = readOnly ? insets.bottom : 0;
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
  const attachments = useThreadAttachments({ botId, groupId, readOnly, uploadConfig });
  const draftScope = useMemo(
    () => composerDraftScope(userId, botId, groupId),
    [userId, botId, groupId],
  );
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
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const transcript = useThreadTranscript(snap?.messages, inGroup);
  const { reactionView, peerTranscript, setExpandedPeerMarkers } = transcript;
  const visibleMessages = transcript.visibleMessages;
  const latestMessage = latestArrivalMessage(reactionView.visibleMessages, peerTranscript.markerOf);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: mentionBots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
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

  const scroll = useThreadListScroll({
    history,
    threadKey,
    botId,
    groupId,
    anchor: headerClearance.anchor,
    visibleBottomInset: bottomInset,
    latestRowKey: latestThreadRowKey(
      latestMessage?.id ?? null,
      feedback.unsentSends.map((attempt) => attempt.clientNonce),
      isOwnThreadMessage(latestMessage, userId),
    ),
  });

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
    onCleared: history.clear,
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

  const paging = useThreadPaging({
    history,
    scroll,
    botId,
    groupId,
    visibleMessages,
    anchor: headerClearance.anchor,
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
    markUnread: markUnreadFrom,
    answer: composer.answer,
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
  });

  const workingBots =
    !inGroup && currentBot && isRunWorking(currentBotStatus) && !hasLiveProgress
      ? [
          {
            id: currentBot.id,
            name: currentBot.name,
            color: currentBot.color,
            avatarSet: currentBot.avatarSet,
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
      label={activityLine ?? t("Working…")}
    />
  );

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <LoadEarlierButton
        loading={paging.loadingOlder}
        onPress={() => void paging.loadOlderMessages()}
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
        <ThreadMessageList
          scroll={scroll}
          pinnedListHandlers={paging.pinnedListHandlers}
          threadKey={threadKey}
          headerClearance={headerClearance}
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
        <ThreadFetchErrorNotice error={error} showingSaved={showingSaved} style={columnPadding} />
        {/* Shrinks (the suggestion lists scroll) so the input and Send stay above the keyboard. */}
        <ThreadComposerDock
          hidden={readOnly}
          columnPadding={columnPadding}
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
          attachmentNotice={attachments.attachmentNotice}
          attachments={attachments.activePendingAttachments}
          onRemoveAttachment={(id) =>
            attachments.setPendingAttachments((current) => current.filter((item) => item.id !== id))
          }
        >
          <ThreadComposer
            key={threadKey}
            ref={composer.composerRef}
            draftScope={draftScope}
            agentSkills={agentSkills}
            composerMentionTargets={composerMentionTargets}
            onMentionRequested={onMentionRequested}
            composerPrompt={composerPrompt}
            replyTargetId={replyTarget?.id}
            replyQuote={replyQuote}
            attachmentIds={attachments.activePendingAttachments.map((attachment) => attachment.id)}
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
          />
        </ThreadComposerDock>
        {botActionsOpen ? <BotActionsModal actions={botActions} onClose={closeBotActions} /> : null}
        {selectableText !== null ? (
          <SelectTextSheet text={selectableText} onClose={() => setSelectableText(null)} />
        ) : null}
        <RunErrorSheet
          details={detailsOpen ? runError : null}
          onClose={() => setDetailsOpen(false)}
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
