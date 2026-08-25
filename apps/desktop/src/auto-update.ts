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
  "404 not found",
  "no published versions",
  "cannot find latest.yml",
  "cannot find latest-mac.yml",
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

/** Error text can contain local paths or URLs, so renderer-visible messages stay generic. */
export function classifyUpdaterFailure(error: unknown): UpdaterFailure {
  const text = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  if (NO_RELEASES.some((needle) => text.includes(needle))) {
    return {
      kind: "no-releases",
      message: "No desktop releases are published for this build yet.",
    };
  }
  if (OFFLINE.some((needle) => text.includes(needle))) {
    return { kind: "offline", message: null };
  }
  if (SIGNATURE.some((needle) => text.includes(needle))) {
    return {
      kind: "signature",
      message: "This update could not be verified. Reinstall Rakazo from a trusted download.",
    };
  }
  return {
    kind: "other",
    message: "The update could not be completed. Try again later.",
  };
}

export type UpdaterEvent =
  | { type: "check-start" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "download-start" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "failed"; error: unknown; userInitiated: boolean; installFailed?: boolean };

export function reduceUpdateState(
  state: DesktopUpdateState,
  event: UpdaterEvent,
  now: string,
): DesktopUpdateState {
  if (state.phase === "unsupported") return state;
  switch (event.type) {
    case "check-start":
      // A verified download in flight must not be reset by a stray updater event.
      if (state.phase === "available" || state.phase === "downloading" || state.phase === "ready") {
        return state;
      }
      return { ...state, phase: "checking", percent: null, message: null };
    case "available":
      if (state.phase === "downloading" || state.phase === "ready") return state;
      return {
        ...state,
        phase: "available",
        availableVersion: event.version,
        percent: null,
        message: null,
        checkedAt: now,
      };
    case "not-available":
      if (state.phase === "downloading" || state.phase === "ready") return state;
      return {
        ...state,
        phase: "idle",
        availableVersion: null,
        percent: null,
        message: null,
        checkedAt: now,
      };
    case "download-start":
      if (state.phase === "ready") return state;
      return { ...state, phase: "downloading", percent: 0, message: null };
    case "progress":
      // Only advance while a download is expected; late progress after error/idle
      // must not force the UI back into downloading.
      if (state.phase !== "available" && state.phase !== "downloading") return state;
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
      // electron-updater can emit late errors after a verified download; keep installable
      // state unless this failure came from quitAndInstall itself.
      if (state.phase === "ready" && event.installFailed !== true) return state;
      const failure = classifyUpdaterFailure(event.error);
      if (failure.kind === "no-releases" && state.phase === "checking") {
        return {
          ...state,
          phase: "unsupported",
          availableVersion: null,
          percent: null,
          message: failure.message,
          checkedAt: now,
        };
      }
      if (failure.kind === "no-releases") {
        return {
          ...state,
          phase: "error",
          percent: null,
          message: "The update could not be completed. Try again later.",
          checkedAt: now,
        };
      }
      if (failure.kind === "offline" && event.installFailed !== true) {
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

export interface ShouldCheckOptions {
  /** Manual checks may retry after a prior empty feed; unpackaged installs stay frozen. */
  userInitiated?: boolean;
  environmentSupportsUpdates?: boolean;
}

/** Checks never replace an offer that is already downloading or ready to install. */
export function shouldCheck(
  state: DesktopUpdateState,
  now: number,
  lastCheck: number,
  options: ShouldCheckOptions = {},
): boolean {
  if (state.phase === "unsupported") {
    return options.userInitiated === true && options.environmentSupportsUpdates === true;
  }
  if (state.phase !== "idle" && state.phase !== "error") return false;
  return now - lastCheck >= MIN_CHECK_INTERVAL_MS || lastCheck === 0;
}

export interface ElectronAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableWebInstaller: boolean;
  on: (event: string, listener: (payload: unknown) => void) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
}

interface UpdateClock {
  now: () => number;
  iso: () => string;
}

const systemClock: UpdateClock = {
  now: Date.now,
  iso: () => new Date().toISOString(),
};

function versionFrom(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("version" in payload)) return null;
  return typeof payload.version === "string" && payload.version.trim() !== ""
    ? payload.version
    : null;
}

function percentFrom(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || !("percent" in payload)) return null;
  return typeof payload.percent === "number" && Number.isFinite(payload.percent)
    ? payload.percent
    : null;
}

/** Owns updater configuration and serializes renderer and launch-time operations. */
export class DesktopUpdateController {
  private current: DesktopUpdateState;
  private lastCheck = 0;
  private updaterPromise: Promise<ElectronAutoUpdater | null> | null = null;
  private checkPromise: Promise<DesktopUpdateState> | null = null;
  private downloadPromise: Promise<DesktopUpdateState> | null = null;
  private checkWasRequested = false;
  private installStarted = false;

  constructor(
    private readonly environment: UpdaterEnvironment,
    private readonly loadUpdater: () => Promise<ElectronAutoUpdater>,
    private readonly clock: UpdateClock = systemClock,
  ) {
    this.current = initialUpdateState(environment);
  }

  state() {
    return this.current;
  }

  private push(event: UpdaterEvent) {
    this.current = reduceUpdateState(this.current, event, this.clock.iso());
    if (event.type === "not-available" || event.type === "downloaded" || event.type === "failed") {
      this.checkWasRequested = false;
    }
  }

  private async updater(): Promise<ElectronAutoUpdater | null> {
    if (!updaterSupport(this.environment).supported) return null;
    if (this.updaterPromise !== null) return this.updaterPromise;

    const loading = this.loadUpdater()
      .then((updater) => {
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = true;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableWebInstaller = true;
        updater.on("checking-for-update", () => this.push({ type: "check-start" }));
        updater.on("update-available", (payload) => {
          const version = versionFrom(payload);
          if (version === null) {
            this.push({
              type: "failed",
              error: new Error("The update feed did not include a version."),
              userInitiated: this.checkWasRequested,
            });
            return;
          }
          this.push({ type: "available", version });
          void this.download();
        });
        updater.on("update-not-available", () => this.push({ type: "not-available" }));
        updater.on("download-progress", (payload) => {
          const percent = percentFrom(payload);
          if (percent !== null) this.push({ type: "progress", percent });
        });
        updater.on("update-downloaded", (payload) => {
          const version = versionFrom(payload);
          if (version !== null) {
            this.push({ type: "downloaded", version });
          } else {
            this.push({
              type: "failed",
              error: new Error("The downloaded update did not include a version."),
              userInitiated: this.checkWasRequested,
            });
          }
        });
        updater.on("error", (error) =>
          this.push({ type: "failed", error, userInitiated: this.checkWasRequested }),
        );
        return updater;
      })
      .catch((error: unknown) => {
        this.push({ type: "failed", error, userInitiated: this.checkWasRequested });
        if (this.updaterPromise === loading) this.updaterPromise = null;
        return null;
      });
    this.updaterPromise = loading;
    return loading;
  }

  check(userInitiated: boolean) {
    if (userInitiated) this.checkWasRequested = true;
    if (this.checkPromise !== null) return this.checkPromise;
    const checking = this.runCheck().finally(() => {
      if (this.checkPromise === checking) this.checkPromise = null;
    });
    this.checkPromise = checking;
    return checking;
  }

  private async runCheck() {
    const checkOptions = {
      userInitiated: this.checkWasRequested,
      environmentSupportsUpdates: updaterSupport(this.environment).supported,
    };
    let now = this.clock.now();
    if (!shouldCheck(this.current, now, this.lastCheck, checkOptions)) return this.current;
    // A prior empty feed freezes automatic checks; a manual retry clears that freeze.
    if (this.current.phase === "unsupported" && checkOptions.environmentSupportsUpdates) {
      this.current = {
        ...this.current,
        phase: "idle",
        availableVersion: null,
        percent: null,
        message: null,
      };
      // Do not make the user wait out the launch-check interval to retry.
      this.lastCheck = 0;
    }
    const updater = await this.updater();
    if (updater === null) return this.current;
    now = this.clock.now();
    if (!shouldCheck(this.current, now, this.lastCheck, checkOptions)) return this.current;
    this.lastCheck = now;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      if (this.current.phase === "idle" || this.current.phase === "checking") {
        this.push({ type: "failed", error, userInitiated: this.checkWasRequested });
      }
    }
    return this.current;
  }

  download() {
    if (this.downloadPromise !== null) return this.downloadPromise;
    const downloading = this.runDownload().finally(() => {
      if (this.downloadPromise === downloading) this.downloadPromise = null;
    });
    this.downloadPromise = downloading;
    return downloading;
  }

  private async runDownload() {
    if (this.current.phase !== "available") return this.current;
    const updater = await this.updater();
    if (updater === null || this.current.phase !== "available") return this.current;
    this.push({ type: "download-start" });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      if (this.state().phase === "downloading") {
        this.push({ type: "failed", error, userInitiated: this.checkWasRequested });
      }
    }
    return this.current;
  }

  async install() {
    if (this.installStarted || this.current.phase !== "ready") return this.current;
    const updater = await this.updater();
    if (updater === null || this.installStarted || this.current.phase !== "ready") {
      return this.current;
    }
    this.installStarted = true;
    try {
      updater.quitAndInstall();
    } catch (error) {
      this.installStarted = false;
      this.push({ type: "failed", error, userInitiated: true, installFailed: true });
    }
    return this.current;
  }
}
