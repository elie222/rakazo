import * as Notifications from "expo-notifications";
import { cachedSavedAccounts, selectedSavedAccount } from "./saved-accounts";

type InboxChats = {
  bots: readonly { unread?: boolean }[];
  groups: readonly { unread?: boolean }[];
};

let written: number | null = null;
let generation = 0;

/** Unread chats across the selected organization's inbox Spaces. */
export function unreadChatCount(spaces: readonly InboxChats[]): number {
  return spaces.reduce(
    (count, space) =>
      count +
      space.bots.filter((bot) => bot.unread).length +
      space.groups.filter((group) => group.unread).length,
    0,
  );
}

/**
 * A push can set the icon while the app is in the background, so the last count written is
 * no longer what the icon shows. The next sync writes the full count again.
 */
export function forgetAppBadge(): void {
  generation += 1;
  written = null;
}

/** Puts the count on the app icon, writing only when it changes. iOS ignores it without permission. */
export async function syncAppBadge(count: number): Promise<void> {
  if (count === written) return;
  written = count;
  const set = await Notifications.setBadgeCountAsync(count).catch(() => false);
  if (!set && written === count) written = null;
}

/** Capture when an inbox request starts; pre-foreground responses cannot overwrite a push. */
export function appBadgeGeneration(): number {
  return generation;
}

export async function syncInboxAppBadge(
  count: number,
  loadedGeneration: number | null,
): Promise<void> {
  if (loadedGeneration !== generation) return;
  const selected = selectedSavedAccount();
  if (!selected) return syncAppBadge(count);
  const accounts = cachedSavedAccounts(selected.apiBase);
  const current = accounts.find((row) => row.userId === selected.userId);
  if (!current) return syncAppBadge(count);
  const stillCurrent = () =>
    loadedGeneration === generation &&
    selectedSavedAccount()?.userId === selected.userId &&
    selectedSavedAccount()?.apiBase === selected.apiBase;
  // An inbox covers its selected organization; the saved summary includes every organization.
  // Refresh just this account so reading a chat updates the icon without dropping its other work.
  try {
    const { refreshAccountSummaries } = await import("./account-sessions");
    if (!stillCurrent()) return;
    await refreshAccountSummaries(selected.userId);
  } catch {
    // Retain the account-wide cached total while the server is unreachable.
  }
  if (!stillCurrent()) return;
  const fresh = cachedSavedAccounts(selected.apiBase);
  if (!fresh.some((row) => row.userId === selected.userId && row.token === current.token)) return;
  await syncAppBadge(fresh.reduce((sum, row) => sum + row.unread, 0));
}

export async function clearAppBadge(): Promise<void> {
  forgetAppBadge();
  await syncAppBadge(0);
}
