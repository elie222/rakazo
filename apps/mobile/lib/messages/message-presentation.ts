import type { MessageBlock } from "@rakazo/contracts";
import { AGENT_IMPORT_ASK_ACTION_ID } from "@rakazo/contracts";
import { isRetiredImportSetup, isToolActivityBlock } from "@rakazo/core";
import { MAX_QUOTABLE_SOURCE_LENGTH, visibleTextFromMarkdown } from "@rakazo/core/message-quote";

export function isCenteredAgentEvent(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "handoff" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received" ||
      block.kind === "channel_message" ||
      block.kind === "routine_event",
  );
}

/** Cards with a text field, buttons or links own the taps that land inside them. */
export function messageHasInlineControls(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "ask" ||
      block.kind === "app_connect" ||
      block.kind === "mcp_approval" ||
      block.kind === "tool_question" ||
      block.kind === "import_setup",
  );
}

export type MessagePresentationSegment = {
  kind: "content";
  blocks: MessageBlock[];
};

/** Blocks the thread draws as their own native card instead of inside the text bubble. */
function isCardBlock(block: MessageBlock): boolean {
  return (
    block.kind === "app_connect" ||
    block.kind === "choice" ||
    block.kind === "computer" ||
    block.kind === "import_setup"
  );
}

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const content = blocks.filter((block) => !isCardBlock(block) && !isToolActivityBlock(block));
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

/** Keep standalone cards between the contiguous bubble content around them. */
export function splitMessageBlocks(
  blocks: MessageBlock[],
  isStandalone: (block: MessageBlock) => boolean,
): MessageBlock[][] {
  if (!blocks.some(isStandalone)) return [blocks];
  const pieces: MessageBlock[][] = [];
  for (const block of blocks) {
    const previous = pieces.at(-1);
    if (isStandalone(block) || !previous || isStandalone(previous[0]!)) {
      pieces.push([block]);
    } else {
      previous.push(block);
    }
  }
  return pieces;
}

export function hasMessageSenderContent(blocks: readonly MessageBlock[]): boolean {
  if (blocks.some((block) => block.kind === "ask") || isCenteredAgentEvent(blocks)) return false;
  if (blocks.every((block) => block.kind === "app_connect" || block.kind === "mcp_approval")) {
    return false;
  }
  return messagePresentationSegments(blocks).length > 0;
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      !isToolActivityBlock(block) && !isDismissedChoice(block) && !isRetiredImportSetup(block),
  );
}

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** The options a question offers here: the agent import is in the web and desktop apps only. */
export function askOptions(block: AskBlock): NonNullable<AskBlock["actions"]> {
  return (block.actions ?? []).filter((action) => action.id !== AGENT_IMPORT_ASK_ACTION_ID);
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

/** Pads the content, not the scroll view, so the scroll indicator stays on the screen edge. */
export const THREAD_COLUMN_GUTTER = 20;
const MESSAGE_COLUMN_RATIO = 0.9;
const CARD_MAX_WIDTH = 340;

/** Width of a card in a normal bot row: thread padding, then the 90% column cap. */
export function threadCardWidth(windowWidth: number): number {
  const contentWidth = Math.max(0, windowWidth - THREAD_COLUMN_GUTTER * 2);
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

// Markup that can hide a line's words: raw HTML, an image's alt text, a link definition, or a
// link target on a line of its own.
const HIDING_MARKUP = /<|!\[|\]:|\]\(\s*\n/;
// A line whose words survive Markdown: past block markers it opens with a letter, or a number
// that is not an ordered-list marker.
const VISIBLE_LINE = /^[\t >#*+\-_]*(?:\p{L}|\p{N}+(?![\p{N}.)]))/mu;

/**
 * Whether the quote sheet would offer any text, as `quotableMessageSegments` decides it. Every row
 * asks when it is drawn, so a message whose words plainly show skips the Markdown parse.
 */
export function hasQuotableText(
  role: "user" | "bot" | "system",
  blocks: readonly MessageBlock[],
): boolean {
  const cached = quotableSegmentsCache.get(blocks)?.get(role);
  if (cached) return cached.length > 0;
  let sourceLength = 0;
  let visible = false;
  for (const block of blocks) {
    if (block.kind !== "text" || !block.text) continue;
    sourceLength += block.text.length;
    if (sourceLength > MAX_QUOTABLE_SOURCE_LENGTH) return false;
    visible ||=
      role === "user"
        ? block.text.trim() !== ""
        : !HIDING_MARKUP.test(block.text) && VISIBLE_LINE.test(block.text);
  }
  return visible || quotableMessageSegments(role, blocks).length > 0;
}
