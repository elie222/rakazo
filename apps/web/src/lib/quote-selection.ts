import type { ThreadMessage } from "@rakazo/contracts";
import { truncateReplyQuote } from "@rakazo/contracts";

/**
 * Resolves a text selection to the message it quotes. A quote stays scoped to
 * one Markdown text region; selections that cross regions or include message
 * chrome and structured cards get no affordance. The excerpt is capped at
 * capture so an oversized selection never fails the send.
 */
export function quoteDraftForSelection(
  selection: {
    startContent: Pick<HTMLElement, "dataset"> | null;
    endContent: Pick<HTMLElement, "dataset"> | null;
    text: string;
  },
  messageById: ReadonlyMap<string, ThreadMessage>,
): { message: ThreadMessage; text: string } | null {
  const { startContent, endContent } = selection;
  const message =
    startContent && startContent === endContent
      ? messageById.get(startContent.dataset.quoteMessageId ?? "")
      : undefined;
  const text = truncateReplyQuote(selection.text.trim());
  if (!message || !text) return null;
  return { message, text };
}
