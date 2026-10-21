import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

import { foldPeerReplies } from "./message-visibility.js";
import { unreturnedPeerReplies } from "./peer-exchanges.js";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  blocks?: MessageBlock[];
  createdAt: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
}

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function isPeerBlock(block: MessageBlock): block is PeerBlock {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

export function peerMessagesFrom(messages: readonly ThreadMessage[]): PeerMessage[] {
  const collected: PeerMessage[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!isPeerBlock(block)) continue;
      collected.push(
        block.kind === "bot_message_sent"
          ? {
              messageId: message.id,
              direction: "sent",
              peerBotId: block.toBotId,
              peerBotName: block.toBotName,
              text: block.text,
              createdAt: message.createdAt,
            }
          : {
              messageId: message.id,
              direction: "received",
              peerBotId: block.fromBotId,
              peerBotName: block.fromBotName,
              text: block.text,
              createdAt: message.createdAt,
            },
      );
    }
  }
  const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
  for (const [markerId, replies] of unreturnedPeerReplies(transcript)) {
    const marker = messages.find((message) => message.id === markerId);
    const wake = marker?.blocks.find((block) => block.kind === "bot_message_received");
    if (wake?.kind !== "bot_message_received") continue;
    for (const reply of replies) {
      const blocks = reply.blocks.filter(
        (b) => b.kind === "text" || b.kind === "file" || b.kind === "image",
      );
      collected.push({
        messageId: reply.id,
        direction: "sent",
        peerBotId: wake.fromBotId,
        peerBotName: wake.fromBotName,
        createdAt: reply.createdAt,
        blocks,
        text: blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n"),
      });
    }
  }
  return collected.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      messages.findIndex((m) => m.id === a.messageId) -
        messages.findIndex((m) => m.id === b.messageId),
  );
}

/** One conversation per peer, most recently active first. */
export function peerConversations(messages: readonly ThreadMessage[]): PeerConversation[] {
  const byPeer = new Map<string, PeerConversation>();
  for (const peerMessage of peerMessagesFrom(messages)) {
    const existing = byPeer.get(peerMessage.peerBotId);
    if (existing) {
      existing.messages.push(peerMessage);
      // Names can change; the newest one wins.
      existing.peerBotName = peerMessage.peerBotName;
      existing.lastText = peerMessage.text;
      existing.lastAt = peerMessage.createdAt;
      continue;
    }
    byPeer.set(peerMessage.peerBotId, {
      peerBotId: peerMessage.peerBotId,
      peerBotName: peerMessage.peerBotName,
      messages: [peerMessage],
      lastText: peerMessage.text,
      lastAt: peerMessage.createdAt,
    });
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
