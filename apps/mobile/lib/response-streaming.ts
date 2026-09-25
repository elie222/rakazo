import type { ResponseStreamingPreference } from "@rakazo/core";
import {
  normalizeResponseStreamingPreference,
  RESPONSE_STREAMING_STORAGE_KEY,
  responseStreamingEnabled,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";

export type { ResponseStreamingPreference };

let memoryPreference: ResponseStreamingPreference | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function getCachedResponseStreamingPreference(): ResponseStreamingPreference {
  return memoryPreference ?? "off";
}

export function getCachedResponseStreamingEnabled(): boolean {
  return responseStreamingEnabled(getCachedResponseStreamingPreference());
}

export async function loadResponseStreamingPreference(): Promise<ResponseStreamingPreference> {
  try {
    const stored = await SecureStore.getItemAsync(RESPONSE_STREAMING_STORAGE_KEY);
    memoryPreference = normalizeResponseStreamingPreference(stored);
  } catch {
    memoryPreference = memoryPreference ?? "off";
  }
  notify();
  return memoryPreference;
}

export async function setResponseStreamingPreference(
  preference: ResponseStreamingPreference,
): Promise<ResponseStreamingPreference> {
  memoryPreference = preference;
  // Paint the switch before SecureStore resolves.
  notify();
  try {
    await SecureStore.setItemAsync(RESPONSE_STREAMING_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when SecureStore is unavailable.
  }
  return preference;
}

export function subscribeResponseStreaming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
