import { describe, expect, it, vi } from "vitest";
import { createTrayQuickAsk, QUICK_ASK_SHORTCUT } from "./tray-quick-ask.js";

function fakeImage() {
  const image = {
    isEmpty: () => false,
    resize: vi.fn(() => image),
    setTemplateImage: vi.fn(),
  };
  return image as never;
}

describe("createTrayQuickAsk", () => {
  it("shows unread count in the macOS menu bar tray and registers the quick-ask shortcut", () => {
    const setTitle = vi.fn();
    const setToolTip = vi.fn();
    const setContextMenu = vi.fn();
    const destroy = vi.fn();
    let shortcutHandler: (() => void) | undefined;
    const executeJavaScript = vi.fn(async () => true);
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { isDestroyed: () => false, executeJavaScript },
    };
    const focusApp = vi.fn();
    const unregisterShortcut = vi.fn();

    const controller = createTrayQuickAsk({
      platform: "darwin",
      iconPath: "/fake/icon.png",
      getWindow: () => win as never,
      onQuit: vi.fn(),
      focusApp,
      fileExists: () => true,
      loadImage: fakeImage,
      createTray: () => ({
        setTitle,
        setToolTip,
        setContextMenu,
        on: vi.fn(),
        destroy,
      }),
      buildMenu: (template) => template as never,
      registerShortcut: (accel, cb) => {
        expect(accel).toBe(QUICK_ASK_SHORTCUT);
        shortcutHandler = cb;
        return true;
      },
      unregisterShortcut,
    });

    expect(setTitle).toHaveBeenLastCalledWith("");
    expect(setToolTip).toHaveBeenLastCalledWith("Rakazo");

    controller.setUnreadCount(4);
    expect(setTitle).toHaveBeenLastCalledWith("4");
    expect(setToolTip).toHaveBeenLastCalledWith("Rakazo (4 unread)");

    controller.setUnreadCount(120);
    expect(setTitle).toHaveBeenLastCalledWith("99+");

    shortcutHandler?.();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(focusApp).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(executeJavaScript).toHaveBeenCalledOnce();

    controller.dispose();
    expect(unregisterShortcut).toHaveBeenCalledWith(QUICK_ASK_SHORTCUT);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
