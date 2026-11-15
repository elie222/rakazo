import { abortableDelay, isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { subscribeSpaceSelection } from "./api";
import { subscribeRosterSignals } from "./api-live";
import { useAppForeground } from "./app-foreground";
import { computerUpdates } from "./computer-updates";
import { subscribeSessionGeneration } from "./session";

// One stream for the whole app, open while any screen holds it.
const rosterListeners = new Set<() => void>();
let holders = 0;
let close: (() => void) | undefined;

/** The stream speaks for one session and Space, so either changing reopens it. */
function followIdentity(listener: () => void): () => void {
  const unfollowSpace = subscribeSpaceSelection(listener);
  const unfollowSession = subscribeSessionGeneration(listener);
  return () => {
    unfollowSpace();
    unfollowSession();
  };
}

function nextIdentity(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      unfollow();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const unfollow = followIdentity(done);
    signal.addEventListener("abort", done);
    if (signal.aborted) done();
  });
}

async function follow(signal: AbortSignal) {
  let retry = 1_000;
  while (!signal.aborted) {
    let failure: unknown;
    let opened = false;
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener("abort", abort);
    const unfollowIdentity = followIdentity(abort);
    try {
      await subscribeRosterSignals(
        () => {
          if (connection.signal.aborted) return;
          opened = true;
          // Each connection opens with a signal, so a reconnect catches up on what it missed.
          for (const listener of rosterListeners) listener();
        },
        connection.signal,
        () => {
          if (!connection.signal.aborted) computerUpdates.signalled();
        },
      );
    } catch (error) {
      failure = error;
    }
    unfollowIdentity();
    signal.removeEventListener("abort", abort);
    if (signal.aborted) return;
    if (connection.signal.aborted) continue;
    if (failure !== undefined && !isRetryableError(failure)) {
      // Asking again cannot change a refusal, but another session or Space may answer; signing
      // out releases the stream anyway.
      await nextIdentity(signal);
      retry = 1_000;
      continue;
    }
    if (opened) retry = 1_000;
    await abortableDelay(opened ? reconnectDelayMs(failure) : retryDelayMs(failure, retry), signal);
    retry = Math.min(retry * 2, 30_000);
  }
}

function hold(): () => void {
  if (holders++ === 0) {
    const controller = new AbortController();
    void follow(controller.signal);
    close = () => controller.abort();
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

/**
 * Runs `read` while enabled: once when enabled or back in the foreground, then on each roster
 * signal, including the one each (re)connection opens with: a change made before the stream
 * subscribed reaches the app only through that opening signal.
 */
export function useRosterSignals(read: () => unknown, enabled: boolean): void {
  useLiveStream(enabled);
  const foreground = useAppForeground();
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!enabled || !foreground) return;
    const listener = () => void readRef.current();
    listener();
    rosterListeners.add(listener);
    return () => {
      rosterListeners.delete(listener);
    };
  }, [enabled, foreground]);
}
