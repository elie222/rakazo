import type { ComputerStatus } from "@rakazo/contracts";
import { SCREEN_URL_RENEW_MS } from "./computer";

export { SCREEN_URL_RENEW_MS };

/**
 * Every `computer/screenUrl` call seals a fresh capability. Re-reading it on each poll would
 * rotate the URL every two seconds, so polls only read the screen when the status that shapes
 * it changed, when the held URL nears expiry, or after the viewer reported the current URL
 * unusable. The viewer keeps the connected source across incidental token rotation and applies
 * a URL fetched in the renew window so the live stream can outlive the original capability.
 */

function screenKey(status: ComputerStatus) {
  return [
    status.state,
    status.mode,
    status.kind,
    status.controlHolder,
    status.controlBotId,
    status.screenAvailable,
    status.screenWidth,
    status.screenHeight,
    status.homeRevision,
  ].join("|");
}

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
  // A completed read is cached even when it returned null (no screen for this status), so the
  // status alone decides when to ask again; the viewer clears the cache when a URL stops working.
  let screenLoaded = false;
  let screenStatus: string | undefined;
  let screenReadAt = 0;

  function screenStale(status: ComputerStatus, force: boolean) {
    return (
      force ||
      !screenLoaded ||
      screenStatus !== screenKey(status) ||
      Date.now() - screenReadAt >= SCREEN_URL_RENEW_MS
    );
  }

  function invalidate() {
    revision += 1;
    clearTimeout(timer);
  }

  function schedule() {
    clearTimeout(timer);
    if (!active || activeActions > 0 || pendingRevision === revision) return;
    timer = setTimeout(() => void refresh({ poll: true }).catch(() => undefined), 2000);
  }

  async function refresh({ screenAttempts = 1, poll = false } = {}) {
    if (!active) return;
    invalidate();
    const requestRevision = revision;
    pendingRevision = requestRevision;
    const current = () => active && requestRevision === revision;
    try {
      const status = await options.readStatus();
      if (!current()) return;
      options.onStatus(status);
      if (screenStale(status, !poll)) {
        try {
          const url = await options.readScreen(screenAttempts);
          if (!current()) return;
          screenLoaded = true;
          screenStatus = screenKey(status);
          screenReadAt = Date.now();
          options.onScreen(url);
        } catch {
          // Keep the last URL after a failed read; a successful null clears it.
        }
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
    refresh: (input?: { screenAttempts?: number }) => refresh(input),
    /** The viewer could not use the current URL: read a fresh one on the next poll. */
    invalidateScreen() {
      screenLoaded = false;
    },
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
      screenLoaded = false;
      screenStatus = undefined;
      invalidate();
    },
  };
}
