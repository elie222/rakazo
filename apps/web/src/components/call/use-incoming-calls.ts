import type { IncomingBotCall } from "@rakazo/contracts";
import { isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

const NO_CALLS: IncomingBotCall[] = [];

/** The account's ringing calls in this Space, as the server's call stream reports them. */
export function useIncomingCalls(spaceId: string | undefined): IncomingBotCall[] {
  const [calls, setCalls] = useState<IncomingBotCall[]>(NO_CALLS);
  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    let controller: AbortController | undefined;
    let cancelRetry: (() => void) | undefined;
    void (async () => {
      while (active) {
        controller = new AbortController();
        let failure: unknown;
        let opened = false;
        try {
          const stream = await rpc.notifications.subscribeCalls(undefined, {
            signal: controller.signal,
          });
          opened = true;
          for await (const frame of stream) {
            if (!active) return;
            if (frame.payload)
              setCalls(frame.payload.calls.filter((call) => call.spaceId === spaceId));
          }
        } catch (cause) {
          failure = cause;
        } finally {
          controller.abort();
        }
        if (!active || (failure !== undefined && !isRetryableError(failure))) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            opened ? reconnectDelayMs(failure) : retryDelayMs(failure, 1_000),
          );
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();
    return () => {
      active = false;
      controller?.abort();
      cancelRetry?.();
      setCalls(NO_CALLS);
    };
  }, [spaceId]);
  return calls;
}
