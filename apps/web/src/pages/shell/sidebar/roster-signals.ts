import type { RosterSignals } from "../use-browser-notifications";

/**
 * Re-reads the roster on each server signal, including the one each (re)connection opens with,
 * and each return to the window. One during the page's own first load waits for it: a refresh
 * racing that load can redirect away from a chat it is still opening, or keep it from sending an
 * empty organization to onboarding, but the change it reports may postdate that load's read.
 */
export function createRosterSignals(refresh: () => void) {
  let loading = true;
  let missed = false;
  const signals: RosterSignals & { firstLoadSettled: () => void } = {
    changed() {
      if (loading) missed = true;
      else refresh();
    },
    firstLoadSettled() {
      if (!loading) return;
      loading = false;
      if (missed) refresh();
    },
  };
  return signals;
}
