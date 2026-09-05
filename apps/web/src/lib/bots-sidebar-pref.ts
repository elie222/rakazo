const STORAGE_PREFIX = "rakazo:bots-sidebar-collapsed:";

export function botsSidebarCollapsedStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `${STORAGE_PREFIX}${userId}`;
}

export function readBotsSidebarCollapsed(userId: string | null | undefined): boolean {
  const storageKey = botsSidebarCollapsedStorageKey(userId);
  if (!storageKey) return false;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

export function writeBotsSidebarCollapsed(
  userId: string | null | undefined,
  collapsed: boolean,
): void {
  const storageKey = botsSidebarCollapsedStorageKey(userId);
  if (!storageKey) return;
  try {
    if (collapsed) window.localStorage.setItem(storageKey, "1");
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore quota / private-mode failures; in-memory state still applies.
  }
}

/** Drag distance (px) before the edge handle commits expand/collapse. */
export const BOTS_SIDEBAR_EDGE_DRAG_PX = 40;
