import * as Notifications from "expo-notifications";

type InboxChats = {
  bots: readonly { unread?: boolean }[];
  groups: readonly { unread?: boolean }[];
};

let written: number | null = null;
let generation = 0;

/** Unread chats across the inbox Spaces. */
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
