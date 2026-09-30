export type ToolActivityPreference = "on" | "off";

export const TOOL_ACTIVITY_STORAGE_KEY = "rakazo.showToolActivity";

export type ResolveToolActivityOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

const listeners = new Set<() => void>();
let memoryPreference: ToolActivityPreference | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readStored(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(TOOL_ACTIVITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityPreference(
  raw: string | null | undefined,
): ToolActivityPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

export function toolActivityEnabled(preference: ToolActivityPreference = "off"): boolean {
  return preference === "on";
}

export function resolveToolActivityPreference(
  options: ResolveToolActivityOptions = {},
): ToolActivityPreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStored(options.storage ?? getLocalStorage());
  return normalizeToolActivityPreference(stored);
}

export function persistToolActivityPreference(
  preference: ToolActivityPreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(TOOL_ACTIVITY_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; the in-memory preference still applies.
  }
}

export function getToolActivityPreference(): ToolActivityPreference {
  return memoryPreference ?? resolveToolActivityPreference();
}

export function getToolActivityEnabled(): boolean {
  return toolActivityEnabled(getToolActivityPreference());
}

export function setToolActivityPreference(
  preference: ToolActivityPreference,
): ToolActivityPreference {
  memoryPreference = preference;
  persistToolActivityPreference(preference);
  notify();
  return preference;
}

export function subscribeToolActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
