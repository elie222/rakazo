import type { ComputerStatus, ComputerUpdate } from "@rakazo/contracts";

export type ComputerRestartOptions = { discardUnsaved?: boolean };

import { isRetryableError, retryDelayMs } from "./retry-policy.js";

/** Shared polling and local presentation state; the server owns operation lifetime. */
export function createComputerUpdates(client: {
  list: () => Promise<ComputerUpdate[]>;
  start: (botId: string, options: ComputerRestartOptions) => Promise<ComputerUpdate>;
  dismiss: (id: string) => Promise<unknown>;
}) {
  let state: { updates: ComputerUpdate[]; openId: string | null } = { updates: [], openId: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let revision = 0;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const poll = async (epoch: number) => {
    const stamp = revision;
    let failure: unknown;
    try {
      const updates = await client.list();
      if (epoch !== generation || stamp !== revision) return;
      if (JSON.stringify(state.updates) === JSON.stringify(updates)) return;
      state = {
        updates,
        openId: updates.some((item) => item.id === state.openId) ? state.openId : null,
      };
      emit();
    } catch (error) {
      // Keep the last known operation through transient failures; a 401 or other refusal stops
      // polling until the next watch, since asking again cannot change the answer.
      failure = error;
    } finally {
      if (epoch === generation) {
        clearTimeout(timer);
        if (failure === undefined || isRetryableError(failure)) {
          const delay = retryDelayMs(failure, state.updates.length ? 1500 : 15000);
          timer = setTimeout(() => void poll(epoch), delay);
        }
      }
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
      void poll(epoch);
      return () => {
        generation++;
        clearTimeout(timer);
        state = { updates: [], openId: null };
      };
    },
    open(id: string | null) {
      state = { ...state, openId: id };
      emit();
    },
    async start(botId: string, options: ComputerRestartOptions = {}) {
      const epoch = generation;
      const update = await client.start(botId, options);
      if (epoch !== generation) return;
      revision++;
      state = {
        updates: [update, ...state.updates.filter((item) => item.id !== update.id)],
        openId: update.id,
      };
      emit();
      clearTimeout(timer);
      timer = setTimeout(() => void poll(epoch), 1500);
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

/** Whether to offer Restart; a restart in progress reports the computer as booting. */
export function canOfferComputerRestart(computer: Pick<ComputerStatus, "canRestart" | "state">) {
  return computer.canRestart && computer.state !== "booting";
}

/** A restart that failed while saving can only go ahead by giving up the unsaved work. */
export function computerRestartFailedSaving(update: ComputerUpdate): boolean {
  return update.status === "failed" && update.stage === "saving";
}

export function computerUpdateNeedsAttention(update: ComputerUpdate): boolean {
  return update.status === "failed" || update.status === "interrupted";
}
