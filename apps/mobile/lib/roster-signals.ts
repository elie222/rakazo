import { abortableDelay, isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { subscribeSpaceSelection } from "./api";
import { subscribeRosterSignals } from "./api-live";
import { useAppForeground } from "./app-foreground";
import { computerUpdates } from "./computer-updates";

/**
 * Holds the server's live stream open while enabled and in the foreground, which also carries
 * computer update signals. Runs `onChange` for each roster change while `followRoster` is set.
 * True while signals are live, so polling can slow down; the first signal of each connection only
 * flips this, since the poll that restarts with it already catches up.
 */
export function useRosterSignals(
  onChange: () => unknown,
  enabled: boolean,
  followRoster: boolean,
): boolean {
  const foreground = useAppForeground();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const followRosterRef = useRef(followRoster);
  followRosterRef.current = followRoster;
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled || !foreground) return;
    const controller = new AbortController();
    void (async () => {
      let retry = 1_000;
      while (!controller.signal.aborted) {
        let failure: unknown;
        let opened = false;
        // The stream speaks for the Space selected when it opened, so a switch reopens it.
        const connection = new AbortController();
        const close = () => connection.abort();
        controller.signal.addEventListener("abort", close);
        const unfollowSpace = subscribeSpaceSelection(close);
        try {
          await subscribeRosterSignals(
            () => {
              if (connection.signal.aborted) return;
              if (opened && followRosterRef.current) void onChangeRef.current();
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
        controller.signal.removeEventListener("abort", close);
        if (controller.signal.aborted) return;
        setLive(false);
        if (connection.signal.aborted) continue;
        if (failure !== undefined && !isRetryableError(failure)) return;
        if (opened) retry = 1_000;
        await abortableDelay(
          opened ? reconnectDelayMs(failure) : retryDelayMs(failure, retry),
          controller.signal,
        );
        retry = Math.min(retry * 2, 30_000);
      }
    })();
    return () => {
      controller.abort();
      setLive(false);
    };
  }, [enabled, foreground]);

  return live;
}
