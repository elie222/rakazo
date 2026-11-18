import type { BrowserWindow } from "electron";

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
