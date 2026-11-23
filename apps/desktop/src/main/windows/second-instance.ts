import type { App, BrowserWindow } from "electron";
import { desktop } from "../desktop-state.js";
import { isSetupSaveInProgress, showSetupWindow } from "../setup/setup-window.js";
import type { ParsedDeepLink } from "./deep-link.js";
import {
  DEEP_LINK_SCHEME,
  extractDeepLinkFromArgv,
  navigateWindowToDeepLink,
  parseDeepLink,
} from "./deep-link.js";

/** The window a duplicate launch raises: setup while onboarding, main after. */
export function secondInstanceWindow(
  setupWindow: BrowserWindow | null,
  mainWindow: BrowserWindow | null,
): BrowserWindow | null {
  const win = setupWindow !== null && !setupWindow.isDestroyed() ? setupWindow : mainWindow;
  return win !== null && !win.isDestroyed() ? win : null;
}

export function revealSecondInstanceWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export type SecondInstanceResult =
  | { kind: "none" }
  | { kind: "focused" }
  | { kind: "navigated" }
  | { kind: "queued"; deepLink: ParsedDeepLink };

/**
 * Reveals the active window for a second-instance launch or OS deep-link activation,
 * and navigates the main window when a valid `rakazo://` link targets a ready server.
 * Never bypasses an open setup window.
 */
export function handleSecondInstance(input: {
  argv: readonly string[];
  setupWindow: BrowserWindow | null;
  mainWindow: BrowserWindow | null;
  currentTargetUrl: string | null;
  isOpening?: boolean;
  onRevealMainWindow?: () => void;
}): SecondInstanceResult {
  const win = secondInstanceWindow(input.setupWindow, input.mainWindow);
  if (win !== null) {
    if (win === input.mainWindow) input.onRevealMainWindow?.();
    revealSecondInstanceWindow(win);
  }

  const deepLink = extractDeepLinkFromArgv(input.argv);
  if (deepLink === null) return win === null ? { kind: "none" } : { kind: "focused" };

  const setupOpen = input.setupWindow !== null && !input.setupWindow.isDestroyed();
  if (setupOpen || input.isOpening === true) return { kind: "queued", deepLink };

  if (
    input.mainWindow !== null &&
    !input.mainWindow.isDestroyed() &&
    input.currentTargetUrl !== null
  ) {
    if (navigateWindowToDeepLink(input.mainWindow, deepLink, input.currentTargetUrl)) {
      return { kind: "navigated" };
    }
    return win === null ? { kind: "none" } : { kind: "focused" };
  }

  return { kind: "queued", deepLink };
}

/** Coordinates cold-start, second-instance, and macOS open-url deep links for the main process. */
export function createDeepLinkController(deps: {
  initialArgv: readonly string[];
  setupWindow: () => BrowserWindow | null;
  mainWindow: () => BrowserWindow | null;
  currentTargetUrl: () => string | null;
  isOpening?: () => boolean;
  onRevealMainWindow: () => void;
  reopenIfClosed: () => void;
}) {
  let pending: ParsedDeepLink | null = extractDeepLinkFromArgv(deps.initialArgv);

  function applyPending() {
    if (pending === null || deps.isOpening?.() === true) return;
    const setup = deps.setupWindow();
    if (setup !== null && !setup.isDestroyed()) return;
    const main = deps.mainWindow();
    const targetUrl = deps.currentTargetUrl();
    if (main === null || main.isDestroyed() || targetUrl === null) return;
    const deepLink = pending;
    pending = null;
    navigateWindowToDeepLink(main, deepLink, targetUrl);
  }

  function handleArgv(argv: readonly string[]): SecondInstanceResult {
    const result = handleSecondInstance({
      argv,
      setupWindow: deps.setupWindow(),
      mainWindow: deps.mainWindow(),
      currentTargetUrl: deps.currentTargetUrl(),
      isOpening: deps.isOpening?.(),
      onRevealMainWindow: deps.onRevealMainWindow,
    });
    if (result.kind === "queued") pending = result.deepLink;
    return result;
  }

  function handleOpenUrl(url: string): void {
    const deepLink = parseDeepLink(url);
    if (deepLink === null) return;
    const result = handleArgv([url]);
    if (result.kind === "queued") deps.reopenIfClosed();
  }

  return { applyPending, handleArgv, handleOpenUrl };
}

/** Wires single-instance, protocol registration, and macOS open-url events to desktop state. */
export function registerDeepLinkHandlers(
  electronApp: Pick<App, "isPackaged" | "isReady" | "on" | "setAsDefaultProtocolClient">,
  options: {
    initialArgv: readonly string[];
    isOpening: () => boolean;
    reopenTarget: (url: string) => void;
    showSetup?: () => void;
  },
) {
  const isBusy = () => options.isOpening() || isSetupSaveInProgress();
  const showSetup = options.showSetup ?? (() => showSetupWindow(desktop.setupError));
  const controller = createDeepLinkController({
    initialArgv: options.initialArgv,
    setupWindow: () => desktop.setupWindow,
    mainWindow: () => desktop.mainWindow,
    currentTargetUrl: () => desktop.currentTargetUrl,
    isOpening: isBusy,
    onRevealMainWindow: () => clearTimeout(desktop.warmWindowTimer),
    reopenIfClosed: () => {
      if (
        !electronApp.isReady() ||
        (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) ||
        (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()) ||
        isBusy()
      ) {
        return;
      }
      if (desktop.currentTargetUrl === null) showSetup();
      else options.reopenTarget(desktop.currentTargetUrl);
    },
  });
  electronApp.on("second-instance", (_event, argv) => controller.handleArgv(argv));
  electronApp.on("open-url", (event, url) => {
    event.preventDefault();
    controller.handleOpenUrl(url);
  });
  return {
    ...controller,
    registerProtocol() {
      // Only packaged builds register the OS protocol handler so dev/test runs do not clobber it.
      if (electronApp.isPackaged) {
        electronApp.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
      }
    },
  };
}
