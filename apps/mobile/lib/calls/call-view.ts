import { useNow } from "@rakazo/chat-ui/hooks";
import { useSyncExternalStore } from "react";
import { getCallId, getSnapshot, subscribe } from "./call-session";
import { onShowCall } from "./header-call";

/**
 * How the call is shown, shared by the full-screen call and the bars that bring it back (above
 * the composer, or in the iOS 26 tab bar's accessory). Minimizing belongs to one call, keyed by
 * its id, so a call that replaces it opens full screen.
 */
let minimizedCallKey: string | null = null;
const listeners = new Set<() => void>();
let opened: { callKey: string; at: number } | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function subscribeMinimized(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current call's key: its id, or its bot while the id is not set yet; null with no call. */
export function currentCallKey(): string | null {
  const call = getSnapshot();
  return call ? (getCallId() ?? call.botId) : null;
}

export function useCallKey(): string | null {
  return useSyncExternalStore(subscribe, currentCallKey, currentCallKey);
}

export function minimizeCall(): void {
  minimizedCallKey = currentCallKey();
  emit();
}

/** Brings the call back to full screen, as its bars and the header's Call button do. */
export function restoreCall(): void {
  if (minimizedCallKey === null) return;
  minimizedCallKey = null;
  emit();
}

// The header's Call button, pressed during a call, brings the call back.
onShowCall(restoreCall);

/** Whether the current call is minimized. */
export function useCallMinimized(): boolean {
  const callKey = useCallKey();
  const minimized = useSyncExternalStore(
    subscribeMinimized,
    () => minimizedCallKey,
    () => minimizedCallKey,
  );
  return callKey !== null && minimized === callKey;
}

/** When this call opened, kept for the call so every view of it shows the same clock. */
function openedAt(callKey: string): number {
  if (opened?.callKey !== callKey) opened = { callKey, at: Date.now() };
  return opened.at;
}

/** Whole seconds since the current call opened, ticking while it is on. */
export function useCallElapsed(): number {
  const callKey = useCallKey();
  const now = useNow(callKey ? 1000 : null);
  return callKey ? Math.max(0, Math.floor((now - openedAt(callKey)) / 1000)) : 0;
}

export function callClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
