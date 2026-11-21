import { readStoredString, writeStoredString } from "./stored-preference";

const STORAGE_PREFIX = "rakazo:app-rail-expanded:";

export function appRailExpandedStorageKey(userId: string | null | undefined): string | null {
  return userId ? `${STORAGE_PREFIX}${userId}` : null;
}

/** `null` means the user has never chosen; the layout then follows the wide-window default. */
export function readAppRailExpanded(userId: string | null | undefined): boolean | null {
  const key = appRailExpandedStorageKey(userId);
  if (!key) return null;
  const raw = readStoredString(key);
  return raw === null ? null : raw === "1";
}

export function writeAppRailExpanded(userId: string | null | undefined, expanded: boolean): void {
  const key = appRailExpandedStorageKey(userId);
  if (key) writeStoredString(key, expanded ? "1" : null);
}
