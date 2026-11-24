import type { MessageBlock } from "@rakazo/contracts";
import { canMarkMessageUnread, copyableMessageText } from "@rakazo/core";

type SelectableMessage = { id: string; blocks: readonly MessageBlock[] };

/**
 * Whether a message can join a multi-message copy: it is a stored message (live progress and
 * subagent rows are not, as `canMarkMessageUnread` already states) with text to copy.
 */
export function canSelectMessage(message: SelectableMessage): boolean {
  return canMarkMessageUnread(message) && copyableMessageText(message) !== "";
}

export function toggleSelected(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** The chosen messages that are still in the chat and still selectable, oldest first. */
export function selectedMessages<T extends SelectableMessage>(
  messages: readonly T[],
  ids: ReadonlySet<string> | null,
): T[] {
  return ids ? messages.filter((message) => ids.has(message.id) && canSelectMessage(message)) : [];
}
