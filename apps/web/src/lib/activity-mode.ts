/** Persisted Codex-style recency mode for the sidebar Now/Recent list. Default off. */
export const ACTIVITY_MODE_KEY = "rakazo.activity-mode";

export function readActivityMode(): boolean {
  try {
    return window.localStorage.getItem(ACTIVITY_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeActivityMode(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(ACTIVITY_MODE_KEY, "1");
    else window.localStorage.removeItem(ACTIVITY_MODE_KEY);
  } catch {
    // Private mode / blocked storage — keep in-memory only.
  }
}
