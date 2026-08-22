import type { DesktopUpdateState } from "@rakazo/contracts";

/** Long enough that a cold launch is never competing with the update feed for bandwidth. */
export const LAUNCH_CHECK_DELAY_MS = 8_000;
/** A connected server drives the renderer, so a manual check cannot become a request loop. */
export const MIN_CHECK_INTERVAL_MS = 60_000;

export interface UpdaterEnvironment {
  packaged: boolean;
  version: string;
  disabled?: boolean;
}

export function updaterSupport(env: UpdaterEnvironment): { supported: boolean; reason: string } {
  if (env.disabled === true) {
    return { supported: false, reason: "Automatic updates are turned off for this install." };
  }
  if (!env.packaged) {
    return { supported: false, reason: "Automatic updates only run in an installed build." };
  }
  return { supported: true, reason: "" };
}

export function initialUpdateState(env: UpdaterEnvironment): DesktopUpdateState {
  const support = updaterSupport(env);
  return {
    phase: support.supported ? "idle" : "unsupported",
    currentVersion: env.version,
    availableVersion: null,
    percent: null,
    message: support.supported ? null : support.reason,
    checkedAt: null,
  };
}

export type UpdaterFailure =
  | { kind: "no-releases"; message: string }
  | { kind: "offline"; message: null }
  | { kind: "signature"; message: string }
  | { kind: "other"; message: string };

const NO_RELEASES = [
  "404",
  "no published versions",
  "cannot find latest",
  "latest.yml",
  "latest-mac.yml",
  "unable to find latest version",
];
const OFFLINE = [
  "enotfound",
  "econnrefused",
  "econnreset",
  "etimedout",
  "eai_again",
  "enetunreach",
  "net::err_",
  "getaddrinfo",
];
const SIGNATURE = ["code sign", "signature", "not signed", "notariz"];

/**
 * A fork usually has no published releases and a laptop is often offline, so neither is worth
 * telling the user about more than once. Signing problems are the opposite: they always need a fix.
 */
export function classifyUpdaterFailure(error: unknown): UpdaterFailure {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  const haystack = text.toLowerCase();
  if (NO_RELEASES.some((needle) => haystack.includes(needle))) {
    return {
      kind: "no-releases",
      message: "No desktop releases are published for this build yet.",
    };
  }
  if (OFFLINE.some((needle) => haystack.includes(needle))) {
    return { kind: "offline", message: null };
  }
  if (SIGNATURE.some((needle) => haystack.includes(needle))) {
    return {
      kind: "signature",
      message: `This update could not be verified: ${text}. Reinstall Rakazo from a trusted download.`,
    };
  }
  return { kind: "other", message: text === "" ? "The update check failed." : text };
}

export type UpdaterEvent =
  | { type: "check-start" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "download-start" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "failed"; error: unknown; userInitiated: boolean };

export function reduceUpdateState(
  state: DesktopUpdateState,
  event: UpdaterEvent,
  now: string,
): DesktopUpdateState {
  if (state.phase === "unsupported") return state;
  switch (event.type) {
    case "check-start":
      return { ...state, phase: "checking", percent: null, message: null };
    case "available":
      return {
        ...state,
        phase: "available",
        availableVersion: event.version,
        percent: null,
        message: null,
        checkedAt: now,
      };
    case "not-available":
      return {
        ...state,
        phase: "idle",
        availableVersion: null,
        percent: null,
        message: null,
        checkedAt: now,
      };
    case "download-start":
      return { ...state, phase: "downloading", percent: 0, message: null };
    case "progress":
      return {
        ...state,
        phase: "downloading",
        percent: Math.max(0, Math.min(100, Math.round(event.percent))),
      };
    case "downloaded":
      return {
        ...state,
        phase: "ready",
        availableVersion: event.version,
        percent: 100,
        message: "Restart Rakazo to finish the update.",
      };
    case "failed": {
      const failure = classifyUpdaterFailure(event.error);
      if (failure.kind === "no-releases") {
        return {
          ...state,
          phase: "unsupported",
          percent: null,
          message: failure.message,
          checkedAt: now,
        };
      }
      if (failure.kind === "offline") {
        return {
          ...state,
          phase: "idle",
          percent: null,
          message: event.userInitiated ? "Could not reach the update server." : null,
          checkedAt: now,
        };
      }
      return { ...state, phase: "error", percent: null, message: failure.message, checkedAt: now };
    }
  }
}

/** Guards both the launch check and anything the renderer asks for. */
export function shouldCheck(state: DesktopUpdateState, now: number, lastCheck: number): boolean {
  if (state.phase === "unsupported") return false;
  if (state.phase === "checking" || state.phase === "downloading") return false;
  return now - lastCheck >= MIN_CHECK_INTERVAL_MS || lastCheck === 0;
}
