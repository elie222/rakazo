export async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
    // Abort can land between the check above and the listener; resolve now rather
    // than waiting out the full delay (or hanging if the event already fired).
    if (signal?.aborted) finish();
  });
}

/**
 * `AbortSignal.any`, which Safari only ships from 17.4. Aborts with the first
 * input's reason and stops listening to the others once it has.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return controller.signal;
  }
  const onAbort = (event: Event) => {
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of signals) signal.addEventListener("abort", onAbort);
  return controller.signal;
}
