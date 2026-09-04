import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

/** Keep mid-turn progress beats short; prefer a few high-signal updates. */
export const USER_PROGRESS_MESSAGE_MAX_LENGTH = 500;

export function clampUserProgressMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, USER_PROGRESS_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Pull narration text out of the in-progress turn segments so it can be posted
 * as a durable mid-turn message. Tool/step blocks stay for the final publish.
 */
export function extractNarrationText(
  segments: readonly MessageBlock[],
  currentText: string,
): { text: string; remaining: MessageBlock[] } {
  const parts: string[] = [];
  const remaining: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    remaining.push(block);
  }
  if (currentText) parts.push(currentText);
  return { text: parts.join(""), remaining };
}

/**
 * After mid-turn progress messages were already posted, skip a hollow final
 * message that would only carry hidden tool-activity blocks (or nothing).
 */
export function finalBlocksAfterMidTurnProgress(
  blocks: MessageBlock[],
  publishedMidTurn: boolean,
): MessageBlock[] {
  if (!publishedMidTurn || blocks.length === 0) return blocks;
  if (blocks.every((block) => isToolActivityBlock(block))) return [];
  return blocks;
}
