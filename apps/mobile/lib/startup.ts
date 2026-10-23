import { AppState } from "react-native";
import { reportMobileError } from "./monitoring";

type StartupStep = "server" | "appearance" | "streaming" | "images" | "inbox" | "language";

const STARTUP_TIMEOUT_MS = 20_000;
const pending = new Set<StartupStep>();
let started = false;
let finished = false;
let mounted = false;
let remaining = STARTUP_TIMEOUT_MS;
let activeSince: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let subscription: ReturnType<typeof AppState.addEventListener> | undefined;

function stopWatching(): void {
  clearTimeout(timer);
  timer = undefined;
  subscription?.remove();
  subscription = undefined;
}

/** Start before Router loads; count foreground time, not time spent away from the app. */
export function startMobileStartupWatchdog(): void {
  if (started) return;
  started = true;
  const resume = () => {
    if (activeSince !== undefined || finished) return;
    activeSince = Date.now();
    timer = setTimeout(() => {
      const steps = [...pending].sort().join(", ") || (mounted ? "render" : "router");
      reportMobileError(new Error(`Mobile startup stalled: ${steps}`), "mobile.startup");
      stopWatching();
    }, remaining);
  };
  subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") resume();
    else if (activeSince !== undefined) {
      remaining = Math.max(0, remaining - (Date.now() - activeSince));
      activeSince = undefined;
      clearTimeout(timer);
      timer = undefined;
    }
  });
  if (AppState.currentState !== "background" && AppState.currentState !== "inactive") resume();
}

export function markMobileStartupMounted(): void {
  mounted = true;
}

/** Fixed step names identify stalled native calls without recording account or screen content. */
export async function trackMobileStartup<T>(step: StartupStep, task: Promise<T>): Promise<T> {
  pending.add(step);
  try {
    return await task;
  } catch (error) {
    reportMobileError(error, "mobile.startup");
    throw error;
  } finally {
    pending.delete(step);
  }
}

/** A visible app or its error boundary ends startup monitoring. */
export function completeMobileStartup(): void {
  finished = true;
  stopWatching();
}
