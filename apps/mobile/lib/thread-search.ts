import type { MobileMessage } from "./mobile-types";
import { blockText } from "./mobile-types";

/**
 * The loaded messages whose plain text contains the query, in reading order
 * (oldest first), so stepping forward walks toward the newest reply. Only the
 * loaded window is searched; older pages stay unloaded until opened.
 */
export function searchThreadMessages(
  messages: readonly MobileMessage[],
  query: string,
): MobileMessage[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return messages.filter((message) => blockText(message).toLocaleLowerCase().includes(needle));
}

/** Steps the current hit forward (1) or back (-1), wrapping around the list. */
export function stepSearchIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  return (current + delta + total) % total;
}
