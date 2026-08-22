export interface RakazoDesktop {
  platform: string;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
}

/** How the desktop app was pointed at a Rakazo server during first-run setup. */
export type DesktopInstanceMode = "new" | "existing";

export interface DesktopSetup {
  mode: DesktopInstanceMode;
  serverUrl: string;
}

export interface DesktopSetupState {
  defaultLocalUrl: string;
  saved: DesktopSetup | null;
  /** Present when a saved or newly selected server could not be reopened. */
  error?: string;
}

export interface DesktopReachability {
  ok: boolean;
  /** HTTP status when the server answered, absent when it could not be reached. */
  status?: number;
  /** Normalized URL that was probed, absent when the input was not a usable URL. */
  url?: string;
  error?: string;
}

/**
 * Bridge exposed only to the first-run setup window. The app window keeps the
 * narrower `rakazoDesktop` bridge so a connected server can never re-point the app.
 */
export interface RakazoSetup {
  state: () => Promise<DesktopSetupState>;
  test: (url: string) => Promise<DesktopReachability>;
  save: (setup: DesktopSetup) => Promise<{ ok: boolean; error?: string }>;
  quit: () => Promise<void>;
}
