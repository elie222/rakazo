import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

type ThreadHead = { threadId: string; cursor: number };

/** Recover a durable event stream while its caller owns snapshot commits and UI effects. */
export async function runThreadSubscription(options: {
  signal: AbortSignal;
  loadInitial: () => Promise<ThreadHead | null>;
  loadHead: () => Promise<ThreadHead | null>;
  refresh: () => Promise<unknown>;
  currentSnapshot: () => ThreadHead | null;
  subscribe: (cursor: number) => Promise<AsyncIterable<ProductEvent>>;
  beforeEvent?: (event: ProductEvent) => void;
  applyEvent: (event: ProductEvent) => void;
  onEvent: (event: ProductEvent, initial: ThreadHead) => void;
}): Promise<void> {
  const { signal } = options;
  const wait = async (ms: number) => {
    await abortableDelay(ms, signal);
    return !signal.aborted;
  };
  let initial = await options.loadInitial().catch(() => null);
  if (signal.aborted) return;
  let headRetryMs = 250;
  while (!initial && !signal.aborted) {
    initial = await options.loadHead().catch(() => null);
    if (initial) break;
    if (!(await wait(headRetryMs))) return;
    headRetryMs = Math.min(headRetryMs * 2, 5_000);
  }
  if (!initial || signal.aborted) return;
  const head = initial;
  let cursor = head.cursor;
  let snapshotReady = options.currentSnapshot()?.threadId === head.threadId;
  const pendingSnapshotEvents: ProductEvent[] = [];
  if (!snapshotReady) {
    void (async () => {
      let snapshotRetryMs = 250;
      while (!snapshotReady && !signal.aborted) {
        if (!(await wait(snapshotRetryMs))) return;
        await options.refresh().catch(() => null);
        if (signal.aborted) return;
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
    try {
      const events = await options.subscribe(cursor);
      for await (const event of events) {
        if (signal.aborted) break;
        cursor = Math.max(cursor, event.seq);
        retryMs = 250;
        options.beforeEvent?.(event);
        if (snapshotReady && options.currentSnapshot()?.threadId === event.threadId) {
          options.applyEvent(event);
        } else {
          pendingSnapshotEvents.push(event);
        }
        options.onEvent(event, head);
      }
    } catch {
      // Reconnect from the last durable event after a transient transport failure.
    }
    if (signal.aborted) return;
    await options.refresh().catch(() => null);
    if (!(await wait(retryMs))) return;
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}
