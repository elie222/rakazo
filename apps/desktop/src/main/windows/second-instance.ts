import type { App, BrowserWindow } from "electron";
import { desktop } from "../desktop-state.js";
import type { ParsedDeepLink } from "./deep-link.js";
import { extractDeepLinkFromArgv, navigateWindowToDeepLink, parseDeepLink } from "./deep-link.js";

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

/** Listen before Electron is ready so macOS can deliver cold-start links. */
export function registerDeepLinkHandlers(
  app: Pick<App, "on">,
  {
    initialArgv,
    isOpening,
    reopen,
  }: {
    initialArgv: readonly string[];
    isOpening: () => boolean;
    reopen: () => void;
  },
) {
  let pending = extractDeepLinkFromArgv(initialArgv);
  let startupReady = false;

  function applyPending() {
    if (pending === null || !startupReady || desktop.quitting || isOpening()) return;
    const win = secondInstanceWindow(desktop.setupWindow, desktop.mainWindow);
    if (win === null || win === desktop.setupWindow) return;
    if (navigateWindowToDeepLink(win, pending, desktop.currentTargetUrl)) pending = null;
  }

  function revealWindow() {
    const win = secondInstanceWindow(desktop.setupWindow, desktop.mainWindow);
    if (win === null) return false;
    if (win === desktop.mainWindow) clearTimeout(desktop.warmWindowTimer);
    revealSecondInstanceWindow(win);
    return true;
  }

  function receive(link: ParsedDeepLink | null) {
    if (desktop.quitting) return;
    const revealed = revealWindow();
    if (link === null) return;
    pending = link;
    if (!revealed && startupReady && !isOpening()) reopen();
    applyPending();
  }

  app.on("second-instance", (_event, argv) => receive(extractDeepLinkFromArgv(argv)));
  app.on("open-url", (event, url) => {
    const link = parseDeepLink(url);
    if (link === null) return;
    event.preventDefault();
    receive(link);
  });
  return {
    applyPending,
    registerActivate() {
      app.on("activate", () => {
        if (!desktop.quitting && !revealWindow() && !isOpening()) reopen();
      });
    },
    finishStartup() {
      startupReady = true;
      applyPending();
    },
  };
}
