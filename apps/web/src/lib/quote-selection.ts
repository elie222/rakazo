import type { ThreadMessage } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";

/**
 * Resolves a text selection to the message it quotes. A quote stays scoped to
 * one message row — spanning selections, rows that didn't opt in via
 * `data-quotable`, and empty text get no affordance. The excerpt is capped at
 * capture so an oversized selection never fails the send.
 */
export function quoteDraftForSelection(
  selection: {
    startRow: Pick<HTMLElement, "dataset"> | null;
    endRow: Pick<HTMLElement, "dataset"> | null;
    text: string;
  },
  messageById: ReadonlyMap<string, ThreadMessage>,
): { message: ThreadMessage; text: string } | null {
  const { startRow, endRow } = selection;
  const message =
    startRow && startRow === endRow && startRow.dataset.quotable !== undefined
      ? messageById.get(startRow.dataset.messageId ?? "")
      : undefined;
  const text = selection.text.trim().slice(0, REPLY_QUOTE_MAX_LENGTH);
  if (!message || !text) return null;
  return { message, text };
}
