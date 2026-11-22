import { readStoredString, writeStoredString } from "./stored-preference";

const STORAGE_PREFIX = "rakazo:app-rail-expanded:";

export function appRailExpandedStorageKey(userId: string | null | undefined): string | null {
  return userId ? `${STORAGE_PREFIX}${userId}` : null;
}

/** `null` means the user has never chosen; the rail then starts collapsed at its icon width. */
export function readAppRailExpanded(userId: string | null | undefined): boolean | null {
  const key = appRailExpandedStorageKey(userId);
  if (!key) return null;
  const raw = readStoredString(key);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function writeAppRailExpanded(userId: string | null | undefined, expanded: boolean): void {
  const key = appRailExpandedStorageKey(userId);
  if (key) writeStoredString(key, expanded ? "1" : "0");
}
