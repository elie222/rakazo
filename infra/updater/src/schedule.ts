import { abortableDelay } from "@rakazo/core";

/** A restart waits a full interval, and long-running updates never overlap scheduled checks. */
export function startUpdateSchedule(
  intervalMs: number,
  update: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  if (intervalMs === 0) return async () => {};
  const stop = new AbortController();
  const pending = (async () => {
    while (!stop.signal.aborted) {
      await abortableDelay(intervalMs, stop.signal);
      if (stop.signal.aborted) break;
      try {
        await update();
      } catch (error) {
        onError(error);
      }
    }
  })();
  return async () => {
    stop.abort();
    await pending;
  };
}
