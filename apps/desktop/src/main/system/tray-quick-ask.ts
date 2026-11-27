import { existsSync } from "node:fs";
import path from "node:path";
import { bestEffort } from "@rakazo/logging";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { app, globalShortcut, Menu, nativeImage, Tray } from "electron";
import { desktop } from "../desktop-state.js";

export const QUICK_ASK_SHORTCUT = "CommandOrControl+Shift+Space";

const FOCUS_COMPOSER_SCRIPT = `(() => {
  const input = document.querySelector('textarea[name="chat-message"]');
  if (input instanceof HTMLElement) {
    input.focus({ preventScroll: false });
    return true;
  }
  return false;
})()`;

export type TrayQuickAskController = {
  setUnreadCount: (count: number) => void;
  focusQuickAsk: () => void;
  dispose: () => void;
};

export type TrayQuickAskDeps = {
  platform: NodeJS.Platform;
  iconPath: string;
  getWindow: () => BrowserWindow | null;
  onShowSetup?: () => void;
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
    onShowSetup,
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

  function revealWindow(focusComposer: boolean) {
    if (disposed) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      onShowSetup?.();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    if (platform === "darwin") focusApp();
    win.focus();
    if (focusComposer && !win.webContents.isDestroyed()) {
      void bestEffort(
        "focus desktop composer",
        win.webContents.executeJavaScript(FOCUS_COMPOSER_SCRIPT),
      );
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
    try {
      let image = loadImage(iconPath);
      if (!image.isEmpty()) {
        image = image.resize({ width: 18, height: 18 });
        if (platform === "darwin") image.setTemplateImage(true);
        tray = createTray(image);
        tray.on("click", () => revealWindow(true));
        refreshTray();
      }
    } catch {
      tray = null;
    }
  }

  try {
    shortcutRegistered = registerShortcut(QUICK_ASK_SHORTCUT, () => revealWindow(true));
  } catch {
    shortcutRegistered = false;
  }

  return {
    setUnreadCount(count: number) {
      if (disposed) return;
      const next = typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
      if (next === unreadCount) return;
      unreadCount = next;
      refreshTray();
    },
    focusQuickAsk() {
      revealWindow(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (shortcutRegistered) {
        try {
          unregisterShortcut(QUICK_ASK_SHORTCUT);
        } catch {
          /* App teardown may already have released shortcuts. */
        }
        shortcutRegistered = false;
      }
      if (tray) {
        try {
          tray.destroy();
        } catch {
          /* Tray may already be destroyed during shutdown. */
        }
        tray = null;
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
export function startDesktopTrayQuickAsk(
  showSetup: () => void,
): TrayQuickAskController & { setBadgeCount: (count: number) => boolean } {
  const controller = createTrayQuickAsk({
    platform: process.platform,
    iconPath: resolveTrayIconPath(app.getAppPath(), process.resourcesPath, app.isPackaged),
    getWindow: () => desktop.mainWindow,
    onShowSetup: showSetup,
    onQuit: () => app.quit(),
  });
  app.on("will-quit", () => controller.dispose());
  return {
    ...controller,
    setBadgeCount: (count: number) => {
      controller.setUnreadCount(count);
      return app.setBadgeCount(count);
    },
  };
}
