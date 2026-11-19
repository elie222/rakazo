import type { RemoteImagesPreference } from "@rakazo/core";
import { normalizeRemoteImagesPreference, REMOTE_IMAGES_STORAGE_KEY } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export type { RemoteImagesPreference };

let memoryPreference: RemoteImagesPreference | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function getCachedRemoteImagesEnabled(): boolean {
  return memoryPreference === "on";
}

export async function loadRemoteImagesPreference(): Promise<RemoteImagesPreference> {
  try {
    const stored = await SecureStore.getItemAsync(REMOTE_IMAGES_STORAGE_KEY);
    memoryPreference = normalizeRemoteImagesPreference(stored);
  } catch {
    memoryPreference = memoryPreference ?? "off";
  }
  notify();
  return memoryPreference;
}

export async function setRemoteImagesPreference(
  preference: RemoteImagesPreference,
): Promise<RemoteImagesPreference> {
  memoryPreference = preference;
  // Paint the switch before SecureStore resolves.
  notify();
  try {
    await SecureStore.setItemAsync(REMOTE_IMAGES_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when SecureStore is unavailable.
  }
  return preference;
}

export function subscribeRemoteImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
