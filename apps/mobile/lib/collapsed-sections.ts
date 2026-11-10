import * as SecureStore from "expo-secure-store";

/** Collapsed inbox sections for the last account that changed them here. */
export const COLLAPSED_SECTIONS_KEY = "rakazo.collapsed-sections";

export type CollapsedSections = { userId?: string; keys: ReadonlySet<string> };

/** Null when nothing usable is stored: every section starts expanded. */
export async function loadCollapsedSections(): Promise<CollapsedSections | null> {
  await saving;
  try {
    const stored = JSON.parse(
      (await SecureStore.getItemAsync(COLLAPSED_SECTIONS_KEY)) ?? "null",
    ) as {
      userId?: unknown;
      keys?: unknown;
    } | null;
    if (typeof stored?.userId === "string" && Array.isArray(stored.keys)) {
      return {
        userId: stored.userId,
        keys: new Set(stored.keys.filter((key): key is string => typeof key === "string")),
      };
    }
  } catch {
    // Unreadable or unavailable storage starts with every section expanded.
  }
  return null;
}

let saving: Promise<void> = Promise.resolve();

/** Writes one at a time, so the last change is the one kept. */
export function saveCollapsedSections(userId: string, keys: ReadonlySet<string>) {
  const value = JSON.stringify({ userId, keys: [...keys] });
  saving = saving
    .then(() => SecureStore.setItemAsync(COLLAPSED_SECTIONS_KEY, value))
    .catch(() => undefined);
}
