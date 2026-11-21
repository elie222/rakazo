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

/**
 * A signal that aborts with a `TimeoutError` after `ms`, or with `parent`'s reason when that aborts
 * first. Nothing to dispose; {@link requestDeadline} is the one with its own message.
 */
export function deadlineSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent ? anySignal([parent, timeout]) : timeout;
}

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it aborts, even when the
 * promise itself ignores the signal. `abortedMessage` covers runtimes whose signals carry no reason.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortedMessage = "Request aborted.",
): Promise<T> {
  const reason = () => signal.reason ?? new Error(abortedMessage);
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A signal that aborts with `message` after `timeoutMs`, or with `parent`'s reason when that
 * aborts first. Dispose once the request settles.
 */
export function requestDeadline(timeoutMs: number, message: string, parent?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * `fn` over each item with at most `limit` calls running at once, resolving to the results in
 * the items' order. The first rejection rejects the whole call and starts no further items; calls
 * already running are left to settle.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
