import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

type ThreadHead = { threadId: string; cursor: number };
type SnapshotRecovery =
  | { phase: "snapshot" }
  | { phase: "replay"; projectionFloor: number; readonly suppressEffectsThrough: number }
  | { phase: "live" };

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/**
 * Recover a durable stream while its caller owns snapshot commits and UI effects.
 * Missing snapshot state is replayed from storage without retaining delivered payloads.
 */
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
  const stopped = Symbol("stopped");
  const snapshotAbort = new AbortController();
  let activeAttempt: AbortController | undefined;
  // Reusing a pending cancellation promise would retain every frame raced against it.
  const untilAborted = async <T>(
    work: Promise<T>,
    abort: AbortSignal,
  ): Promise<T | typeof stopped> => {
    let onAbort!: () => void;
    const cancelled = new Promise<typeof stopped>((resolve) => {
      onAbort = () => resolve(stopped);
      abort.addEventListener("abort", onAbort, { once: true });
      if (abort.aborted) onAbort();
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      abort.removeEventListener("abort", onAbort);
    }
  };
  const onAbort = () => {
    activeAttempt?.abort(signal.reason);
    snapshotAbort.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let snapshotTask: Promise<void> | undefined;
  try {
    if (signal.aborted) return;
    let initial = await untilAborted(
      options.loadInitial().catch(() => null),
      signal,
    );
    if (initial === stopped || signal.aborted) return;
    let headRetryMs = 250;
    while (!initial && !signal.aborted) {
      initial = await untilAborted(
        options.loadHead().catch(() => null),
        signal,
      );
      if (initial === stopped || signal.aborted) return;
      if (initial) break;
      await abortableDelay(headRetryMs, signal);
      headRetryMs = Math.min(headRetryMs * 2, 5_000);
    }
    if (!initial || signal.aborted) return;
    const head = initial;
    let cursor = head.cursor;
    let effectsCursor = head.cursor;
    let generation = 0;
    const recovery: { current: SnapshotRecovery } = {
      current:
        options.currentSnapshot()?.threadId === head.threadId
          ? { phase: "live" }
          : { phase: "snapshot" },
    };
    const commitRecovery = () => {
      if (signal.aborted || recovery.current.phase !== "snapshot") return;
      const committed = options.currentSnapshot();
      if (committed?.threadId !== head.threadId) return;
      recovery.current = {
        phase: "replay",
        projectionFloor: committed.cursor,
        suppressEffectsThrough: effectsCursor,
      };
      cursor = Math.min(committed.cursor, effectsCursor);
      generation += 1;
      activeAttempt?.abort();
      snapshotAbort.abort();
    };
    if (recovery.current.phase === "snapshot") {
      snapshotTask = (async () => {
        let snapshotRetryMs = 250;
        while (!snapshotAbort.signal.aborted) {
          await abortableDelay(snapshotRetryMs, snapshotAbort.signal);
          if (snapshotAbort.signal.aborted) return;
          await untilAborted(
            options.refresh().catch(() => null),
            snapshotAbort.signal,
          );
          if (snapshotAbort.signal.aborted) return;
          commitRecovery();
          snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
        }
      })();
    }
    let retryMs = 250;
    while (!signal.aborted) {
      const attempt = new AbortController();
      activeAttempt = attempt;
      const attemptGeneration = ++generation;
      try {
        const events = await untilAborted(
          options.subscribe(cursor, attempt.signal),
          attempt.signal,
        );
        if (events === stopped || signal.aborted || generation !== attemptGeneration) continue;
        const iterator = events[Symbol.asyncIterator]();
        try {
          let pending: Promise<IteratorResult<ProductEvent>> | undefined;
          while (!signal.aborted) {
            pending ??= iterator.next();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await untilAborted(
              Promise.race([
                pending,
                new Promise<"idle">((resolve) => {
                  timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
                }),
              ]),
              attempt.signal,
            ).finally(() => clearTimeout(timer));
            if (
              signal.aborted ||
              generation !== attemptGeneration ||
              next === stopped ||
              next === "idle" ||
              next.done
            )
              break;
            pending = undefined;
            const event = next.value;
            retryMs = 250;
            // Heartbeats only prove the socket is alive; they carry no state and no cursor.
            if (event.type === "heartbeat") continue;
            cursor = Math.max(cursor, event.seq);
            const replay = recovery.current.phase === "replay" ? recovery.current : null;
            const deliverEffects = !replay || event.seq > replay.suppressEffectsThrough;
            if (deliverEffects) options.beforeEvent?.(event);
            const snapshot = options.currentSnapshot();
            if (replay && snapshot?.threadId === head.threadId) {
              replay.projectionFloor = Math.max(replay.projectionFloor, snapshot.cursor);
            }
            if (
              recovery.current.phase !== "snapshot" &&
              snapshot?.threadId === event.threadId &&
              (!replay || event.seq > replay.projectionFloor)
            ) {
              options.applyEvent(event);
            }
            if (deliverEffects) {
              options.onEvent(event, head);
              effectsCursor = Math.max(effectsCursor, event.seq);
            }
            if (
              replay &&
              event.seq >= Math.max(replay.projectionFloor, replay.suppressEffectsThrough)
            ) {
              recovery.current = { phase: "live" };
            }
          }
        } finally {
          // Abort before return: a pending read can otherwise keep Safari's socket open.
          attempt.abort();
          void iterator.return?.(undefined).catch(() => {});
        }
      } catch {
        // Reconnect from the last durable event after a transient transport failure.
      } finally {
        attempt.abort();
        activeAttempt = undefined;
      }
      if (signal.aborted) return;
      if (generation !== attemptGeneration) continue;
      const reconnect = new AbortController();
      activeAttempt = reconnect;
      try {
        await untilAborted(
          options.refresh().catch(() => null),
          reconnect.signal,
        );
        if (signal.aborted) return;
        commitRecovery();
        if (generation !== attemptGeneration) continue;
        await abortableDelay(retryMs, reconnect.signal);
      } finally {
        reconnect.abort();
        activeAttempt = undefined;
      }
      if (signal.aborted) return;
      if (generation !== attemptGeneration) continue;
      retryMs = Math.min(retryMs * 2, 5_000);
    }
  } finally {
    activeAttempt?.abort();
    snapshotAbort.abort();
    signal.removeEventListener("abort", onAbort);
    await snapshotTask;
  }
}
