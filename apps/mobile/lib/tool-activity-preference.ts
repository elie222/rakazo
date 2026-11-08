import type { ToolActivityPreference } from "@rakazo/core";
import { normalizeToolActivityPreference, TOOL_ACTIVITY_STORAGE_KEY } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

let pendingWrite = Promise.resolve();
let preferenceRevision = 0;
let memoryPreference: ToolActivityPreference | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Off until this device saved "on", as on web, so chats stay clean by default. */
export function getCachedToolActivityEnabled(): boolean {
  return (memoryPreference ?? "off") === "on";
}

export async function loadToolActivityPreference(): Promise<ToolActivityPreference> {
  const revision = preferenceRevision;
  await pendingWrite;
  const stored = await SecureStore.getItemAsync(TOOL_ACTIVITY_STORAGE_KEY).catch(() => null);
  if (revision === preferenceRevision && memoryPreference === null) {
    memoryPreference = normalizeToolActivityPreference(stored);
  }
  notify();
  return memoryPreference ?? "off";
}

export async function setToolActivityPreference(
  preference: ToolActivityPreference,
): Promise<ToolActivityPreference> {
  preferenceRevision += 1;
  memoryPreference = preference;
  // Paint the switch before SecureStore resolves.
  notify();
  pendingWrite = pendingWrite
    .then(() => SecureStore.setItemAsync(TOOL_ACTIVITY_STORAGE_KEY, preference))
    .catch(() => undefined);
  await pendingWrite;
  return preference;
}

export function subscribeToolActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
