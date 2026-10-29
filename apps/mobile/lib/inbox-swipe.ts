export type InboxChatKind = "bot" | "group";
export type InboxRowAction = "read" | "unread" | "archive" | "pin" | "unpin" | "delete";

export const INBOX_ROW_ACTIONS = {
  read: { label: "Mark as Read", systemImage: "checkmark.message.fill" },
  unread: { label: "Mark as Unread", systemImage: "message.badge.filled.fill" },
  archive: { label: "Archive", systemImage: "eye.slash" },
  pin: { label: "Pin", systemImage: "pin" },
  unpin: { label: "Unpin", systemImage: "pin.slash" },
  delete: { label: "Delete…", systemImage: "trash" },
} as const satisfies Record<InboxRowAction, { label: string; systemImage: string }>;

/** Swipe right toggles read state; swipe left offers Archive outermost, then Pin. */
export function inboxRowActions(chat: { unread?: boolean; pinned?: boolean }): {
  leading: InboxRowAction;
  trailing: InboxRowAction[];
} {
  return {
    leading: chat.unread ? "read" : "unread",
    trailing: ["archive", chat.pinned ? "unpin" : "pin"],
  };
}

/** Every row action, as offered to screen readers. */
export function inboxRowActionList(chat: { unread?: boolean; pinned?: boolean }) {
  const { leading, trailing } = inboxRowActions(chat);
  return [leading, ...trailing];
}

export function chatTarget(kind: InboxChatKind, id: string) {
  return kind === "bot" ? { botId: id } : { groupId: id };
}

export function unreadOverrideKey(kind: InboxChatKind, id: string) {
  return `${kind}:${id}`;
}

/** Leaves out chats being archived: the row goes at the tap, and a poll can't bring it back. */
export function withoutArchiving<T extends { id: string }>(
  kind: InboxChatKind,
  chats: T[],
  archiving: ReadonlySet<string>,
): T[] {
  if (archiving.size === 0) return chats;
  return chats.filter((chat) => !archiving.has(unreadOverrideKey(kind, chat.id)));
}

/** Shows read state the user just changed until its request settles, so a poll can't undo it. */
export function applyUnreadOverrides<T extends { id: string; unread?: boolean }>(
  kind: InboxChatKind,
  chats: T[],
  overrides: ReadonlyMap<string, boolean>,
): T[] {
  if (overrides.size === 0) return chats;
  return chats.map((chat) => {
    const unread = overrides.get(unreadOverrideKey(kind, chat.id));
    return unread === undefined || unread === chat.unread ? chat : { ...chat, unread };
  });
}

/**
 * Sends one request per key at a time. A value chosen while one is in flight waits and only
 * the latest choice is sent next, so overlapping swipes can't reach the server out of order.
 * `settled` runs synchronously once nothing is left to send, or after a failure.
 */
export function createLatestQueue<T>() {
  const latest = new Map<string, T>();
  return async function send(
    key: string,
    value: T,
    request: (value: T) => Promise<void>,
    settled: () => void,
  ): Promise<void> {
    const running = latest.has(key);
    latest.set(key, value);
    if (running) return;
    try {
      for (;;) {
        const next = latest.get(key) as T;
        await request(next);
        if (latest.get(key) === next) return;
      }
    } finally {
      latest.delete(key);
      settled();
    }
  };
}
