import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { isPeerReceiptBlocks, isToolActivityBlock } from "@rakazo/core";
import { BotAvatar, Button, resolvePersonaColorDef } from "@rakazo/ui-web";
import { memo, useMemo } from "react";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../../components/CloudAgentCard";
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
  showToolActivity,
  onReply,
  onReact,
}: {
  artifactTarget: ArtifactTarget;
  canAnswer: boolean;
  canDismiss: boolean;
  message: ThreadMessage;
  onAnswer: (
    message: ThreadMessage,
    text: string,
    username?: string,
    dismiss?: boolean,
  ) => Promise<void>;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  /** Set on a received marker whose peer run has folded replies. */
  peerReplies?: "collapsed" | "expanded";
  onTogglePeerReplies: (markerId: string) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { name?: string; color: string; status?: string } | undefined;
  replyParent?: ThreadMessage;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onOpenComputer: (botId?: string) => void;
  showToolActivity: boolean;
  onReply: (message: ThreadMessage) => void;
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
  const visibleNarrationBlocks = renderableMessageBlocks(message.blocks, showToolActivity);

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
  const hoverAnchorIndex = message.blocks.findIndex((block) => block.kind === "text");
  const hoverActions = isPeerReceiptBlocks(message.blocks) ? null : (
    <MessageHoverActions
      message={message}
      side={message.role === "user" ? "start" : "end"}
      onReply={onReply}
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
              className="max-w-full space-y-2.5 rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
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
                      <ChatMarkdown streaming={block.kind === "progress"}>
                        {block.text}
                      </ChatMarkdown>
                    </div>
                  );
                }
                return null;
              })}
              {!isLive && voiceReady && message.blocks.some((block) => block.kind === "text") ? (
                <button
                  type="button"
                  aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                  onClick={onSpeak}
                  className="text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                </button>
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
      <div className="relative flex flex-col gap-2">
        {message.blocks.map((block, i) => {
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
                <span>
                  {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
                  {block.text}
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
                  className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
                  dir="auto"
                >
                  <ChatMarkdown streaming>{block.text}</ChatMarkdown>
                </div>
              </div>
            );
          }
          if (block.kind === "subagent") {
            const running = block.status === "running";
            const failed = block.status === "failed";
            return (
              <div
                key={i}
                data-testid="subagent-card"
                className="w-[420px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[15px] font-medium text-foreground" dir="auto">
                    {block.name}
                  </span>
                  <span
                    className={`rounded-full px-[11px] py-1 text-[13px] ${
                      failed
                        ? "bg-destructive/15 text-destructive"
                        : running
                          ? "bg-warning/15 text-warning"
                          : "bg-success/15 text-success"
                    }`}
                    style={{
                      animation: running ? "rkPulse 1.2s ease-in-out infinite" : undefined,
                    }}
                  >
                    {running ? <Trans>subagent</Trans> : block.status}
                  </span>
                </div>
                <div className="mt-2 text-[13.5px] text-muted-foreground">{block.task}</div>
                {block.progress || block.result ? (
                  <div className="mt-2.5 text-[14.5px] leading-[1.5] text-foreground/75">
                    <ChatMarkdown streaming={running}>
                      {block.result || block.progress || ""}
                    </ChatMarkdown>
                  </div>
                ) : null}
              </div>
            );
          }
          if (block.kind === "child_bot") {
            const removed = block.status === "deleted" || block.status === "archived";
            return (
              <button
                key={i}
                type="button"
                disabled={removed}
                onClick={() => onOpenBot(block.botId)}
                data-testid="bot-link-card"
                className="w-[340px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4 text-start disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-medium text-foreground" dir="auto">
                    {block.name}
                  </span>
                  <span
                    className={`rounded-full px-[11px] py-1 text-[13px] ${
                      removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                    }`}
                  >
                    {block.status === "archived" ? (
                      <Trans>archived</Trans>
                    ) : block.status === "deleted" ? (
                      <Trans>deleted</Trans>
                    ) : (
                      <Trans>bot</Trans>
                    )}
                  </span>
                </div>
                <div className="mt-2 text-[14.5px] leading-[1.5] text-foreground/75" dir="auto">
                  {removed
                    ? block.status === "archived"
                      ? t`Archived. Chat, memory, and files kept.`
                      : t`Removed with chat, computer, and memory.`
                    : block.title || t`Opened its thread.`}
                </div>
              </button>
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
                  className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-chat-user px-[18px] py-3 text-[15.5px] leading-[1.45] text-chat-user-foreground"
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
                  className="max-w-full rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
                  dir="auto"
                >
                  <div data-quote-message-id={quoteMessageId}>
                    <ChatMarkdown>{block.text}</ChatMarkdown>
                  </div>
                  {voiceReady ? (
                    <button
                      type="button"
                      aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
                      onClick={onSpeak}
                      className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      {speaking ? <Trans>Stop</Trans> : <Trans>Speak</Trans>}
                    </button>
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
                      <span className="font-semibold text-white">{line.k}</span>
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
              <AskCard
                key={i}
                block={block}
                canAnswer={canAnswer}
                canDismiss={canDismiss}
                onAnswer={(text, username) => onAnswer(message, text, username)}
                onDismiss={() => onAnswer(message, "", undefined, true)}
              />
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
