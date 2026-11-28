import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { pageAppMenu } from "./page-app-window.js";

vi.mock("electron", () => ({}));

const input = {
  name: "Deals",
  win: { isAlwaysOnTop: () => false } as unknown as BrowserWindow,
  canOpenInRakazo: true,
  openInRakazo: () => undefined,
  reload: () => undefined,
  uninstall: () => undefined,
};

const shape = (items: MenuItemConstructorOptions[]): unknown[] =>
  items.map((item) =>
    Array.isArray(item.submenu) ? shape(item.submenu) : (item.role ?? item.type ?? item.label),
  );

describe("pageAppMenu", () => {
  it("leaves out what only macOS offers, without doubled separators", () => {
    const [appMenu, , , windowMenu] = shape(pageAppMenu(input, "win32"));
    expect(appMenu).toEqual([
      "about",
      "separator",
      "Open in Rakazo",
      "Uninstall…",
      "separator",
      "quit",
    ]);
    expect(windowMenu).toEqual(["checkbox", "separator", "minimize", "close"]);
  });

  it("keeps the whole menu on macOS", () => {
    expect(shape(pageAppMenu(input, "darwin"))[0]).toContain("hideOthers");
  });
});
