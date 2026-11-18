import { isRetryableError, reconnectDelayMs, retryDelayMs } from "@rakazo/core";

/**
 * Follows a server stream until stopped: reconnects after it drops, backs off while it cannot
 * open, and gives up on a refusal, calling `onRefused`. Returns the stop function.
 */
export function followStream<T>(
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  onFrame: (frame: T) => void,
  onRefused?: () => void,
): () => void {
  let active = true;
  let controller: AbortController | undefined;
  let cancelRetry: (() => void) | undefined;
  void (async () => {
    while (active) {
      controller = new AbortController();
      let failure: unknown;
      let opened = false;
      try {
        const stream = await open(controller.signal);
        opened = true;
        for await (const frame of stream) {
          if (!active) return;
          onFrame(frame);
        }
      } catch (cause) {
        failure = cause;
      } finally {
        controller.abort();
      }
      if (!active) return;
      if (failure !== undefined && !isRetryableError(failure)) {
        onRefused?.();
        return;
      }
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
  };
}
