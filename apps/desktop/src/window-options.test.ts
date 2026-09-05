import { describe, expect, it } from "vitest";
import {
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
  developmentIconFile,
  setupWindowOptions,
  warmWindowTtlMs,
} from "./window-options.js";

describe("desktop window chrome", () => {
  it("uses native traffic lights on macOS", () => {
    const opts = browserWindowOptions("darwin");
    expect(opts.frame).toBe(true);
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 16, y: 16 });
  });

  it("is frameless on Windows and Linux so in-app buttons control the window", () => {
    for (const platform of ["win32", "linux"] as const) {
      const opts = browserWindowOptions(platform);
      expect(opts.frame).toBe(false);
      expect(opts.titleBarStyle).toBeUndefined();
    }
  });
});

describe("setup window chrome", () => {
  it("matches the app window chrome so first run looks like the product", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const setup = setupWindowOptions(platform);
      const app = browserWindowOptions(platform);
      expect(setup.frame).toBe(app.frame);
      expect(setup.titleBarStyle).toBe(app.titleBarStyle);
      expect(setup.backgroundColor).toBe(app.backgroundColor);
    }
  });

  it("opens smaller than the app window and stays usable when resized down", () => {
    const setup = setupWindowOptions("win32");
    expect(setup.width).toBeLessThan(browserWindowOptions("win32").width);
    expect(setup.minWidth).toBeLessThanOrEqual(setup.width);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });
});

describe("warm window lifetime", () => {
  it("accepts finite timer delays within Node's supported range", () => {
    expect(warmWindowTtlMs("0")).toBe(0);
    expect(warmWindowTtlMs("900000")).toBe(900_000);
    expect(warmWindowTtlMs("2147483647")).toBe(2_147_483_647);
  });

  it.each([undefined, "", " ", "nope", "-1", "Infinity", "2147483648"])(
    "uses the default for an invalid value (%s)",
    (value) => {
      expect(warmWindowTtlMs(value)).toBe(DEFAULT_WARM_WINDOW_TTL_MS);
    },
  );
});

describe("development icon", () => {
  it("uses the squircle asset on macOS because the dock draws the file unmasked", () => {
    expect(developmentIconFile("darwin")).toBe("icon-macos.png");
  });

  it("keeps the full-bleed icon elsewhere", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(developmentIconFile(platform)).toBe("icon.png");
    }
  });
});

describe("window background", () => {
  it("matches the shared dark background token so startup chrome does not flash", async () => {
    const { darkTokens } = await import("@rakazo/ui-tokens");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(browserWindowOptions(platform).backgroundColor).toBe(darkTokens.background);
      expect(setupWindowOptions(platform).backgroundColor).toBe(darkTokens.background);
    }
  });
});
