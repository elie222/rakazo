import { useLayoutEffect, useState } from "react";

const PRELOAD_RECOVERY_KEY = "rk:preload-recovery";
const PRELOAD_RECOVERY_STATE_KEY = "rk:preload-recovery-state";
let restoredState: Record<string, unknown> = {};
const overlayState: Record<string, unknown> = {};

/** Only recovery reloads write this snapshot; reading it consumes it. */
export function readPreloadRecoveryState(
  storage: Pick<Storage, "getItem" | "removeItem">,
): Record<string, unknown> {
  try {
    const saved = storage.getItem(PRELOAD_RECOVERY_STATE_KEY);
    storage.removeItem(PRELOAD_RECOVERY_STATE_KEY);
    const value: unknown = JSON.parse(saved ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Opt in read-only overlay state, never create or confirmation dialogs. */
export function usePreloadRecoveryState<T>(key: string, initial: T) {
  const state = useState<T>(() => (key in restoredState ? (restoredState[key] as T) : initial));
  const [value] = state;
  useLayoutEffect(() => {
    delete restoredState[key];
    overlayState[key] = value;
    return () => {
      delete overlayState[key];
    };
  }, [key, value]);
  return state;
}

const PRELOAD_RECOVERY_COOLDOWN_MS = 30_000;

type PreloadRecoveryWindow = Pick<
  Window,
  | "addEventListener"
  | "clearTimeout"
  | "location"
  | "navigator"
  | "removeEventListener"
  | "sessionStorage"
  | "setTimeout"
>;

/**
 * Vite emits this event when a lazy chunk from an older deployment no longer
 * exists. Reload once so the browser receives the current asset manifest.
 * While offline a reload would only reach the browser's offline page, so the
 * failure is left to the app's error boundaries, which offer a retry.
 */
export function installPreloadRecovery(
  target: PreloadRecoveryWindow = window,
  getState: () => Record<string, unknown> = () => overlayState,
): () => void {
  let storage: Storage;
  try {
    storage = target.sessionStorage;
  } catch {
    restoredState = {};
    return () => {};
  }
  restoredState = readPreloadRecoveryState(storage);
  const clearRecovery = target.setTimeout(
    () => storage.removeItem(PRELOAD_RECOVERY_KEY),
    PRELOAD_RECOVERY_COOLDOWN_MS,
  );
  const onPreloadError = (event: Event) => {
    if (!target.navigator.onLine || storage.getItem(PRELOAD_RECOVERY_KEY)) return;
    event.preventDefault();
    storage.setItem(PRELOAD_RECOVERY_KEY, "1");
    try {
      storage.setItem(PRELOAD_RECOVERY_STATE_KEY, JSON.stringify(getState()));
    } catch {
      // Recovery still works when the overlay snapshot cannot be stored.
    }
    target.location.reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    target.clearTimeout(clearRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}
