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

function envDefault(): string | null {
  return typeof process !== "undefined" &&
    typeof process.env.EXPO_PUBLIC_DEFAULT_RESPONSE_STREAMING === "string"
    ? process.env.EXPO_PUBLIC_DEFAULT_RESPONSE_STREAMING
    : null;
}

export function getCachedResponseStreamingPreference(): ResponseStreamingPreference {
  return memoryPreference ?? normalizeResponseStreamingPreference(envDefault());
}

export function getCachedResponseStreamingEnabled(): boolean {
  return responseStreamingEnabled(getCachedResponseStreamingPreference());
}

export async function loadResponseStreamingPreference(): Promise<ResponseStreamingPreference> {
  try {
    const stored = await SecureStore.getItemAsync(RESPONSE_STREAMING_STORAGE_KEY);
    memoryPreference =
      stored != null
        ? normalizeResponseStreamingPreference(stored)
        : normalizeResponseStreamingPreference(envDefault());
  } catch {
    memoryPreference = memoryPreference ?? normalizeResponseStreamingPreference(envDefault());
  }
  notify();
  return memoryPreference;
}

export async function setResponseStreamingPreference(
  preference: ResponseStreamingPreference,
): Promise<ResponseStreamingPreference> {
  memoryPreference = preference;
  try {
    await SecureStore.setItemAsync(RESPONSE_STREAMING_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when SecureStore is unavailable.
  }
  notify();
  return preference;
}

export function subscribeResponseStreaming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
