import type { MessageBlock } from "@rakazo/contracts";

type PresentableMessage = {
  runId?: string;
  /** Present when callers can distinguish later messages across sort orders. */
  seq?: number;
  clientNonce?: string | null;
  blocks: readonly MessageBlock[];
};

export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer bodies stay hidden.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /** Peer-run ids woken by a result/status/fyi that should report to the user. */
  knownPeerReportRunIds?: Iterable<string>;
};

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/** A computer card requires the owner to take over and must never be hidden. */
export function isTakeoverRequestBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "computer");
}

/** A peer wake that reports information back, rather than assigning hidden work. */
export function isPeerReportBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "bot_message_received" &&
      (block.intent === "result" || block.intent === "status" || block.intent === "fyi"),
  );
}

/**
 * Candidate owner-facing text on a peer report run (not tagged mid-turn progress).
 * Callers must still pick the latest candidate per run — earlier untagged narration
 * is not itself a durable terminal summary.
 */
export function isPeerSummaryMessage(message: PresentableMessage): boolean {
  return (
    !isUserProgressClientNonce(message.clientNonce) &&
    message.blocks.some((block) => block.kind === "text" && block.text.trim().length > 0)
  );
}

function isLaterPeerSummary(
  candidate: PresentableMessage,
  candidateIndex: number,
  current: PresentableMessage,
  currentIndex: number,
): boolean {
  if (typeof candidate.seq === "number" && typeof current.seq === "number") {
    return candidate.seq >= current.seq;
  }
  return candidateIndex >= currentIndex;
}

/**
 * Indices of the latest peer-summary candidate per peer-report run.
 * Prefers higher `seq` when present so desc and asc collections agree.
 */
export function terminalPeerSummaryIndexes(
  messages: readonly PresentableMessage[],
  peerReportRunIds: ReadonlySet<string>,
): Set<number> {
  const latestIndexByRunId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.runId || !peerReportRunIds.has(message.runId)) return;
    if (isPeerReceiptBlocks(message.blocks)) return;
    if (!isPeerSummaryMessage(message)) return;
    const currentIndex = latestIndexByRunId.get(message.runId);
    if (
      currentIndex === undefined ||
      isLaterPeerSummary(message, index, messages[currentIndex]!, currentIndex)
    ) {
      latestIndexByRunId.set(message.runId, index);
    }
  });
  return new Set(latestIndexByRunId.values());
}

/** Drop peer-run activity; keep final summaries and optionally compact receipt rows. */
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
  const peerReportRunIds = new Set([
    ...(options.knownPeerReportRunIds ?? []),
    ...messages
      .filter((message) => isPeerReportBlocks(message.blocks))
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);
  const terminalSummaryIndexes = terminalPeerSummaryIndexes(messages, peerReportRunIds);

  return messages.filter((message, index) => {
    if (isTakeoverRequestBlocks(message.blocks)) return true;
    if (isPeerReceiptBlocks(message.blocks)) return includePeerReceipts;
    if (!message.runId || !peerRunIds.has(message.runId)) return true;
    return peerReportRunIds.has(message.runId) && terminalSummaryIndexes.has(index);
  });
}
