import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type RakazoDesktop, windowChromeKind } from "./desktop.js";

function desktop(platform: string): RakazoDesktop {
  const updateState = {
    phase: "unsupported" as const,
    currentVersion: "0.1.0",
    availableVersion: null,
    percent: null,
    message: "Automatic updates only run in an installed build.",
    checkedAt: null,
  };
  return {
    platform,
    window: {
      close: async () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    update: {
      state: async () => updateState,
      check: async () => updateState,
      download: async () => updateState,
      install: async () => updateState,
    },
  };
}

describe("window chrome", () => {
  it("does not paint fake traffic lights in the browser", () => {
    expect(windowChromeKind(undefined)).toBe("spacer");
  });

  it("leaves macOS traffic lights to Electron", () => {
    expect(windowChromeKind(desktop("darwin"))).toBe("darwin");
  });

  it("uses real window-control buttons on Windows and Linux", () => {
    expect(windowChromeKind(desktop("win32"))).toBe("controls");
    expect(windowChromeKind(desktop("linux"))).toBe("controls");
  });

  it("does not paint fake traffic lights into the browser shell or welcome page", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const shell = readFileSync(path.join(root, "Shell.tsx"), "utf8");
    const welcome = readFileSync(path.join(root, "Welcome.tsx"), "utf8");
    expect(shell).not.toContain("FF5F57");
    expect(welcome).not.toContain("FF5F57");
  });
});
