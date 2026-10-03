import type { MessageBlock } from "@rakazo/contracts";

/** clientNonce prefix for durable mid-turn `message_user` progress messages. */
export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

type PresentableMessage = {
  runId?: string;
  clientNonce?: string | null;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer bodies stay hidden.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Run ids for background triggers (e.g. `tickets`). Their messages are hidden
   * except an explicit `message_user` progress update, an `ask` card, or a
   * `computer` block, which are the bot's deliberate ways to reach the user.
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

/** Drop peer-run activity/replies; optionally keep sent/received receipt rows. */
export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  const peerRunIds = new Set([
    ...(options.knownPeerRunIds ?? []),
    ...messages
      .filter((message) => message.blocks.some((block) => block.kind === "bot_message_received"))
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);
  const includePeerReceipts = options.includePeerReceipts === true;
  const backgroundRunIds = new Set(options.backgroundRunIds ?? []);

  return messages.filter((message) => {
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    if (message.runId && backgroundRunIds.has(message.runId)) {
      // Background work stays out of the transcript. The bot's own `message_user`
      // progress update, an ask card, and a computer block are the exceptions.
      return (
        isUserProgressClientNonce(message.clientNonce) ||
        message.blocks.some((block) => block.kind === "ask" || block.kind === "computer")
      );
    }
    if (!message.runId || !peerRunIds.has(message.runId)) return true;
    // Keep peer-run ask cards, and (unless the caller opts out) the bot's own text reply.
    const includeText = options.includeDelegatedReplyText !== false;
    return message.blocks.some(
      (block) => block.kind === "ask" || (includeText && block.kind === "text"),
    );
  });
}
