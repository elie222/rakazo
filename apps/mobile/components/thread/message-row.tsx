import { markdownCodeBlocks } from "@rakazo/chat-ui/native";
import type { BotAvatarSet, LoginFieldInput, MessageReaction } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import type { ChildBotBlock } from "@rakazo/core";
import { canMarkMessageUnread, isPeerReceiptBlocks, liveMessageComposing } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GestureResponderEvent, LayoutChangeEvent } from "react-native";
import { Platform, View } from "react-native";
import Animated, { useReducedMotion, ZoomIn } from "react-native-reanimated";
import type { MobileBot, MobileMessage, MobileSnapshot } from "../../lib/api";
import { blockText, copyableMobileMessageText, selectableMobileMessageText } from "../../lib/api";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { canDoubleTapReact } from "../../lib/double-tap";
import { useI18n } from "../../lib/i18n";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import { buildMessageContextMenu, messageMenuReaction } from "../../lib/message-context-menu";
import { messageHasInlineControls, quotableMessageSegments } from "../../lib/message-presentation";
import { messageRowLayout } from "../../lib/message-row-layout";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { selectableTextFromMarkdown } from "../../lib/selectable-text";
import { ThreadReadOnlyContext } from "../../lib/thread-read-only";
import type { UserBubble } from "../../lib/user-bubble";
import { BotAvatar } from "../bot-avatar";
import type { ImageArtifactPreviewTarget } from "../image-artifact-viewer";
import type { MarkdownArtifactPreviewTarget } from "../markdown-artifact-preview";
import { presentMessageMenu } from "../message-action-menu";
import { MessageContextMenu } from "../message-context-menu";
import { ReplyLine } from "../reply-line";
import { TimeSeparator } from "../time-separator";
import { UnreadDivider } from "../unread-divider";
import type { MessageActionProps } from "./message-bubble";
import { MessageBubble } from "./message-bubble";

export type MessageRowActions = {
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
    fields?: readonly LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
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
  markedUnread: boolean;
  replyAuthor: string;
  replyFallbackText?: string;
  waitingForUser: boolean;
  messageReactions?: ReadonlyMap<MessageReaction, number>;
  mentions?: readonly ChildBotBlock[];
  /** Set on a received marker whose peer run has folded replies. */
  peerReplies?: "collapsed" | "expanded";
  activityBotId?: string;
  activityColor?: string;
  activityAvatarSet?: BotAvatarSet;
  activityStatus?: MobileBot["status"];
  userBubble?: UserBubble;
  inGroup: boolean;
  columnWidth: number;
  enableJump: boolean;
  index: number;
};

export const MessageRow = memo(function MessageRow({
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
  markedUnread,
  replyAuthor,
  replyFallbackText,
  messageReactions,
  mentions,
  waitingForUser,
  peerReplies,
  activityBotId,
  activityColor,
  activityAvatarSet,
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
    const includeUnread = !readOnly && !markedUnread && canMarkMessageUnread(message);
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
    markedUnread,
    readOnly,
    onCall,
    colorScheme,
    t,
    locale,
    waitingForUser,
    hasLike,
    optimisticLike,
  ]);
  const layout = messageRowLayout(message.blocks, { activityBotId, inGroup, columnWidth });
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
              avatarSet={activityAvatarSet}
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
            width: layout.width,
            maxWidth: layout.maxWidth,
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
            fullWidth={layout.menuFullWidth}
            maxWidth={layout.menuMaxWidth}
            colorScheme={colorScheme}
            onAction={onMenuAction}
            onLongPress={actionProps.onLongPress}
            onDoubleTap={messageHasInlineControls(message.blocks) ? undefined : likeMessage}
          >
            <ThreadReadOnlyContext.Provider value={readOnly}>
              <MessageBubble
                mentions={mentions}
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
