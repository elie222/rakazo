export const COMPOSER_ENTER_TO_SEND_STORAGE_KEY = "rakazo.composerEnterToSend";

type EnterToSendStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<() => void>();
let memoryPreference: boolean | null = null;

function getLocalStorage(): EnterToSendStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function detectCoarsePointer(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/** Default: Enter sends on desktop and inserts a newline on touch devices. */
export function defaultComposerEnterToSend(coarsePointer = detectCoarsePointer()): boolean {
  return !coarsePointer;
}

export function normalizeComposerEnterToSend(
  raw: string | null | undefined,
  coarsePointer: boolean = detectCoarsePointer(),
): boolean {
  if (raw == null) return defaultComposerEnterToSend(coarsePointer);
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return defaultComposerEnterToSend(coarsePointer);
}

function readStoredComposerEnterToSend(
  storage: EnterToSendStorage | null,
  coarsePointer?: boolean,
): boolean {
  if (!storage) return defaultComposerEnterToSend(coarsePointer);
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY);
  } catch {
    raw = null;
  }
  return normalizeComposerEnterToSend(raw, coarsePointer);
}

export function getComposerEnterToSend(
  storage: EnterToSendStorage | null = getLocalStorage(),
  coarsePointer?: boolean,
): boolean {
  if (memoryPreference !== null) return memoryPreference;
  memoryPreference = readStoredComposerEnterToSend(storage, coarsePointer);
  return memoryPreference;
}

function persistComposerEnterToSend(preference: boolean, storage: EnterToSendStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY, preference ? "1" : "0");
  } catch {
    // Private browsing etc: keep the in-memory value.
  }
}

export function setComposerEnterToSend(
  preference: boolean,
  storage: EnterToSendStorage | null = getLocalStorage(),
): boolean {
  memoryPreference = preference;
  persistComposerEnterToSend(preference, storage);
  for (const listener of listeners) listener();
  return preference;
}

export function subscribeComposerEnterToSend(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
