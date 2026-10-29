import type { ThreadItem } from "@rakazo/core";
import {
  answerableAskMessageIds,
  dismissableAskMessageIds,
  groupVoiceChats,
  memberName,
  timeSeparatorIds,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
} from "@rakazo/core";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ListRenderItemInfo } from "react-native";
import { StyleSheet, View } from "react-native";
import type { MobileBot, MobileMessage, MobileSnapshot } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { threadHeaderFloats } from "../../lib/thread-edges";
import { previewMessageText } from "../../lib/thread-message-text";
import type { useThreadTranscript } from "../../lib/thread-transcript";
import type { UserBubble } from "../../lib/user-bubble";
import { TimeSeparator } from "../time-separator";
import { UnreadDivider } from "../unread-divider";
import { VoiceChatCard } from "../VoiceChatCard";
import type { MessageRowActions } from "./message-row";
import { MessageRow } from "./message-row";

const rowStyles = StyleSheet.create({
  row: { marginTop: 12, width: "100%" },
});

/** Stable row actions that call the latest screen actions, so settled rows don't re-render. */
export function useLatestRowActions(current: MessageRowActions): MessageRowActions {
  const rowActionsRef = useRef(current);
  useLayoutEffect(() => {
    rowActionsRef.current = current;
  });
  return useMemo<MessageRowActions>(
    () => ({
      helperToggle: (measure, toggle, opening) =>
        rowActionsRef.current.helperToggle(measure, toggle, opening),
      reply: (message) => rowActionsRef.current.reply(message),
      quote: (message) => rowActionsRef.current.quote(message),
      select: (text) => rowActionsRef.current.select(text),
      speak: (message) => rowActionsRef.current.speak(message),
      react: (message, reaction) => rowActionsRef.current.react(message, reaction),
      markUnread: (message) => rowActionsRef.current.markUnread(message),
      answer: (message, answer, fields, dismiss, remember) =>
        rowActionsRef.current.answer(message, answer, fields, dismiss, remember),
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
}

/** Renders the chat's message rows and voice call cards for the live list and pinned pages. */
export function useThreadRows({
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
  readSeq,
  markedUnreadMessageId,
  highlightedMessageId,
}: {
  snap: MobileSnapshot | null;
  userId: string;
  transcript: ReturnType<typeof useThreadTranscript>;
  rowActions: MessageRowActions;
  botId?: string;
  groupId?: string;
  inGroup: boolean;
  readOnly: boolean;
  onCall: boolean;
  displayName?: string;
  mentionBots: MobileBot[];
  currentBot?: MobileBot;
  currentBotStatus?: string;
  userBubble?: UserBubble;
  columnWidth: number;
  /** What the user had read up to when this visit began. */
  readSeq: number | null;
  markedUnreadMessageId?: string;
  highlightedMessageId: string | null;
}) {
  const { t, locale } = useI18n();
  const { showBotSenderName, peerTranscript, reactionView, expandedPeerMarkers } = transcript;
  const visibleMessages = reactionView.visibleMessages;
  const answerableAskIds = useMemo(() => answerableAskMessageIds(snap), [snap]);
  const dismissableAskIds = useMemo(() => dismissableAskMessageIds(snap, userId), [snap, userId]);
  const separatorIds = useMemo(() => timeSeparatorIds(visibleMessages), [visibleMessages]);
  const unreadDividerId = useMemo(
    () => unreadDividerMessageId(visibleMessages, readSeq, snap?.olderCursor ?? null),
    [visibleMessages, readSeq, snap?.olderCursor],
  );
  // Group calls in reading order, then reverse for the inverted list.
  const liveItems = useMemo(() => groupVoiceChats(visibleMessages).reverse(), [visibleMessages]);
  const messagesById = useMemo(
    () => new Map((snap?.messages ?? []).map((message) => [message.id, message])),
    [snap?.messages],
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
          activityAvatarSet={activityBot?.avatarSet}
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
            rowStyles.row,
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

  return { liveItems, renderMessageRow, renderItem };
}
