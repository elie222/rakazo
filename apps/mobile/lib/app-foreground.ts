import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

/** iOS passes through "inactive" for system overlays; only a real background pauses work. */
export function isForegroundState(state: AppStateStatus | null | undefined): boolean {
  return state !== "background";
}

function subscribe(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

const currentForeground = () => isForegroundState(AppState.currentState);

/** Whether the app is on screen, for live work that should stop while it is backgrounded. */
export function useAppForeground(): boolean {
  return useSyncExternalStore(subscribe, currentForeground, currentForeground);
}
