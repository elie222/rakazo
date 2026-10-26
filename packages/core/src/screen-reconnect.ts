/** How long a dropped screen waits before it loads again by itself. */
export const SCREEN_RECONNECT_DELAY_MS = 1_000;
/** A screen reconnects by itself at most once in this long; a later drop shows the error. */
export const SCREEN_RECONNECT_EVERY_MS = 30_000;
/**
 * Marks a screen request as a status-only probe. The web server answers it itself right after
 * the access check (204, 403 or 503) and never passes it to the computer, so its answer can't
 * be a redirect or anything the computer wrote.
 */
export const SCREEN_PROBE_PARAM = "rakazo_probe";

/** The status-only probe for a screen URL, absolute or a path. */
export function screenProbeUrl(url: string): string {
  const [base, hash] = url.split("#", 2) as [string, string | undefined];
  const joined = `${base}${base.includes("?") ? "&" : "?"}${SCREEN_PROBE_PARAM}=1`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

/** How often a dropped screen asks whether its page loads again, and for how long at most. */
export const SCREEN_RECONNECT_PROBE_MS = 1_000;
export const SCREEN_RECONNECT_WAIT_MS = 15_000;

/** The states a framed screen page reports about its connection. */
export const SCREEN_PAGE_STATES = [
  "loading",
  "connecting",
  "connected",
  "failed",
  "disconnected",
] as const;
export type ScreenPageState = (typeof SCREEN_PAGE_STATES)[number];

export type ScreenReconnect = {
  /** A new page load: only a drop after this load connected can reconnect by itself. */
  loaded(): void;
  /**
   * What to do about a reported state: load the screen again after the delay, show the
   * page's error, or nothing. Each reconnect goes through the screen's full authorization.
   */
  report(state: ScreenPageState, now?: number): "reconnect" | "error" | "none";
};

/** Reconnects a screen that dropped after connecting, once in a while, never one that never connected. */
export function createScreenReconnect(): ScreenReconnect {
  let connected = false;
  let lastReconnectAt: number | undefined;
  return {
    loaded() {
      connected = false;
    },
    report(state, now = Date.now()) {
      if (state === "connected") {
        connected = true;
        return "none";
      }
      if (state !== "disconnected" && state !== "failed") return "none";
      // A screen that had connected and then dropped may report it as a failure: the computer's
      // embed page marks an unclean disconnect, such as the proxy closing the socket, as an error.
      if (
        !connected ||
        (lastReconnectAt !== undefined && now - lastReconnectAt < SCREEN_RECONNECT_EVERY_MS)
      )
        return "error";
      connected = false;
      lastReconnectAt = now;
      return "reconnect";
    },
  };
}

/** One reconnect allowance per computer screen, so one bot's drop doesn't use another's. */
export function createScreenReconnects(): { for(key: string): ScreenReconnect } {
  const screens = new Map<string, ScreenReconnect>();
  return {
    for(key) {
      let screen = screens.get(key);
      if (!screen) {
        screen = createScreenReconnect();
        screens.set(key, screen);
      }
      return screen;
    },
  };
}

/** Answers that mean the screen isn't reachable yet rather than refused: wait them out. */
const SCREEN_NOT_YET = new Set<number | null>([null, 502, 503]);

/**
 * Before a dropped screen loads again, wait while its page can't be reached: the access check
 * couldn't reach the API (503), the screen's server is restarting (502), or the request didn't
 * get through at all (null). So the one reconnect isn't spent on an outage. `probe` returns
 * the page's HTTP status through the full access check, or null if it couldn't be asked. A
 * load, a refusal or any other answer ends the wait at once.
 */
export async function waitForScreenPage(
  probe: (signal: AbortSignal) => Promise<number | null>,
  options: {
    /** Aborted when the screen is closed or its link changes: the wait and its probe stop. */
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<"ready" | "refused" | "timeout" | "cancelled"> {
  const { signal } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  // The limit holds even when a probe never answers: it is raced against the time left.
  const deadline = now() + SCREEN_RECONNECT_WAIT_MS;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    const left = deadline - now();
    if (left <= 0) return "timeout";
    const attempt = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const status = await Promise.race([
      probe(attempt.signal).catch(() => null),
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), left);
      }),
      new Promise<"cancelled">((resolve) => {
        onAbort = () => resolve("cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (status === "expired" || status === "cancelled") {
      attempt.abort();
      return status === "expired" ? "timeout" : "cancelled";
    }
    if (signal?.aborted) return "cancelled";
    if (status !== null && status >= 200 && status < 300) return "ready";
    if (!SCREEN_NOT_YET.has(status)) return "refused";
    if (deadline - now() <= SCREEN_RECONNECT_PROBE_MS) return "timeout";
    await sleep(SCREEN_RECONNECT_PROBE_MS);
  }
}
