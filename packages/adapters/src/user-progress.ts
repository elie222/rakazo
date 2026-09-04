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

/** clientNonce prefix for mid-turn progress messages (reconciler uses this). */
export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function userProgressClientNonce(runId: string, index = 0): string {
  // Include entropy so a resumed executor turn cannot reuse an earlier nonce
  // (threadId + clientNonce is unique).
  return `${USER_PROGRESS_CLIENT_NONCE_PREFIX}${runId}:${index}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

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

/** Outcome to return for a bot_message run after mid-turn progress posts. */
export function botMessageOutcomeFromMidTurn(
  finalText: string,
  midTurnTexts: readonly string[],
): { text: string; intent: "result" | "status" } | null {
  const trimmed = finalText.trim();
  if (trimmed) return { text: trimmed, intent: "result" };
  const midTurn = midTurnTexts.map((part) => part.trim()).filter(Boolean);
  if (midTurn.length === 0) return null;
  return { text: midTurn.join("\n\n"), intent: "status" };
}
