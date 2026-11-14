import type { RosterSignals } from "./use-browser-notifications";

/** The page's own first load is fresh for this long, so an opening signal inside it is skipped. */
export const OPENING_SIGNAL_GRACE_MS = 10_000;

/** Re-reads the roster on each server signal, including the one each reconnect opens with. */
export function createRosterSignals(refresh: () => void, now = Date.now): RosterSignals {
  let opened = false;
  const created = now();
  return {
    changed() {
      // The stream's opening signal arrives alongside the page's own first load, and a refresh
      // racing that load can redirect away from a chat it is still opening.
      const opening = !opened;
      opened = true;
      if (opening && now() - created < OPENING_SIGNAL_GRACE_MS) return;
      refresh();
    },
  };
}
