import type { RosterSignals } from "./use-browser-notifications";

/** How often the poll looks; it re-reads the roster this often while the server's signals are down. */
export const ROSTER_POLL_MS = 10_000;
/** While signals are live, a missed one still heals within this long. */
export const ROSTER_SAFETY_POLL_MS = 60_000;

/** Re-reads the roster on each server signal, and by poll only while signals are down or quiet. */
export function createRosterSchedule(refresh: () => void, now = Date.now) {
  let live = false;
  let lastRead = Number.NEGATIVE_INFINITY;
  const signals: RosterSignals = {
    changed() {
      live = true;
      lastRead = now();
      refresh();
    },
    lost() {
      live = false;
    },
  };
  return {
    signals,
    poll() {
      if (live && now() - lastRead < ROSTER_SAFETY_POLL_MS) return;
      lastRead = now();
      refresh();
    },
  };
}
