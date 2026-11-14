import type { ComputerUpdate } from "@rakazo/contracts";
import { COMPUTER_UPDATE_STAGES } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";
import { isRetryableError, reconnectDelayMs, retryDelayMs } from "./retry-policy.js";

/** Without live signals (an older server, or while reconnecting) the list is polled instead. */
const POLL_MS = 15_000;
const POLL_IN_PROGRESS_MS = 1_500;
/** The server signals every status and stage change; this only covers one lost mid-update. */
const SIGNALLED_IN_PROGRESS_MS = 30_000;

/**
 * Shared list and local presentation state; the server owns operation lifetime. The list is read
 * when watching starts and again whenever the server signals a change, and polled only while
 * those signals are unavailable.
 */
export function createComputerUpdates(client: {
  list: () => Promise<ComputerUpdate[]>;
  start: (botId: string, action: "update" | "recover") => Promise<ComputerUpdate>;
  dismiss: (id: string) => Promise<unknown>;
  /** Follows the Space's change signals until the stream ends: once when it opens, then per change. */
  follow: (onSignal: () => void, signal: AbortSignal) => Promise<void>;
  /** The list and its signals belong to the selected Space, so switching reopens both. */
  onSpaceChange?: (listener: () => void) => () => void;
}) {
  let state: { updates: ComputerUpdate[]; openId: string | null } = { updates: [], openId: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped by every watch and unwatch, so a late response or stream from another watch is dropped.
  let generation = 0;
  let watching = false;
  // The server refused a read (signed out, or this build): nothing is asked again until rewatched.
  let refused = false;
  let revision = 0;
  let live = false;
  let fetching = false;
  let again = false;
  let stream: AbortController | undefined;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const inProgress = () =>
    state.updates.some((item) => item.status === "queued" || item.status === "running");
  const schedule = (failure?: unknown) => {
    clearTimeout(timer);
    timer = undefined;
    if (!watching || refused) return;
    const base = inProgress() ? POLL_IN_PROGRESS_MS : POLL_MS;
    const delay =
      failure !== undefined
        ? retryDelayMs(failure, base)
        : !live
          ? base
          : inProgress()
            ? SIGNALLED_IN_PROGRESS_MS
            : undefined;
    if (delay !== undefined) timer = setTimeout(() => void refresh(), delay);
  };
  const read = async () => {
    const epoch = generation;
    const stamp = revision;
    clearTimeout(timer);
    let failure: unknown;
    try {
      const updates = await client.list();
      if (epoch !== generation) return;
      // A start or dismiss landed while this was in flight; its result is newer than this read.
      if (stamp !== revision) {
        again = true;
        return;
      }
      if (JSON.stringify(state.updates) !== JSON.stringify(updates)) {
        state = {
          updates,
          openId: updates.some((item) => item.id === state.openId) ? state.openId : null,
        };
        emit();
      }
    } catch (error) {
      if (epoch !== generation) return;
      // Keep the last known operation through transient failures; a 401 or other refusal stops
      // reading until the next watch, since asking again cannot change the answer.
      if (!isRetryableError(error)) {
        refused = true;
        clearTimeout(timer);
        return;
      }
      failure = error;
    }
    schedule(failure);
  };
  /** One read at a time; signals that arrive meanwhile become one more read. */
  const refresh = async () => {
    if (!watching || refused) return;
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    try {
      do {
        again = false;
        await read();
      } while (again && watching);
    } finally {
      fetching = false;
    }
  };
  const follow = async (epoch: number, stopped: AbortSignal) => {
    let retry = 1_000;
    while (epoch === generation && !refused) {
      const controller = new AbortController();
      stream = controller;
      let failure: unknown;
      let opened = false;
      try {
        await client.follow(() => {
          if (epoch !== generation || controller.signal.aborted) return;
          opened = true;
          live = true;
          void refresh();
        }, controller.signal);
      } catch (error) {
        failure = error;
      }
      if (epoch !== generation) return;
      stream = undefined;
      live = false;
      // Reopened for another Space, whose first signal reads its list.
      if (controller.signal.aborted) continue;
      schedule();
      // An older server without signals, or a refused session: polling carries on, or stops on
      // its own refusal.
      if (failure !== undefined && !isRetryableError(failure)) return;
      if (opened) retry = 1_000;
      await abortableDelay(
        opened ? reconnectDelayMs(failure) : retryDelayMs(failure, retry),
        stopped,
      );
      retry = Math.min(retry * 2, 30_000);
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch() {
      const epoch = ++generation;
      watching = true;
      refused = false;
      live = false;
      const stopped = new AbortController();
      const unfollowSpace = client.onSpaceChange?.(() => {
        if (stream) stream.abort();
        else void refresh();
      });
      void refresh();
      void follow(epoch, stopped.signal);
      return () => {
        generation++;
        watching = false;
        live = false;
        clearTimeout(timer);
        stopped.abort();
        stream?.abort();
        stream = undefined;
        unfollowSpace?.();
        state = { updates: [], openId: null };
      };
    },
    open(id: string | null) {
      state = { ...state, openId: id };
      emit();
    },
    async start(botId: string, action: "update" | "recover" = "update") {
      const epoch = generation;
      const update = await client.start(botId, action);
      if (epoch !== generation) return;
      revision++;
      state = {
        updates: [update, ...state.updates.filter((item) => item.id !== update.id)],
        openId: update.id,
      };
      emit();
      schedule();
    },
    async dismiss(id: string) {
      const epoch = generation;
      await client.dismiss(id);
      if (epoch !== generation) return;
      revision++;
      state = {
        updates: state.updates.filter((item) => item.id !== id),
        openId: state.openId === id ? null : state.openId,
      };
      emit();
    },
  };
}

export function computerUpdateStages(
  action: ComputerUpdate["action"],
): readonly ComputerUpdate["stage"][] {
  return action === "recover"
    ? COMPUTER_UPDATE_STAGES.filter((stage) => stage !== "saving")
    : COMPUTER_UPDATE_STAGES;
}

export function computerUpdateNeedsAttention(update: ComputerUpdate): boolean {
  return update.status === "failed" || update.status === "interrupted";
}
