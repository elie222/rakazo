import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { revealSecondInstanceWindow, secondInstanceWindow } from "./second-instance.js";

function fakeWindow(overrides: Partial<BrowserWindow> = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  } as unknown as BrowserWindow;
}

describe("second-instance window", () => {
  it("raises the setup window while onboarding is still open", () => {
    const setup = fakeWindow();
    const main = fakeWindow();
    expect(secondInstanceWindow(setup, main)).toBe(setup);
  });

  it("falls back to the main window once setup closed", () => {
    const setup = fakeWindow({ isDestroyed: () => true });
    const main = fakeWindow();
    expect(secondInstanceWindow(setup, main)).toBe(main);
    expect(secondInstanceWindow(null, main)).toBe(main);
  });

  it("returns nothing when every window is gone", () => {
    expect(secondInstanceWindow(null, null)).toBeNull();
    expect(secondInstanceWindow(null, fakeWindow({ isDestroyed: () => true }))).toBeNull();
  });

  it("restores a minimized window before showing and focusing it", () => {
    const win = fakeWindow({ isMinimized: () => true });
    revealSecondInstanceWindow(win);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("skips restore on a normal window", () => {
    const win = fakeWindow();
    revealSecondInstanceWindow(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });
});
