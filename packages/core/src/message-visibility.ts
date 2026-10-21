import type { MessageBlock } from "@rakazo/contracts";
import { messageReaction } from "./message-reactions.js";

type PresentableMessage = {
  id: string;
  runId?: string;
  role?: string;
  replyToMessageId?: string | null;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact exchange lines.
   * Peer-addressed replies fold into the received exchange.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Run ids for background triggers (e.g. `tickets`). Their messages are hidden
   * except cards that need user input.
   */
  backgroundRunIds?: Iterable<string>;
  /**
   * Surface a peer-run's own `text` reply (e.g. a delegating bot's summary to the user)
   * alongside `ask` cards. Defaults to true for chat-thread rendering; set false for
   * contexts like sidebar previews that should stay ask-only and never echo peer chatter.
   */
  includeDelegatedReplyText?: boolean;
};

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/** User-input cards remain visible when their run otherwise stays in the background. */
export function isBackgroundInputBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    "kind" in block &&
    (block.kind === "ask" || block.kind === "computer" || block.kind === "mcp_approval")
  );
}

/** Cards a peer run stays inline for: the user has to act on them. */
function isPeerInputBlock(block: MessageBlock): boolean {
  return isBackgroundInputBlock(block) || block.kind === "choice";
}

function isAskBlock(block: MessageBlock): boolean {
  return block.kind === "ask";
}

export type FoldedTranscript<T> = {
  messages: T[];
  /** Peer-run replies keyed by the id of the `bot_message_received` marker they fold under. */
  folded: ReadonlyMap<string, readonly T[]>;
  /** The marker each folded message folds under, so a jump can find its exchange line. */
  markerOf: ReadonlyMap<string, string>;
};

/**
 * Drop peer-run activity; optionally keep sent/received receipt rows. With receipts kept, a
 * request/question run's bot replies fold under its received marker; user-addressed replies and input cards stay inline.
 */
export function foldPeerReplies<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): FoldedTranscript<T> {
  const includePeerReceipts = options.includePeerReceipts === true;
  const markerByRunId = new Map<string, string>();
  const userAddressedRunIds = new Set<string>();
  for (const message of messages) {
    if (
      message.runId &&
      !markerByRunId.has(message.runId) &&
      message.blocks.some((block) => block.kind === "bot_message_received")
    ) {
      markerByRunId.set(message.runId, message.id);
      const wake = message.blocks.find((block) => block.kind === "bot_message_received");
      if (
        wake?.kind === "bot_message_received" &&
        (wake.intent === "result" || wake.intent === "status" || wake.intent === "fyi")
      ) {
        userAddressedRunIds.add(message.runId);
      }
    }
  }
  const peerRunIds = new Set([...(options.knownPeerRunIds ?? []), ...markerByRunId.keys()]);
  const backgroundRunIds = new Set(options.backgroundRunIds ?? []);
  const includeText = options.includeDelegatedReplyText !== false;
  const folded = new Map<string, T[]>();
  const markerOf = new Map<string, string>();
  const fold = (markerId: string, message: T) => {
    folded.set(markerId, [...(folded.get(markerId) ?? []), message]);
    markerOf.set(message.id, markerId);
    return false;
  };

  const visible = messages.filter((message) => {
    if (message.runId && backgroundRunIds.has(message.runId)) {
      return message.blocks.some(isBackgroundInputBlock);
    }
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    // A reaction follows its folded parent out of the visible transcript.
    const parentMarkerId = message.replyToMessageId
      ? markerOf.get(message.replyToMessageId)
      : undefined;
    if (
      parentMarkerId !== undefined &&
      message.role !== undefined &&
      messageReaction({ ...message, role: message.role, blocks: [...message.blocks] })
    )
      return fold(parentMarkerId, message);
    if (!message.runId || !peerRunIds.has(message.runId)) return true;
    // User-input cards stay inline; previews without receipts keep only asks, as before.
    if (message.blocks.some(includePeerReceipts ? isPeerInputBlock : isAskBlock)) return true;
    if (
      !includeText ||
      !message.blocks.some(
        (block) => block.kind === "text" || block.kind === "file" || block.kind === "image",
      )
    )
      return false;
    // Only bot replies fold: a person's answer, steering or reaction in the run stays inline.
    if (message.role !== "bot") return true;
    const markerId = includePeerReceipts ? markerByRunId.get(message.runId) : undefined;
    // A reply whose marker is outside the loaded page stays inline.
    if (markerId === undefined || userAddressedRunIds.has(message.runId)) return true;
    return fold(markerId, message);
  });
  return { messages: visible, folded, markerOf };
}

export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  return foldPeerReplies(messages, options).messages;
}
