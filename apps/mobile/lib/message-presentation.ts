import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { MAX_QUOTABLE_SOURCE_LENGTH, visibleTextFromMarkdown } from "@rakazo/core/message-quote";

export function isCenteredAgentEvent(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "handoff" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received" ||
      block.kind === "channel_message",
  );
}

export type MessagePresentationSegment = {
  kind: "content";
  blocks: MessageBlock[];
};

/** Blocks the thread draws as their own native card instead of inside the text bubble. */
function isCardBlock(block: MessageBlock): boolean {
  return block.kind === "app_connect" || block.kind === "choice" || block.kind === "computer";
}

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const content = blocks.filter((block) => !isCardBlock(block) && !isToolActivityBlock(block));
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => !isToolActivityBlock(block) && !isDismissedChoice(block));
}

type ChoiceBlock = Extract<MessageBlock, { kind: "choice" }>;

/** The answer id the server stores when the focus card is dismissed without a choice. */
export const DISMISSED_CHOICE_ANSWER_ID = "_dismissed";

function isDismissedChoice(block: MessageBlock): boolean {
  return block.kind === "choice" && block.answerId === DISMISSED_CHOICE_ANSWER_ID;
}

/**
 * Mark choices the reader just dismissed, before the thread snapshot stores that answer.
 * A message that was only that card then drops out of the thread instead of leaving an empty row.
 */
export function applyLocalChoiceDismissals(
  blocks: readonly MessageBlock[],
  dismissedQuestions: ReadonlySet<string>,
): readonly MessageBlock[] {
  if (dismissedQuestions.size === 0) return blocks;
  let changed = false;
  const next = blocks.map((block) => {
    if (block.kind === "choice" && !block.answerId && dismissedQuestions.has(block.question)) {
      changed = true;
      return { ...block, answerId: DISMISSED_CHOICE_ANSWER_ID };
    }
    return block;
  });
  return changed ? next : blocks;
}

/** Options a choice card lists: all of them until answered, then only the picked one. */
export function choiceCardOptions(block: ChoiceBlock): ChoiceBlock["options"] {
  return block.answerId
    ? block.options.filter((option) => option.id === block.answerId)
    : block.options;
}

const THREAD_HORIZONTAL_PADDING = 20;
const MESSAGE_COLUMN_RATIO = 0.9;
const CARD_MAX_WIDTH = 340;

/** Width of a card in a normal bot row: thread padding, then the 90% column cap. */
export function threadCardWidth(windowWidth: number): number {
  const contentWidth = Math.max(0, windowWidth - THREAD_HORIZONTAL_PADDING * 2);
  return Math.min(CARD_MAX_WIDTH, Math.floor(contentWidth * MESSAGE_COLUMN_RATIO));
}

// Row chrome calls this per render; the same blocks array then hits the cache.
const quotableSegmentsCache = new WeakMap<readonly MessageBlock[], Map<string, string[]>>();

/**
 * Text segments the reply-quote sheet offers for selection. Quotes derive
 * against the server's visible text, not the bubbles' typographer-rendered
 * glyphs — selecting straight `--` where the bubble drew `—` still validates.
 * A message past the server's source bound yields no segments: it cannot be
 * quoted, so the action must not be offered.
 */
export function quotableMessageSegments(
  role: "user" | "bot" | "system",
  blocks: readonly MessageBlock[],
): string[] {
  const cached = quotableSegmentsCache.get(blocks)?.get(role);
  if (cached) return cached;
  const segments: string[] = [];
  let sourceLength = 0;
  for (const block of blocks) {
    if (block.kind !== "text" || !block.text) continue;
    sourceLength += block.text.length;
    if (sourceLength > MAX_QUOTABLE_SOURCE_LENGTH) {
      segments.length = 0;
      break;
    }
    const text = role === "user" ? block.text : visibleTextFromMarkdown(block.text);
    if (text.trim()) segments.push(text);
  }
  let byRole = quotableSegmentsCache.get(blocks);
  if (!byRole) {
    byRole = new Map();
    quotableSegmentsCache.set(blocks, byRole);
  }
  byRole.set(role, segments);
  return segments;
}

/** Cap a selection at the contract limit without splitting a surrogate pair. */
export function truncateQuoteExcerpt(value: string): string {
  const truncated = value.slice(0, REPLY_QUOTE_MAX_LENGTH);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
