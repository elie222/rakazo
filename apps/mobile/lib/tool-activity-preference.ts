import type { ToolActivityPreference } from "@rakazo/core";
import { normalizeToolActivityPreference, TOOL_ACTIVITY_STORAGE_KEY } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

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
  try {
    memoryPreference = normalizeToolActivityPreference(
      await SecureStore.getItemAsync(TOOL_ACTIVITY_STORAGE_KEY),
    );
  } catch {
    memoryPreference = memoryPreference ?? "off";
  }
  notify();
  return memoryPreference;
}

export async function setToolActivityPreference(
  preference: ToolActivityPreference,
): Promise<ToolActivityPreference> {
  memoryPreference = preference;
  // Paint the switch before SecureStore resolves.
  notify();
  try {
    await SecureStore.setItemAsync(TOOL_ACTIVITY_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when SecureStore is unavailable.
  }
  return preference;
}

export function subscribeToolActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
