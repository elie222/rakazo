import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { BotAvatarSet, MessageBlock, ThreadMessage } from "@rakazo/contracts";
import type { groupVoiceChats, PeerExchange } from "@rakazo/core";
import { isPeerReceiptBlocks, isToolActivityBlock } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { Mail, Reply } from "lucide-react";
import { useEffect, useState } from "react";
import type { AvatarStackBot } from "../../../components/ai/CollaborationMarker";
import { MultiBotCollaborationMarker } from "../../../components/ai/CollaborationMarker";

const FALLBACK_BOT_COLOR = "#64748b";

export type PeerBotLookup = (
  botId: string,
) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;

export type TranscriptRowItem = ReturnType<typeof groupVoiceChats<ThreadMessage>>[number];

export type GroupedTranscriptItem =
  | TranscriptRowItem
  | {
      kind: "handoffGroup";
      key: string;
      firstMessage: ThreadMessage;
      messages: ThreadMessage[];
    }
  | {
      kind: "peerReceiptGroup";
      key: string;
      firstMessage: ThreadMessage;
      entries: Array<{ message: ThreadMessage; exchange: PeerExchange }>;
    };

export function isHandoffOnlyMessage(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return (
    blocks.some((block) => block.kind === "handoff") &&
    blocks.every(
      (block) => block.kind === "handoff" || (!showToolActivity && isToolActivityBlock(block)),
    )
  );
}

/** True when a message's visible blocks are strictly peer receipts with no inline attachments. */
export function isPeerReceiptOnlyMessage(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return (
    isPeerReceiptBlocks(blocks) &&
    blocks.every(
      (block) =>
        block.kind === "bot_message_sent" ||
        block.kind === "bot_message_received" ||
        (!showToolActivity && isToolActivityBlock(block)),
    )
  );
}

/**
 * Collapses consecutive handoff messages and consecutive multi-bot peer receipts into compact
 * single-line rows (e.g. "Messaged [avatars] 3 Bots") while recording jump-target mapping.
 */
export function groupTranscriptItems(
  items: readonly TranscriptRowItem[],
  exchanges: { lines: Map<string, PeerExchange>; lineOf: Map<string, string> },
  showToolActivity: boolean,
  boundaries: { separatorIds?: ReadonlySet<string>; unreadDividerId?: string | null } = {},
): { items: GroupedTranscriptItem[]; anchorOf: Map<string, string> } {
  const grouped: GroupedTranscriptItem[] = [];
  const anchorOf = new Map<string, string>();
  const { separatorIds, unreadDividerId } = boundaries;
  const startsBoundary = (messageId: string) =>
    Boolean(separatorIds?.has(messageId) || (unreadDividerId && messageId === unreadDividerId));

  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.kind !== "message") {
      grouped.push(item);
      index += 1;
      continue;
    }

    if (isHandoffOnlyMessage(item.message.blocks, showToolActivity)) {
      const batch: ThreadMessage[] = [item.message];
      let cursor = index + 1;
      while (cursor < items.length) {
        const next = items[cursor]!;
        if (
          next.kind === "message" &&
          !startsBoundary(next.message.id) &&
          isHandoffOnlyMessage(next.message.blocks, showToolActivity)
        ) {
          batch.push(next.message);
          cursor += 1;
        } else {
          break;
        }
      }
      const first = batch[0]!;
      for (const msg of batch) anchorOf.set(msg.id, first.id);
      grouped.push({
        kind: "handoffGroup",
        key: `handoff-group:${first.id}`,
        firstMessage: first,
        messages: batch,
      });
      index = cursor;
      continue;
    }

    if (isPeerReceiptOnlyMessage(item.message.blocks, showToolActivity)) {
      const entries: Array<{ message: ThreadMessage; exchange: PeerExchange }> = [];
      const seenIds: string[] = [];
      const seenExchangeRoots = new Set<string>();
      let cursor = index;
      while (cursor < items.length) {
        const next = items[cursor]!;
        if (
          next.kind !== "message" ||
          (cursor > index && startsBoundary(next.message.id)) ||
          !isPeerReceiptOnlyMessage(next.message.blocks, showToolActivity)
        ) {
          break;
        }
        seenIds.push(next.message.id);
        const rootId = exchanges.lineOf.get(next.message.id) ?? next.message.id;
        const exchange = exchanges.lines.get(rootId);
        if (exchange && !seenExchangeRoots.has(rootId)) {
          seenExchangeRoots.add(rootId);
          entries.push({ message: next.message, exchange });
        }
        cursor += 1;
      }
      const distinctPeers = new Set(entries.map((entry) => entry.exchange.peerBotId));
      if (entries.length >= 2 && distinctPeers.size >= 2) {
        const first = entries[0]!.message;
        for (const id of seenIds) anchorOf.set(id, first.id);
        grouped.push({
          kind: "peerReceiptGroup",
          key: `peer-group:${first.id}`,
          firstMessage: first,
          entries,
        });
        index = cursor;
        continue;
      }
      for (let j = index; j < cursor; j += 1) {
        grouped.push(items[j]!);
      }
      index = cursor;
      continue;
    }

    grouped.push(item);
    index += 1;
  }

  return { items: grouped, anchorOf };
}

function resolveAvatarBot(
  botId: string,
  fallbackName: string,
  peerBot: PeerBotLookup,
): AvatarStackBot {
  const found = peerBot(botId);
  return {
    botId,
    name: found?.name ?? fallbackName,
    color: found?.color ?? FALLBACK_BOT_COLOR,
    avatarSet: found?.avatarSet,
  };
}

/** Collapsible one-line row for one or more consecutive bot handoffs in a group chat. */
export function HandoffGroupRow({
  messages,
  memberName,
  peerBot,
  revealMessageId,
  onReply,
  onMarkUnread,
  onJumpToMessage,
}: {
  messages: readonly ThreadMessage[];
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: PeerBotLookup;
  revealMessageId?: string;
  onReply?: (message: ThreadMessage) => void;
  onMarkUnread?: (message: ThreadMessage) => void;
  onJumpToMessage?: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const containsReveal = Boolean(
    revealMessageId && messages.some((message) => message.id === revealMessageId),
  );
  useEffect(() => {
    if (containsReveal) setExpanded(true);
  }, [containsReveal]);
  const isExpanded = expanded || containsReveal;

  const handoffs = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) =>
      block.kind === "handoff"
        ? [
            {
              key: `${message.id}-${blockIndex}`,
              message,
              isFirstInMessage:
                blockIndex === message.blocks.findIndex((b) => b.kind === "handoff"),
              fromBotId: block.fromBotId,
              toBotId: block.toBotId,
              fromName: memberName?.(block.fromBotId) ?? peerBot(block.fromBotId)?.name ?? t`bot`,
              toName: memberName?.(block.toBotId) ?? peerBot(block.toBotId)?.name ?? t`bot`,
              text: block.text,
            },
          ]
        : [],
    ),
  );
  if (handoffs.length === 0) return null;

  const uniqueSenders = new Map<string, AvatarStackBot>();
  const uniqueTargets = new Map<string, AvatarStackBot>();
  for (const item of handoffs) {
    if (!uniqueSenders.has(item.fromBotId)) {
      uniqueSenders.set(item.fromBotId, resolveAvatarBot(item.fromBotId, item.fromName, peerBot));
    }
    if (!uniqueTargets.has(item.toBotId)) {
      uniqueTargets.set(item.toBotId, resolveAvatarBot(item.toBotId, item.toName, peerBot));
    }
  }

  const multiBots =
    uniqueSenders.size > 1
      ? [...uniqueSenders.values()]
      : uniqueTargets.size > 1
        ? [...uniqueTargets.values()]
        : null;

  const first = handoffs[0]!;
  const prefix = multiBots ? t`Messaged` : undefined;
  const bots = multiBots ?? [
    resolveAvatarBot(first.fromBotId, first.fromName, peerBot),
    ...(first.toBotId !== first.fromBotId
      ? [resolveAvatarBot(first.toBotId, first.toName, peerBot)]
      : []),
  ];
  const suffix = multiBots
    ? t`${plural(multiBots.length, { one: "# Bot", other: "# Bots" })}`
    : `${first.fromName} → ${first.toName}`;

  return (
    <MultiBotCollaborationMarker
      prefix={prefix}
      suffix={suffix}
      bots={bots}
      expanded={isExpanded}
      onToggle={() => setExpanded((open) => !open)}
      testId="handoff-group-chip"
    >
      <div
        data-testid="handoff-group-details"
        className="mt-1.5 w-full max-w-2xl divide-y divide-border/50 rounded-lg border border-border/60 bg-card/60 px-3.5 py-2 text-left"
      >
        {handoffs.map((item) => {
          const sender = resolveAvatarBot(item.fromBotId, item.fromName, peerBot);
          return (
            <div
              key={item.key}
              data-message-id={item.isFirstInMessage ? item.message.id : undefined}
              className="py-2 first:pt-1 last:pb-1"
            >
              {item.message.replyPreview && item.message.replyToMessageId ? (
                <button
                  type="button"
                  onClick={() => onJumpToMessage?.(item.message.replyToMessageId!)}
                  className="mb-1 block max-w-full truncate text-caption text-muted-foreground hover:text-foreground"
                >
                  {item.message.replyPreview.text}
                </button>
              ) : null}
              <div className="mb-1 flex items-center justify-between gap-2 text-caption font-medium text-muted-foreground">
                <div className="flex min-w-0 items-center gap-1.5">
                  <BotAvatar
                    avatarSet={sender.avatarSet}
                    color={sender.color}
                    identity={sender.botId}
                    size={14}
                  />
                  <span className="truncate">
                    {item.fromName} → {item.toName}
                  </span>
                </div>
                {onReply || onMarkUnread ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {onReply ? (
                      <button
                        type="button"
                        aria-label={t`Reply`}
                        onClick={() => onReply(item.message)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Reply className="size-3.5" />
                      </button>
                    ) : null}
                    {onMarkUnread ? (
                      <button
                        type="button"
                        aria-label={t`Mark unread`}
                        onClick={() => onMarkUnread(item.message)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Mail className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="text-body-sm text-foreground/90">
                <ChatMarkdown>{item.text}</ChatMarkdown>
              </div>
            </div>
          );
        })}
      </div>
    </MultiBotCollaborationMarker>
  );
}

/** Collapsible one-line row for consecutive peer messages across multiple bots. */
export function PeerReceiptGroupRow({
  entries,
  groupContext,
  peerBot,
  onOpenPeerMessages,
}: {
  entries: ReadonlyArray<{ message: ThreadMessage; exchange: PeerExchange }>;
  groupContext: boolean;
  peerBot: PeerBotLookup;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string; botId?: string }) => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);

  const byConversation = new Map<
    string,
    { bot: AvatarStackBot; count: number; botId?: string; sourceName?: string }
  >();
  const distinctPeers = new Map<string, AvatarStackBot>();
  let hasSent = false;
  let hasReceived = false;
  for (const { message, exchange } of entries) {
    if (exchange.direction === "sent") hasSent = true;
    else hasReceived = true;
    const sourceBotId = groupContext ? message.botId : undefined;
    const convKey = `${sourceBotId ?? ""}:${exchange.peerBotId}`;
    const resolvedPeer = resolveAvatarBot(exchange.peerBotId, exchange.peerBotName, peerBot);
    if (!distinctPeers.has(exchange.peerBotId)) {
      distinctPeers.set(exchange.peerBotId, resolvedPeer);
    }
    const existing = byConversation.get(convKey);
    if (existing) {
      existing.count += exchange.count;
      existing.bot.name = exchange.peerBotName;
    } else {
      byConversation.set(convKey, {
        bot: resolvedPeer,
        count: exchange.count,
        botId: sourceBotId,
        sourceName: sourceBotId ? peerBot(sourceBotId)?.name : undefined,
      });
    }
  }
  const conversations = [...byConversation.values()];
  const summaryBots = [...distinctPeers.values()];
  if (summaryBots.length === 0) return null;
  const distinctSources = new Set(conversations.map((c) => c.botId).filter(Boolean));
  const prefix =
    hasSent && hasReceived ? t`Exchanged with` : hasReceived ? t`Messages from` : t`Messaged`;

  return (
    <MultiBotCollaborationMarker
      prefix={prefix}
      suffix={t`${plural(summaryBots.length, { one: "# Bot", other: "# Bots" })}`}
      bots={summaryBots}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      testId="peer-group-chip"
    >
      <div data-testid="peer-group-links" className="mt-1 flex flex-wrap justify-center gap-1.5">
        {conversations.map(({ bot, count, botId, sourceName }) => (
          <button
            key={`${botId ?? ""}:${bot.botId}`}
            type="button"
            onClick={() =>
              onOpenPeerMessages({
                peerBotId: bot.botId,
                peerBotName: bot.name,
                ...(botId ? { botId } : {}),
              })
            }
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BotAvatar avatarSet={bot.avatarSet} color={bot.color} identity={bot.botId} size={14} />
            <span className="font-medium">
              {distinctSources.size > 1 && sourceName ? `${sourceName} → ${bot.name}` : bot.name}
            </span>
            {count > 1 ? <span>({count})</span> : null}
          </button>
        ))}
      </div>
    </MultiBotCollaborationMarker>
  );
}
