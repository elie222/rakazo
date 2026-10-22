import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";
import { isRetryableError, retryDelayMs } from "./retry-policy.js";

type ThreadHead = { threadId: string; cursor: number };

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/** Recover a durable event stream while its caller owns snapshot commits and UI effects. */
export async function runThreadSubscription(options: {
  signal: AbortSignal;
  loadInitial: () => Promise<ThreadHead | null>;
  loadHead: () => Promise<ThreadHead | null>;
  refresh: () => Promise<unknown>;
  currentSnapshot: () => ThreadHead | null;
  subscribe: (cursor: number, signal: AbortSignal) => Promise<AsyncIterable<ProductEvent>>;
  beforeEvent?: (event: ProductEvent) => void;
  applyEvent: (event: ProductEvent) => void;
  onEvent: (event: ProductEvent, initial: ThreadHead) => void;
}): Promise<void> {
  const { signal } = options;
  // A 401 (session gone), 426 (build retired) or other 4xx is the server's answer: retrying
  // cannot succeed and only polls the server. A 429 may ask for a longer wait.
  let refused = false;
  let lastFailure: unknown;
  const stopped = () => signal.aborted || refused;
  const noteFailure = (error: unknown) => {
    // Keep whichever failure asked for the longer wait (a 429's Retry-After).
    if (retryDelayMs(error, 0) >= retryDelayMs(lastFailure, 0)) lastFailure = error;
    if (!isRetryableError(error)) refused = true;
    return null;
  };
  const wait = async (ms: number) => {
    const delay = retryDelayMs(lastFailure, ms);
    lastFailure = undefined;
    await abortableDelay(delay, signal);
    return !stopped();
  };
  let initial = await options.loadInitial().catch(noteFailure);
  if (stopped()) return;
  let headRetryMs = 250;
  while (!initial && !stopped()) {
    initial = await options.loadHead().catch(noteFailure);
    if (initial) break;
    if (stopped() || !(await wait(headRetryMs))) return;
    headRetryMs = Math.min(headRetryMs * 2, 5_000);
  }
  if (!initial || stopped()) return;
  const head = initial;
  let cursor = head.cursor;
  let snapshotReady = options.currentSnapshot()?.threadId === head.threadId;
  const pendingSnapshotEvents: ProductEvent[] = [];
  if (!snapshotReady) {
    void (async () => {
      let snapshotRetryMs = 250;
      while (!snapshotReady && !stopped()) {
        if (!(await wait(snapshotRetryMs))) return;
        await options.refresh().catch(noteFailure);
        if (stopped()) return;
        const committed = options.currentSnapshot();
        if (committed?.threadId === head.threadId) {
          snapshotReady = true;
          for (const event of pendingSnapshotEvents.splice(0)) {
            if (event.seq > committed.cursor) options.applyEvent(event);
          }
          return;
        }
        snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
      }
    })();
  }
  let retryMs = 250;
  while (!signal.aborted) {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort(signal.reason);
    signal.addEventListener("abort", abortAttempt, { once: true });
    if (signal.aborted) abortAttempt();
    try {
      const events = await options.subscribe(cursor, attempt.signal);
      const iterator = events[Symbol.asyncIterator]();
      try {
        let pending: Promise<IteratorResult<ProductEvent>> | undefined;
        while (!signal.aborted) {
          pending ??= iterator.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = await Promise.race([
            pending,
            new Promise<"idle">((resolve) => {
              timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (signal.aborted || next === "idle" || next.done) break;
          pending = undefined;
          const event = next.value;
          retryMs = 250;
          // Heartbeats only prove the socket is alive; they carry no state and no cursor.
          if (event.type === "heartbeat") continue;
          cursor = Math.max(cursor, event.seq);
          options.beforeEvent?.(event);
          if (snapshotReady && options.currentSnapshot()?.threadId === event.threadId) {
            options.applyEvent(event);
          } else if (!snapshotReady) {
            pendingSnapshotEvents.push(event);
          }
          options.onEvent(event, head);
        }
      } finally {
        // Cancel the HTTP request before reconnecting. Iterator.return alone can
        // leave the fetch socket open in Safari and exhaust the shared tab pool.
        attempt.abort();
        void iterator.return?.(undefined).catch(() => {});
      }
    } catch (error) {
      // Reconnect from the last durable event after a transient failure.
      noteFailure(error);
    } finally {
      signal.removeEventListener("abort", abortAttempt);
      // Also release attempts that failed before returning an iterator.
      attempt.abort();
    }
    if (stopped()) return;
    await options.refresh().catch(noteFailure);
    if (stopped() || !(await wait(retryMs))) return;
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}
