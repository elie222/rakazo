import { existsSync } from "node:fs";
import path from "node:path";
import { bestEffort } from "@rakazo/logging";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { app, globalShortcut, Menu, nativeImage, Tray } from "electron";
import { desktop } from "../desktop-state.js";

export const QUICK_ASK_SHORTCUT = "CommandOrControl+Shift+Space";

const FOCUS_COMPOSER_WAIT_SCRIPT = `(() => {
  const find = () => document.querySelector('textarea[name="chat-message"]');
  const immediate = find();
  if (immediate instanceof HTMLElement) {
    immediate.focus({ preventScroll: false });
    return true;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(ok);
    };
    const observer = new MutationObserver(() => {
      const el = find();
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: false });
        finish(true);
      }
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), 2500);
  });
})()`;

const pendingFocusWindows = new WeakSet<BrowserWindow>();

export type TrayQuickAskController = {
  setUnreadCount: (count: number) => void;
  dispose: () => void;
};

/** Focuses the chat composer in a desktop window, deferring past navigation and mount. */
export function focusDesktopComposer(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const runFocus = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    void bestEffort(
      "focus desktop composer",
      win.webContents.executeJavaScript(FOCUS_COMPOSER_WAIT_SCRIPT),
    );
  };
  if (win.webContents.isLoading()) {
    if (!pendingFocusWindows.has(win)) {
      pendingFocusWindows.add(win);
      win.webContents.once("did-finish-load", () => {
        pendingFocusWindows.delete(win);
        runFocus();
      });
    }
    return;
  }
  runFocus();
}

export type TrayQuickAskDeps = {
  platform: NodeJS.Platform;
  iconPath: string;
  getWindow: () => BrowserWindow | null;
  getSetupWindow?: () => BrowserWindow | null;
  onReopen?: (focusComposer: boolean) => void;
  onQuit: () => void;
  focusApp?: () => void;
  createTray?: (
    image: Electron.NativeImage,
  ) => Pick<Tray, "setToolTip" | "setTitle" | "setContextMenu" | "on" | "destroy">;
  buildMenu?: (template: MenuItemConstructorOptions[]) => Electron.Menu;
  loadImage?: (filePath: string) => Electron.NativeImage;
  registerShortcut?: (accelerator: string, callback: () => void) => boolean;
  unregisterShortcut?: (accelerator: string) => void;
  fileExists?: (filePath: string) => boolean;
};

/**
 * Installs a desktop menu-bar / system tray icon showing unread counts and a global quick-ask
 * shortcut that surfaces the Rakazo window and focuses the message composer.
 */
export function createTrayQuickAsk(deps: TrayQuickAskDeps): TrayQuickAskController {
  const {
    platform,
    iconPath,
    getWindow,
    getSetupWindow = () => null,
    onReopen,
    onQuit,
    focusApp = () => app.focus({ steal: true }),
    createTray = (image) => new Tray(image),
    buildMenu = (template) => Menu.buildFromTemplate(template),
    loadImage = (filePath) => nativeImage.createFromPath(filePath),
    registerShortcut = (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregisterShortcut = (accelerator) => globalShortcut.unregister(accelerator),
    fileExists = existsSync,
  } = deps;

  let unreadCount = 0;
  let disposed = false;
  let shortcutRegistered = false;
  let tray: ReturnType<typeof createTray> | null = null;

  function surfaceWindow(win: BrowserWindow) {
    if (win.isMinimized()) win.restore();
    win.show();
    if (platform === "darwin") focusApp();
    win.focus();
  }

  function revealWindow(focusComposer: boolean) {
    if (disposed) return;
    const setupWin = getSetupWindow();
    if (setupWin && !setupWin.isDestroyed()) {
      surfaceWindow(setupWin);
      return;
    }
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      onReopen?.(focusComposer);
      return;
    }
    surfaceWindow(win);
    if (focusComposer) {
      focusDesktopComposer(win);
    }
  }

  function refreshTray() {
    if (!tray || disposed) return;
    const clamped = Math.max(0, Math.min(9999, Math.trunc(unreadCount)));
    const badgeText = clamped > 99 ? "99+" : clamped > 0 ? String(clamped) : "";
    if (platform === "darwin") tray.setTitle(badgeText);
    tray.setToolTip(clamped > 0 ? `Rakazo (${clamped} unread)` : "Rakazo");
    const menuItems: MenuItemConstructorOptions[] = [];
    if (clamped > 0) {
      menuItems.push({
        label: clamped === 1 ? "1 unread chat" : `${clamped} unread chats`,
        enabled: false,
      });
      menuItems.push({ type: "separator" });
    }
    menuItems.push(
      {
        label: "Quick ask",
        accelerator: QUICK_ASK_SHORTCUT,
        click: () => revealWindow(true),
      },
      {
        label: "Open Rakazo",
        click: () => revealWindow(false),
      },
      { type: "separator" },
      {
        label: "Quit Rakazo",
        click: () => onQuit(),
      },
    );
    tray.setContextMenu(buildMenu(menuItems));
  }

  if (fileExists(iconPath)) {
    void bestEffort(
      "create desktop tray",
      Promise.resolve().then(() => {
        let image = loadImage(iconPath);
        if (image.isEmpty()) return;
        image = image.resize({ width: 18, height: 18 });
        tray = createTray(image);
        tray.on("click", () => revealWindow(true));
        refreshTray();
      }),
    );
  }

  void bestEffort(
    "register quick-ask shortcut",
    Promise.resolve().then(() => {
      shortcutRegistered = registerShortcut(QUICK_ASK_SHORTCUT, () => revealWindow(true));
    }),
  );

  return {
    setUnreadCount(count: number) {
      if (disposed) return;
      const next = typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
      if (next === unreadCount) return;
      unreadCount = next;
      refreshTray();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (shortcutRegistered) {
        shortcutRegistered = false;
        void bestEffort(
          "unregister quick-ask shortcut",
          Promise.resolve().then(() => unregisterShortcut(QUICK_ASK_SHORTCUT)),
        );
      }
      if (tray) {
        const activeTray = tray;
        tray = null;
        void bestEffort(
          "destroy desktop tray",
          Promise.resolve().then(() => activeTray.destroy()),
        );
      }
    },
  };
}

/** Resolves the shipped tray icon file for packaged and development desktop launches. */
export function resolveTrayIconPath(appPath: string, resourcesPath: string, isPackaged: boolean) {
  const candidates = isPackaged
    ? [
        path.join(resourcesPath, "app-icons", "default.png"),
        path.join(appPath, "assets", "icon.png"),
      ]
    : [path.join(appPath, "assets", "icon.png")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Wires the desktop tray and global quick-ask shortcut to the live app window and quits cleanly. */
export function startDesktopTrayQuickAsk(reopenWindow: (focusComposer: boolean) => void): {
  setBadgeCount: (count: number) => boolean;
} {
  const controller = createTrayQuickAsk({
    platform: process.platform,
    iconPath: resolveTrayIconPath(app.getAppPath(), process.resourcesPath, app.isPackaged),
    getWindow: () => desktop.mainWindow,
    getSetupWindow: () => desktop.setupWindow,
    onReopen: reopenWindow,
    onQuit: () => app.quit(),
  });
  app.on("will-quit", () => controller.dispose());
  return {
    setBadgeCount: (count: number) => {
      controller.setUnreadCount(count);
      return app.setBadgeCount(count);
    },
  };
}
