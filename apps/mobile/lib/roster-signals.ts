import { abortableDelay, isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { subscribeSpaceSelection } from "./api";
import { subscribeRosterSignals } from "./api-live";
import { useAppForeground } from "./app-foreground";
import { computerUpdates } from "./computer-updates";

// One stream for the whole app, open while any screen holds it.
const rosterListeners = new Set<() => void>();
const liveListeners = new Set<() => void>();
let live = false;
let holders = 0;
let close: (() => void) | undefined;

const setLive = (next: boolean) => {
  if (live === next) return;
  live = next;
  for (const listener of liveListeners) listener();
};

async function follow(signal: AbortSignal) {
  let retry = 1_000;
  while (!signal.aborted) {
    let failure: unknown;
    let opened = false;
    // The stream speaks for the Space selected when it opened, so a switch reopens it.
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener("abort", abort);
    const unfollowSpace = subscribeSpaceSelection(abort);
    try {
      await subscribeRosterSignals(
        () => {
          if (connection.signal.aborted) return;
          if (opened) for (const listener of rosterListeners) listener();
          opened = true;
          setLive(true);
        },
        connection.signal,
        () => {
          if (!connection.signal.aborted) computerUpdates.signalled();
        },
      );
    } catch (error) {
      failure = error;
    }
    unfollowSpace();
    signal.removeEventListener("abort", abort);
    if (signal.aborted) return;
    setLive(false);
    if (connection.signal.aborted) continue;
    if (failure !== undefined && !isRetryableError(failure)) return;
    if (opened) retry = 1_000;
    await abortableDelay(opened ? reconnectDelayMs(failure) : retryDelayMs(failure, retry), signal);
    retry = Math.min(retry * 2, 30_000);
  }
}

function hold(): () => void {
  if (holders++ === 0) {
    const controller = new AbortController();
    void follow(controller.signal);
    close = () => {
      controller.abort();
      setLive(false);
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders > 0) return;
    close?.();
    close = undefined;
  };
}

/** Keeps the server's live stream open while enabled and in the foreground. */
export function useLiveStream(enabled: boolean): void {
  const foreground = useAppForeground();
  useEffect(() => (enabled && foreground ? hold() : undefined), [enabled, foreground]);
}

const subscribeLive = (listener: () => void) => {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
};

/**
 * Runs `onChange` for each roster change while enabled. True while signals are live, so polling
 * can slow down; the first signal of each connection only flips this, since the poll that
 * restarts with it already catches up.
 */
export function useRosterSignals(onChange: () => unknown, enabled: boolean): boolean {
  useLiveStream(enabled);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    const listener = () => void onChangeRef.current();
    rosterListeners.add(listener);
    return () => {
      rosterListeners.delete(listener);
    };
  }, [enabled]);
  return useSyncExternalStore(subscribeLive, () => live) && enabled;
}
