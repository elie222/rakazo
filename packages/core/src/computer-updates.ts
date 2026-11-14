import type { ComputerUpdate } from "@rakazo/contracts";
import { COMPUTER_UPDATE_STAGES } from "@rakazo/contracts";
import { isRetryableError, retryDelayMs } from "./retry-policy.js";

/** Without live signals (an older server, or while the app's live stream is closed) the list is polled. */
const POLL_MS = 15_000;
const POLL_IN_PROGRESS_MS = 1_500;
/**
 * The server signals every change, but a publish or its follower can fail without closing the
 * stream; these slow re-reads bound how long that leaves the list stale.
 */
const SIGNALLED_IN_PROGRESS_MS = 30_000;
const SIGNALLED_IDLE_MS = 5 * 60_000;

/**
 * Shared list and local presentation state; the server owns operation lifetime. The list is read
 * when watching starts and whenever the app's live stream signals a change (it signals once on
 * opening), and polled only while those signals are unavailable.
 */
export function createComputerUpdates(client: {
  list: () => Promise<ComputerUpdate[]>;
  start: (botId: string, action: "update" | "recover") => Promise<ComputerUpdate>;
  dismiss: (id: string) => Promise<unknown>;
  /** The list belongs to the selected Space, so switching starts over. */
  onSpaceChange?: (listener: () => void) => () => void;
}) {
  let state: { updates: ComputerUpdate[]; openId: string | null } = { updates: [], openId: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped by every watch and unwatch, so a late response from another watch is dropped.
  let generation = 0;
  let watching = false;
  // The server refused a read (signed out, or this build): nothing is asked again until rewatched.
  let refused = false;
  // After a failed read, signals wait for its scheduled retry, which honors Retry-After.
  let backoffUntil = 0;
  let revision = 0;
  let live = false;
  let fetching = false;
  let again = false;
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
            : SIGNALLED_IDLE_MS;
    if (failure !== undefined) backoffUntil = Date.now() + delay;
    timer = setTimeout(() => void refresh(), Math.max(delay, backoffUntil - Date.now()));
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
      backoffUntil = 0;
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
  const mayRead = () => watching && !refused && Date.now() >= backoffUntil;
  const refresh = async () => {
    if (!mayRead()) return;
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    try {
      do {
        again = false;
        await read();
      } while (again && mayRead());
    } finally {
      fetching = false;
    }
  };
  const begin = () => {
    generation++;
    watching = true;
    refused = false;
    backoffUntil = 0;
    void refresh();
    return () => {
      generation++;
      watching = false;
      clearTimeout(timer);
      state = { updates: [], openId: null };
    };
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
      let stop = begin();
      // Another Space has its own list, and nothing from the old one may land. Its signals may
      // still be the old Space's, so poll until the live stream signals again.
      const unfollowSpace = client.onSpaceChange?.(() => {
        stop();
        live = false;
        emit();
        stop = begin();
      });
      return () => {
        unfollowSpace?.();
        stop();
      };
    },
    /** The app's live stream opened or reported a change. */
    signalled() {
      live = true;
      void refresh();
    },
    /** The app's live stream closed; poll until it opens again. */
    signalsLost() {
      live = false;
      if (!fetching) schedule();
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
