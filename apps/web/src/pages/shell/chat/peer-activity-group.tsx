import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { BotAvatarSet, MessageBlock, ThreadMessage } from "@rakazo/contracts";
import type { groupVoiceChats, PeerExchange } from "@rakazo/core";
import { isPeerReceiptBlocks, isToolActivityBlock } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { useState } from "react";
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

/**
 * Collapses consecutive handoff messages and consecutive multi-bot peer receipts into compact
 * single-line rows (e.g. "Messaged [avatars] 3 Bots") while recording jump-target mapping.
 */
export function groupTranscriptItems(
  items: readonly TranscriptRowItem[],
  exchanges: { lines: Map<string, PeerExchange>; lineOf: Map<string, string> },
  showToolActivity: boolean,
): { items: GroupedTranscriptItem[]; anchorOf: Map<string, string> } {
  const grouped: GroupedTranscriptItem[] = [];
  const anchorOf = new Map<string, string>();

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

    if (isPeerReceiptBlocks(item.message.blocks)) {
      const entries: Array<{ message: ThreadMessage; exchange: PeerExchange }> = [];
      const seenIds: string[] = [];
      let cursor = index;
      while (cursor < items.length) {
        const next = items[cursor]!;
        if (next.kind !== "message" || !isPeerReceiptBlocks(next.message.blocks)) break;
        seenIds.push(next.message.id);
        const exchange = exchanges.lines.get(next.message.id);
        if (exchange) entries.push({ message: next.message, exchange });
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
}: {
  messages: readonly ThreadMessage[];
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: PeerBotLookup;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);

  const handoffs = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) =>
      block.kind === "handoff"
        ? [
            {
              key: `${message.id}-${blockIndex}`,
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
      expanded={expanded}
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
            <div key={item.key} className="py-2 first:pt-1 last:pb-1">
              <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
                <BotAvatar
                  avatarSet={sender.avatarSet}
                  color={sender.color}
                  identity={sender.botId}
                  size={14}
                />
                <span>
                  {item.fromName} → {item.toName}
                </span>
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

  const byPeer = new Map<string, { bot: AvatarStackBot; count: number; botId?: string }>();
  for (const { message, exchange } of entries) {
    const existing = byPeer.get(exchange.peerBotId);
    if (existing) {
      existing.count += exchange.count;
      existing.bot.name = exchange.peerBotName;
    } else {
      byPeer.set(exchange.peerBotId, {
        bot: resolveAvatarBot(exchange.peerBotId, exchange.peerBotName, peerBot),
        count: exchange.count,
        botId: groupContext ? message.botId : undefined,
      });
    }
  }
  const peers = [...byPeer.values()];
  if (peers.length === 0) return null;

  return (
    <MultiBotCollaborationMarker
      prefix={t`Messaged`}
      suffix={t`${plural(peers.length, { one: "# Bot", other: "# Bots" })}`}
      bots={peers.map((entry) => entry.bot)}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      testId="peer-group-chip"
    >
      <div data-testid="peer-group-links" className="mt-1 flex flex-wrap justify-center gap-1.5">
        {peers.map(({ bot, count, botId }) => (
          <button
            key={bot.botId}
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
            <span className="font-medium">{bot.name}</span>
            {count > 1 ? <span>({count})</span> : null}
          </button>
        ))}
      </div>
    </MultiBotCollaborationMarker>
  );
}
