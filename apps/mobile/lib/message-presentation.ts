import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { visibleTextFromMarkdown } from "@rakazo/core/message-quote";

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

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const content = blocks.filter(
    (block) => block.kind !== "app_connect" && !isToolActivityBlock(block),
  );
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => !isToolActivityBlock(block));
}

/**
 * Text segments the reply-quote sheet offers for selection. Quotes derive
 * against the server's visible text, not the bubbles' typographer-rendered
 * glyphs — selecting straight `--` where the bubble drew `—` still validates.
 */
export function quotableMessageSegments(
  role: "user" | "bot" | "system",
  blocks: readonly MessageBlock[],
): string[] {
  return blocks
    .filter(
      (block): block is Extract<MessageBlock, { kind: "text" }> =>
        block.kind === "text" && Boolean(block.text),
    )
    .map((block) => (role === "user" ? block.text : visibleTextFromMarkdown(block.text)))
    .filter((text) => text.trim());
}

/** Cap a selection at the contract limit without splitting a surrogate pair. */
export function truncateQuoteExcerpt(value: string): string {
  const truncated = value.slice(0, REPLY_QUOTE_MAX_LENGTH);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
