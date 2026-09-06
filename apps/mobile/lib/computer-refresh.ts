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
  let timer: ReturnType<typeof setTimeout> | undefined;

  function invalidate() {
    revision += 1;
    clearTimeout(timer);
  }

  async function refresh({ screenAttempts = 1 } = {}) {
    if (!active) return;
    invalidate();
    const requestRevision = revision;
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
      if (current()) {
        timer = setTimeout(() => void refresh().catch(() => undefined), 2000);
      }
    }
  }

  return {
    refresh,
    isActive: () => active,
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
      invalidate();
    },
  };
}
