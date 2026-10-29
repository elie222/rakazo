import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText, withBlockMentions } from "@rakazo/chat-ui/web";
import type {
  BotAvatarSet,
  LoginFieldInput,
  MessageReaction,
  ThreadMessage,
} from "@rakazo/contracts";
import type { ChildBotBlock } from "@rakazo/core";
import { isPeerReceiptBlocks, isSecretAskBlock, isToolActivityBlock } from "@rakazo/core";
import { BotAvatar, Button, cn, resolvePersonaColorDef } from "@rakazo/ui-web";
import { UserRound } from "lucide-react";
import { memo, useMemo } from "react";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../../components/CloudAgentCard";
import { SubagentCard } from "../../components/SubagentCard";
import {
  LIVE_TOOL_STEP_WINDOW,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "../../components/ToolActivityDisclosure";
import { SkillDraftCard } from "../../components/teach/SkillDraftCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { messageProviderLabel } from "../../lib/messaging";
import {
  isToolOnlyNarration,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "../../lib/tool-activity-view";
import { ReplyLine } from "./chat-context";
import { FALLBACK_BOT_COLOR, previewMessageText } from "./chat-shared";
import type { ImportSetupTarget } from "./import-setup-card";
import { ImportSetupCard } from "./import-setup-card";
import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./message-cards";
import { MessageHoverActions } from "./message-hover-actions";

export const MessageView = memo(function MessageView({
  artifactTarget,
  canAnswer,
  canDismiss,
  message,
  mentions,
  onAnswer,
  onOpenBot,
  onOpenPeerMessages,
  peerReplies,
  onTogglePeerReplies,
  speakerName,
  memberName,
  peerBot,
  replyParent,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speaking,
  onSpeak,
  onOpenComputer,
  onOpenImportSetup,
  showToolActivity,
  onReply,
  onMarkUnread,
  markedUnread = false,
  onReact,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  canDismiss: boolean;
  message: ThreadMessage;
  /** Bots this reply announces, named inline in its text. */
  mentions?: readonly ChildBotBlock[];
  onAnswer: (
    message: ThreadMessage,
    text: string,
    fields?: LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  /** Set on a received marker whose peer run has folded replies. */
  peerReplies?: "collapsed" | "expanded";
  onTogglePeerReplies: (markerId: string) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;
  replyParent?: ThreadMessage;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
  /** Opens where an imported item's setup is finished. */
  onOpenImportSetup?: (target: ImportSetupTarget) => void;
  showToolActivity: boolean;
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnread?: boolean;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
}) {
  const { t } = useLingui();
  const isNarration =
    message.role === "bot" &&
    message.blocks.length > 0 &&
    message.blocks.every(
      (block) => block.kind === "text" || block.kind === "progress" || block.kind === "steps",
    );
  const isLive = message.id.startsWith("progress:");
  const quoteMessageId = message.id.includes(":") ? undefined : message.id;

  // Only what is drawn names the mentioned bots; copy, quote, and speech keep the original text.
  const blocks = useMemo(
    () =>
      mentions?.length
        ? withBlockMentions(
            message.blocks,
            mentions.map((bot) => ({ id: bot.botId, name: bot.name })),
          )
        : message.blocks,
    [message.blocks, mentions],
  );
  const visibleNarrationBlocks = renderableMessageBlocks(blocks, showToolActivity);
  const renderMention = (id: string) => {
    const block = mentions?.find((bot) => bot.botId === id);
    return block ? (
      <BotMention
        block={block}
        avatarSet={peerBot(id)?.avatarSet}
        color={peerBot(id)?.color}
        onOpenBot={onOpenBot}
      />
    ) : undefined;
  };
  const replyBotId = message.replyPreview?.botId ?? replyParent?.botId;
  const speakerBot = message.botId ? peerBot?.(message.botId) : undefined;
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(message.botId ?? "bot", speakerBot?.color),
    [message.botId, speakerBot?.color],
  );
  const messageContext = (
    <>
      {speakerName ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.light }}
        >
          <BotAvatar
            color={speakerBot?.color ?? FALLBACK_BOT_COLOR}
            avatarSet={speakerBot?.avatarSet}
            identity={message.botId}
            size={22}
          />
          {speakerName}
        </div>
      ) : null}
      <ReplyLine
        target={artifactTarget}
        message={message}
        fallbackText={replyParent ? previewMessageText(replyParent) : undefined}
        author={
          (message.replyPreview?.role ?? replyParent?.role) === "user"
            ? t`You`
            : ((replyBotId ? peerBot(replyBotId)?.name : undefined) ??
              memberName?.(replyBotId) ??
              t`Bot`)
        }
        onJump={onJumpToMessage}
      />
    </>
  );
  // Anchored below the speaker and reply line so the rail centers on the bubble itself.
  // A message with text and attachments anchors it on its first text bubble.
  const textAnchorIndex = message.blocks.findIndex((block) => block.kind === "text");
  const hoverAnchorIndex =
    textAnchorIndex === -1
      ? message.blocks.findIndex((block) => block.kind === "ask")
      : textAnchorIndex;
  const peerReceipt = isPeerReceiptBlocks(message.blocks);
  const hoverActions = peerReceipt ? null : (
    <MessageHoverActions
      message={message}
      side={message.role === "user" ? "start" : "end"}
      onReply={onReply}
      onMarkUnread={onMarkUnread}
      markedUnread={markedUnread}
      onReact={onReact}
    />
  );
  if (isNarration) {
    if (visibleNarrationBlocks.length === 0) return null;
    if (isToolOnlyNarration(message.blocks, showToolActivity)) {
      return (
        <>
          {messageContext}
          <div className="relative">
            <ToolOnlyNarration blocks={visibleNarrationBlocks} live={isLive} />
            {hoverActions}
          </div>
        </>
      );
    }
    return (
      <>
        {messageContext}
        <div className="relative w-fit max-w-full [@media(hover:none)]:w-full">
          <div className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full">
            <div
              data-testid="message-bot-bubble"
              className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-body1 text-foreground"
              dir="auto"
            >
              {visibleNarrationBlocks.map((block, i) => {
                if (block.kind === "steps") {
                  return (
                    <ToolActivityDisclosure
                      key={i}
                      live={isLive}
                      stepCount={toolStepCount(block.steps)}
                      durationMs={block.durationMs}
                    >
                      <ToolSteps
                        steps={block.steps}
                        currentIndex={isLive ? block.steps.length - 1 : undefined}
                        limit={isLive ? LIVE_TOOL_STEP_WINDOW : undefined}
                      />
                    </ToolActivityDisclosure>
                  );
                }
                if (block.kind === "text" || block.kind === "progress") {
                  return (
                    <div
                      key={i}
                      data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}
                    >
                      <ChatMarkdown
                        streaming={block.kind === "progress"}
                        renderMention={renderMention}
                      >
                        {block.text}
                      </ChatMarkdown>
                    </div>
                  );
                }
                return null;
              })}
              {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
                <Button
                  variant="text"
                  size="xs"
                  aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                  onClick={onSpeak}
                  className="font-normal"
                >
                  {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                </Button>
              ) : null}
            </div>
          </div>
          {hoverActions}
        </div>
      </>
    );
  }
  return (
    <>
      {messageContext}
      <div
        className={cn(
          "relative flex flex-col gap-2",
          message.role === "user" && !peerReceipt && "items-end",
        )}
      >
        {blocks.map((block, i) => {
          if (block.kind === "steps" && shouldRenderToolCard(block, showToolActivity)) {
            return (
              <StandaloneToolActivity
                key={i}
                live={isLive}
                steps={block.steps}
                stepCount={toolStepCount(block.steps)}
                durationMs={block.durationMs}
              />
            );
          }
          if (isToolActivityBlock(block)) return null;
          if (block.kind === "handoff") {
            const from = memberName?.(block.fromBotId) ?? t`bot`;
            const to = memberName?.(block.toBotId) ?? t`bot`;
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span>
                  ↪ {to} ← {from}
                </span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
            const sent = block.kind === "bot_message_sent";
            const peer = sent ? block.toBotName : block.fromBotName;
            const peerBotId = sent ? block.toBotId : block.fromBotId;
            const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
            return (
              <CollaborationMarker
                key={i}
                ariaLabel={label}
                color={peerBot(peerBotId)?.color ?? FALLBACK_BOT_COLOR}
                avatarSet={peerBot(peerBotId)?.avatarSet}
                identity={peerBotId}
                label={label}
                onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
                replies={
                  !sent && peerReplies
                    ? {
                        expanded: peerReplies === "expanded",
                        label:
                          peerReplies === "expanded" ? t`Collapse ${label}` : t`Expand ${label}`,
                        onToggle: () => onTogglePeerReplies(message.id),
                      }
                    : undefined
                }
              />
            );
          }
          if (block.kind === "channel_message") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span className="shrink-0">
                  {messageProviderLabel(block.provider, block.transport)}
                </span>
                <span>
                  {block.fromLabel}: {block.text}
                </span>
              </div>
            );
          }
          if (block.kind === "meta") {
            return (
              <div
                key={i}
                className="flex items-center justify-center gap-2 py-1 text-[13.5px] text-muted-foreground"
              >
                <span className="text-warning">◷</span>
                <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "progress") {
            return (
              <div
                key={i}
                className="flex w-fit max-w-full justify-start [@media(hover:none)]:w-full"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-body1 text-foreground"
                  dir="auto"
                >
                  <ChatMarkdown streaming renderMention={renderMention}>
                    {block.text}
                  </ChatMarkdown>
                </div>
              </div>
            );
          }
          if (block.kind === "subagent") {
            return <SubagentCard key={i} block={block} />;
          }
          if (block.kind === "child_bot") {
            return (
              <div key={i} className="flex items-center gap-1.5 text-[15.5px]">
                <BotMention
                  block={block}
                  color={peerBot(block.botId)?.color}
                  avatarSet={peerBot(block.botId)?.avatarSet}
                  onOpenBot={onOpenBot}
                />
                {block.status === "created" ? null : (
                  <span className="text-muted-foreground">
                    {block.status === "archived" ? <Trans>archived</Trans> : <Trans>deleted</Trans>}
                  </span>
                )}
              </div>
            );
          }
          if (block.kind === "choice") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
          }
          if (block.kind === "app_connect") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start">
                <AppConnectCard
                  botId={botId}
                  threadId={message.threadId}
                  messageId={message.id}
                  block={block}
                />
              </div>
            );
          }
          if (block.kind === "chart") {
            return (
              <div key={i} className="flex justify-start">
                <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
              </div>
            );
          }
          if (block.kind === "import_setup") {
            return (
              <div key={i} className="flex justify-start">
                <ImportSetupCard
                  botId={"botId" in artifactTarget ? artifactTarget.botId : message.botId}
                  block={block}
                  onOpen={onOpenImportSetup}
                />
              </div>
            );
          }
          if (block.kind === "mcp_approval") {
            const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
            if (!botId) return null;
            return (
              <div key={i} className="flex justify-start">
                <McpApprovalCard botId={botId} threadId={message.threadId} block={block} />
              </div>
            );
          }
          if (block.kind === "image") {
            return (
              <div
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ArtifactImage
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                />
              </div>
            );
          }
          if (block.kind === "file") {
            return (
              <div
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <ArtifactFileCard
                  target={artifactTarget}
                  artifactId={block.artifactId}
                  name={block.name}
                  mimeType={block.mimeType}
                  size={block.size}
                />
              </div>
            );
          }
          if (block.kind === "text" && message.role === "user") {
            // User bubbles stay literal text on web and mobile. Only explicit URLs
            // and email addresses are links, so a sent address is tappable without
            // formatting bold or headings.
            return (
              <div
                key={i}
                className="relative flex w-fit max-w-full justify-end [@media(hover:none)]:w-full [@media(hover:none)]:flex-wrap"
              >
                <div
                  data-testid="message-user-bubble"
                  data-quote-message-id={quoteMessageId}
                  className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-body1 text-chat-user-foreground"
                  dir="auto"
                >
                  <LinkifiedText>{block.text}</LinkifiedText>
                </div>
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "text") {
            return (
              <div
                key={i}
                className="relative flex w-fit max-w-full justify-start [@media(hover:none)]:w-full [@media(hover:none)]:flex-wrap"
              >
                <div
                  data-testid="message-bot-bubble"
                  className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-body1 text-foreground"
                  dir="auto"
                >
                  <div data-quote-message-id={quoteMessageId}>
                    <ChatMarkdown renderMention={renderMention}>{block.text}</ChatMarkdown>
                  </div>
                  {voiceReady ? (
                    <Button
                      variant="text"
                      size="xs"
                      aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                      onClick={onSpeak}
                      className="mt-2 font-normal"
                    >
                      {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                    </Button>
                  ) : null}
                </div>
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "card") {
            return (
              <div key={i} className="flex justify-start">
                <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4">
                  {block.lines.map((line) => (
                    <div key={line.k} className="flex items-baseline gap-2.5 text-[15px]">
                      <span className="text-success">✓</span>
                      <span className="font-semibold text-foreground">{line.k}</span>
                      <span className="text-muted-foreground">→</span>
                      <span>{line.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (block.kind === "ask") {
            return (
              <div
                key={i}
                className={`relative w-full min-w-0 ${isSecretAskBlock(block) ? "" : "max-w-xl"}`}
              >
                <AskCard
                  block={block}
                  canAnswer={canAnswer}
                  canDismiss={canDismiss}
                  onAnswer={(text, fields, remember) =>
                    onAnswer(message, text, fields, undefined, remember)
                  }
                  onDismiss={() => onAnswer(message, "", undefined, true)}
                />
                {i === hoverAnchorIndex ? hoverActions : null}
              </div>
            );
          }
          if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
          if (block.kind === "skill_draft") {
            return (
              <div key={i} className="flex justify-start">
                <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
              </div>
            );
          }
          if (block.kind === "computer") {
            return (
              <div
                key={i}
                data-testid="computer-card"
                className="w-[340px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-medium text-foreground">
                    <Trans>Computer</Trans>
                  </span>
                  <span
                    className={
                      block.state === "Needs you"
                        ? "rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning"
                        : block.state === "Skipped"
                          ? "rounded-full bg-foreground/10 px-[11px] py-1 text-[13px] text-muted-foreground"
                          : "rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success"
                    }
                  >
                    {block.state}
                  </span>
                </div>
                <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                  <ChatMarkdown>{block.text}</ChatMarkdown>
                </div>
                <Button
                  type="button"
                  size="sm"
                  data-testid="computer-card-open"
                  onClick={() => onOpenComputer(message.botId)}
                >
                  <Trans>Open</Trans>
                </Button>
              </div>
            );
          }
          return null;
        })}
        {hoverAnchorIndex === -1 ? hoverActions : null}
      </div>
    </>
  );
});

/** A bot named inline in its color. A deleted, archived, or missing bot keeps only its name. */
function BotMention({
  block,
  color,
  avatarSet,
  onOpenBot,
}: {
  block: ChildBotBlock;
  color: string | undefined;
  avatarSet?: BotAvatarSet;
  onOpenBot: (botId: string) => void;
}) {
  const live = block.status === "created" && color;
  const name = (
    <span
      dir="auto"
      className="font-medium"
      style={live ? { color: resolvePersonaColorDef(block.botId, color).light } : undefined}
    >
      {block.name}
    </span>
  );
  if (!live) {
    return (
      <span data-testid="bot-mention" className="inline-flex items-baseline gap-1.5">
        <UserRound className="size-4 self-center text-muted-foreground" aria-hidden="true" />
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="bot-mention"
      onClick={() => onOpenBot(block.botId)}
      className="-mx-1 inline-flex items-baseline gap-1.5 rounded-md px-1 transition-colors hover:bg-accent"
    >
      <span className="self-center">
        <BotAvatar avatarSet={avatarSet} color={color} identity={block.botId} size={18} />
      </span>
      {name}
    </button>
  );
}
