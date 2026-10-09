import type { RemoteImagesPreference } from "@rakazo/core";
import { normalizeRemoteImagesPreference, REMOTE_IMAGES_STORAGE_KEY } from "@rakazo/core";

export type { RemoteImagesPreference };

const listeners = new Set<() => void>();
let memoryPreference: RemoteImagesPreference | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return getLocalStorage()?.getItem(REMOTE_IMAGES_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Saved choice wins. Nothing saved keeps web images behind a tap. */
export function getRemoteImagesPreference(): RemoteImagesPreference {
  return memoryPreference ?? normalizeRemoteImagesPreference(readStored());
}

export function getRemoteImagesEnabled(): boolean {
  return getRemoteImagesPreference() === "on";
}

export function setRemoteImagesPreference(
  preference: RemoteImagesPreference,
): RemoteImagesPreference {
  memoryPreference = preference;
  try {
    getLocalStorage()?.setItem(REMOTE_IMAGES_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; the in-memory preference still applies.
  }
  for (const listener of listeners) listener();
  return preference;
}

export function subscribeRemoteImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
