import type { ComputerStatus } from "@rakazo/contracts";

/** One polling lifecycle per mounted computer target. Explicit refreshes supersede older reads. */
export function createComputerRefresh(options: {
  readStatus: () => Promise<ComputerStatus>;
  readScreen: (attempts: number) => Promise<string | null>;
  onStatus: (status: ComputerStatus) => void;
  onScreen: (url: string | null) => void;
  onReady: () => void;
  onInitialError: (error: unknown) => void;
}) {
  let active = false;
  let revision = 0;
  let lifetime = 0;
  let activeActions = 0;
  let pendingRevision: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function invalidate() {
    revision += 1;
    clearTimeout(timer);
  }

  function schedule() {
    clearTimeout(timer);
    if (!active || activeActions > 0 || pendingRevision === revision) return;
    timer = setTimeout(() => void refresh().catch(() => undefined), 2000);
  }

  async function refresh({ screenAttempts = 1 } = {}) {
    if (!active) return;
    invalidate();
    const requestRevision = revision;
    pendingRevision = requestRevision;
    const current = () => active && requestRevision === revision;
    try {
      const status = await options.readStatus();
      if (!current()) return;
      options.onStatus(status);
      try {
        const url = await options.readScreen(screenAttempts);
        if (!current()) return;
        options.onScreen(url);
      } catch {
        // Keep the last URL after a failed read; a successful null clears it.
      }
      if (!current()) return;
      options.onReady();
      return status;
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (pendingRevision === requestRevision) pendingRevision = undefined;
      if (current()) schedule();
    }
  }

  return {
    refresh,
    isActive: () => active,
    beginAction() {
      const started = active;
      const actionLifetime = lifetime;
      let finished = false;
      const isActive = () => started && active && actionLifetime === lifetime;
      if (started) {
        activeActions += 1;
        invalidate();
      }
      return {
        isActive,
        refresh: (input?: { screenAttempts?: number }) =>
          isActive() && !finished ? refresh(input) : Promise.resolve(undefined),
        finish() {
          if (finished) return;
          finished = true;
          if (!isActive()) return;
          activeActions -= 1;
          schedule();
        },
      };
    },
    start() {
      active = true;
      const initial = refresh();
      const initialRevision = revision;
      void initial.catch((error) => {
        if (active && revision === initialRevision) {
          options.onInitialError(error);
          options.onReady();
        }
      });
    },
    dispose() {
      active = false;
      lifetime += 1;
      activeActions = 0;
      invalidate();
    },
  };
}
