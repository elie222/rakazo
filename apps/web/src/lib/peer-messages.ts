import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
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

function sentReplyKey(runId: string, peerBotId: string, text: string): string {
  return `${runId}\0${peerBotId}\0${text.trim()}`;
}

export function peerMessagesFrom(messages: readonly ThreadMessage[]): PeerMessage[] {
  const collected: PeerMessage[] = [];
  const receivedPeerByRun = new Map<string, { id: string; name: string }>();
  const explicitSentReplies = new Set<string>();

  // The explicit sent receipt can be published after the run's final text, so
  // index the full history before deciding whether a generated reply is needed.
  for (const message of messages) {
    if (!message.runId) continue;
    for (const block of message.blocks) {
      if (block.kind !== "bot_message_sent") continue;
      explicitSentReplies.add(sentReplyKey(message.runId, block.toBotId, block.text));
    }
  }

  for (const message of messages) {
    for (const block of message.blocks) {
      if (!isPeerBlock(block)) continue;
      if (block.kind === "bot_message_received" && message.runId) {
        receivedPeerByRun.set(message.runId, {
          id: block.fromBotId,
          name: block.fromBotName,
        });
      }
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

    // A bot_message-triggered run stores its generated reply as ordinary bot
    // text on the same run. Preserve that outgoing reply in the dedicated peer
    // conversation as well as its concise summary in the human transcript.
    const replyPeer = message.runId ? receivedPeerByRun.get(message.runId) : undefined;
    if (message.role === "bot" && replyPeer) {
      const text = message.blocks
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("\n\n")
        .trim();
      const alreadySent =
        message.runId && explicitSentReplies.has(sentReplyKey(message.runId, replyPeer.id, text));
      if (text && !alreadySent) {
        collected.push({
          messageId: message.id,
          direction: "sent",
          peerBotId: replyPeer.id,
          peerBotName: replyPeer.name,
          text,
          createdAt: message.createdAt,
        });
      }
    }
  }
  return collected;
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

/** True when loaded history already includes the selected peer exchange. */
export function hasPeerConversation(
  messages: readonly ThreadMessage[],
  peerBotId: string,
): boolean {
  return peerConversations(messages).some((entry) => entry.peerBotId === peerBotId);
}
