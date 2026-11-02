import type { AccountNotification, SavedAccountSummary } from "@rakazo/contracts";

export function accountUnreadCount(accounts: SavedAccountSummary[]): number {
  return accounts.reduce((total, account) => total + account.unread, 0);
}

/** Establish a baseline on first observation; unread history is not a new notification. */
export function accountNotificationChanges(
  accounts: SavedAccountSummary[],
  seen: Map<string, Set<string>>,
): Array<{ account: SavedAccountSummary; notification: AccountNotification }> {
  const changes: Array<{ account: SavedAccountSummary; notification: AccountNotification }> = [];
  const present = new Set(accounts.map((account) => account.userId));
  for (const userId of seen.keys()) if (!present.has(userId)) seen.delete(userId);
  for (const account of accounts) {
    const previous = seen.get(account.userId);
    for (const notification of account.notifications) {
      if (previous && !previous.has(notification.id)) changes.push({ account, notification });
    }
    // Retain recent IDs through bounded feed changes, without accumulating account history.
    seen.set(
      account.userId,
      new Set([...(previous ?? []), ...account.notifications.map((item) => item.id)].slice(-500)),
    );
  }
  return changes;
}

export function accountNotificationPath(notification: AccountNotification): string {
  return notification.groupId
    ? `/app/g/${encodeURIComponent(notification.groupId)}`
    : `/app/${encodeURIComponent(notification.botId)}`;
}
