import { ChatMarkdown, withBlockMentions } from "@rakazo/chat-ui/native";
import type { LoginFieldInput, MessageBlock } from "@rakazo/contracts";
import { isAttachmentAudioMimeType } from "@rakazo/contracts";
import type { ChildBotBlock, PeerExchange } from "@rakazo/core";
import {
  formatFileSize,
  isApprovalAskBlock,
  memberName,
  selectedAskActionLabel,
} from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { ComponentProps } from "react";
import { memo, useState } from "react";
import type { TextProps } from "react-native";
import { Alert, Pressable, Text, View } from "react-native";
import type { MobileBot, MobileMessage, MobileSnapshot } from "../../lib/api";
import { blockText, messagingProviderLabel } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { openMobileArtifact } from "../../lib/artifact-open";
import { allowsSpace } from "../../lib/ask-action-label";
import { plainAskTitle } from "../../lib/ask-title";
import { t, useI18n } from "../../lib/i18n";
import { isInlineImageBlock } from "../../lib/inline-image";
import { messagePresentationSegments } from "../../lib/message-presentation";
import { useResolvedAppearance } from "../../lib/native";
import { speakerColorFor } from "../../lib/thread-message-text";
import type { UserBubble } from "../../lib/user-bubble";
import { withUserBubble } from "../../lib/user-bubble";
import { errorText } from "../../lib/user-error";
import { AppConnectCard } from "../AppConnectCard";
import { AskActions } from "../AskActions";
import { AudioAttachment } from "../audio-attachment";
import { MessageMentions } from "../bot-mention";
import { ChoiceCard } from "../ChoiceCard";
import { ComputerCard } from "../ComputerCard";
import { ChangeUndo, isUndoableChange } from "../change-undo";
import type { ImageArtifactPreviewTarget } from "../image-artifact-viewer";
import { InlineImageAttachment } from "../inline-image-attachment";
import { McpApprovalCard } from "../McpApprovalCard";
import type { MarkdownArtifactPreviewTarget } from "../markdown-artifact-preview";
import { MessageCaption } from "../message-caption";
import { NativeSymbol } from "../native-symbol";
import { PeerReceiptLine } from "../peer-receipt-line";
import { AskBlock } from "./ask-block";
import type { MessageRowActions } from "./message-row";
import { isSpecialMessageBlock, SpecialMessageCard } from "./special-message-card";

type AskAction = NonNullable<Extract<MessageBlock, { kind: "ask" }>["actions"]>[number];

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
  if (approval && answer === "allow")
    return allowsSpace(actions) ? t("Allowed in this space") : t("Allowed once");
  if (approval && answer === "always") return t("Always allowed");
  if (approval && answer === "deny") return t("Denied");
  return t("Answered: {answer}", { answer: selectedAskActionLabel(answer, actions) });
}

export type MessageActionProps = Pick<
  TextProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
>;

export const MessageBubble = memo(function MessageBubble({
  mentions,
  ...props
}: ComponentProps<typeof MessageBubbleContent> & { mentions?: readonly ChildBotBlock[] }) {
  if (!mentions?.length) return <MessageBubbleBody {...props} />;
  return (
    <MessageMentions
      mentions={mentions}
      colorOf={(id) =>
        props.bots.find((bot) => bot.id === id)?.color ??
        props.members?.find((member) => member.botId === id)?.color
      }
      avatarSetOf={(id) =>
        props.bots.find((bot) => bot.id === id)?.avatarSet ??
        props.members?.find((member) => member.botId === id)?.avatarSet
      }
      tokens={mobileTokens()}
      onOpenBot={props.onOpenBot}
    >
      <MessageBubbleBody
        {...props}
        message={{
          ...props.message,
          blocks: withBlockMentions(
            props.message.blocks,
            mentions.map((bot) => ({ id: bot.botId, name: bot.name })),
          ),
        }}
      />
    </MessageMentions>
  );
});

function MessageBubbleBody(props: ComponentProps<typeof MessageBubbleContent>) {
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
        bots={props.bots}
        members={props.members}
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
  peerExchange,
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
    fields?: readonly LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onOpenComputer: (botId: string, name: string) => void;
  onChoiceDismissed?: (question: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  onPreviewImage: (target: ImageArtifactPreviewTarget) => void;
  peerExchange?: PeerExchange;
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
  const undoBlock = message.blocks.find(isUndoableChange);
  if (undoBlock?.kind === "ask") return <ChangeUndo block={undoBlock} />;
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
          onAnswer={(answer, fields, remember) =>
            onAnswer(message, answer, fields, undefined, remember)
          }
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
    const peerBot = bots.find((bot) => bot.id === peerBotId);
    const peerMember = members?.find((member) => member.botId === peerBotId);
    const peerColor = peerBot?.color ?? peerMember?.color ?? tokens.mutedForeground;
    return (
      <PeerReceiptLine
        peerBotId={peerBotId}
        peerBotName={peerExchange?.peerBotName ?? peer ?? t("Bot")}
        color={peerColor}
        avatarSet={peerBot?.avatarSet ?? peerMember?.avatarSet}
        count={peerExchange?.count ?? 1}
        direction={sent ? "sent" : "received"}
        actionProps={actionProps}
        onPress={
          !groupId && botId && peerBotId !== botId
            ? () => onOpenPeerChat({ peerBotId, peerBotName: peer ?? t("Bot") })
            : undefined
        }
      />
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
        <Text style={{ color: tokens.mutedForeground, fontSize: 12, textAlign: "center" }}>
          {messagingProviderLabel(channelMessage.provider, channelMessage.transport)}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, textAlign: "center" }}>
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
          {isUndoableChange(askBlock) ? (
            <ChangeUndo block={askBlock} />
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
                  site={askBlock.site}
                  approval={isApprovalAskBlock(askBlock)}
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
          `${block.fromLabel} (${messagingProviderLabel(block.provider, block.transport)}): ${block.text}`,
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
    const hasInlineImages = attachments.some(isInlineImageBlock);
    const bubbleStyle = {
      maxWidth: "100%",
      borderRadius: 20,
      backgroundColor: message.role === "user" ? tokens.chatUser : tokens.muted,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 8,
    } as const;
    return (
      <View style={hasInlineImages ? { maxWidth: "100%", gap: 8 } : bubbleStyle}>
        {(showBotSenderName && speaker) || caption ? (
          <View style={hasInlineImages ? bubbleStyle : undefined}>
            {showBotSenderName && speaker ? (
              <Text
                style={{ color: speakerColor ?? tokens.mutedForeground, ...typeScale.footnote }}
              >
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
          </View>
        ) : null}
        {attachments.map((attachment, index) => (
          <View
            key={`${attachment.artifactId ?? attachment.name ?? attachment.kind}-${index}`}
            style={hasInlineImages && !isInlineImageBlock(attachment) ? bubbleStyle : undefined}
          >
            {attachment.kind === "image" ? (
              isInlineImageBlock(attachment) ? (
                <InlineImageAttachment
                  threadTarget={artifactTarget}
                  artifactId={attachment.artifactId}
                  name={attachment.name ?? t("Image")}
                  mimeType={attachment.mimeType ?? "image/png"}
                  labelColor={
                    message.role === "user" ? tokens.chatUserForeground : tokens.foreground
                  }
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
                      color:
                        message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
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
                target={artifactTarget}
                artifactId={attachment.artifactId}
                name={attachment.name ?? t("File")}
                mimeType={attachment.mimeType!}
                labelColor={message.role === "user" ? tokens.chatUserForeground : undefined}
              />
            ) : (
              <Pressable
                {...actionProps}
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
                        message.role === "user"
                          ? tokens.chatUserForeground
                          : tokens.mutedForeground,
                      marginTop: 4,
                      fontSize: 13,
                    }}
                  >
                    {formatFileSize(attachment.size)}
                  </Text>
                ) : null}
              </Pressable>
            )}
          </View>
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
