export interface RakazoDesktop {
  platform: string;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
}

/**
 * Where the Rakazo server lives relative to this desktop app. The app is a client
 * and never runs a server itself; `local` only means the server is on this machine.
 */
export type DesktopInstanceMode = "local" | "remote";

export interface DesktopSetup {
  mode: DesktopInstanceMode;
  serverUrl: string;
}

export interface DesktopSetupState {
  defaultLocalUrl: string;
  platform: string;
  saved: DesktopSetup | null;
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
