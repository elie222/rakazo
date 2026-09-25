import type { ResponseStreamingPreference } from "@rakazo/core";
import {
  normalizeResponseStreamingPreference,
  RESPONSE_STREAMING_STORAGE_KEY,
  responseStreamingEnabled,
} from "@rakazo/core";

export type { ResponseStreamingPreference };

export type ResolveResponseStreamingOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

const listeners = new Set<() => void>();
let memoryPreference: ResponseStreamingPreference | null = null;

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
    return storage.getItem(RESPONSE_STREAMING_STORAGE_KEY);
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

/** Saved choice wins. Nothing saved leaves streaming off. */
export function resolveResponseStreamingPreference(
  options: ResolveResponseStreamingOptions = {},
): ResponseStreamingPreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStored(options.storage ?? getLocalStorage());
  return normalizeResponseStreamingPreference(stored);
}

export function persistResponseStreamingPreference(
  preference: ResponseStreamingPreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RESPONSE_STREAMING_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function getResponseStreamingPreference(): ResponseStreamingPreference {
  return memoryPreference ?? resolveResponseStreamingPreference();
}

export function getResponseStreamingEnabled(): boolean {
  return responseStreamingEnabled(getResponseStreamingPreference());
}

export function setResponseStreamingPreference(
  preference: ResponseStreamingPreference,
): ResponseStreamingPreference {
  memoryPreference = preference;
  persistResponseStreamingPreference(preference);
  notify();
  return preference;
}

export function subscribeResponseStreaming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
