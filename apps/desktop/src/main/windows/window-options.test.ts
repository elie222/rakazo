import { describe, expect, it } from "vitest";
import {
  APP_WINDOW_MIN_HEIGHT,
  APP_WINDOW_MIN_WIDTH,
  appWindowBackground,
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
  developmentIconFile,
  parseSavedBackground,
  parseSavedWindowBounds,
  restorableWindowBounds,
  setupWindowOptions,
  warmWindowTtlMs,
} from "./window-options.js";

const laptop = { width: 1440, height: 875 };

describe("desktop window chrome", () => {
  it("uses native traffic lights on macOS", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.frame).toBe(true);
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 16, y: 19 });
  });

  it("uses the native Windows frame in the app and setup windows", () => {
    for (const opts of [
      browserWindowOptions("win32", laptop),
      setupWindowOptions("win32", laptop),
    ]) {
      expect(opts.frame).toBe(true);
      expect(opts.titleBarStyle).toBeUndefined();
      expect(opts.trafficLightPosition).toBeUndefined();
    }
  });

  it("keeps Linux frameless so its in-app buttons control the window", () => {
    const opts = browserWindowOptions("linux", laptop);
    expect(opts.frame).toBe(false);
    expect(opts.titleBarStyle).toBeUndefined();
  });
});

describe("app window size", () => {
  it("opens smaller than a laptop screen so it reads as a window, not full screen", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.width).toBeLessThan(laptop.width);
    expect(opts.height).toBeLessThan(laptop.height);
  });

  it("fits inside a small scaled screen", () => {
    const small = { width: 1280, height: 672 };
    for (const opts of [browserWindowOptions("win32", small), setupWindowOptions("win32", small)]) {
      expect(opts.width).toBeLessThanOrEqual(small.width);
      expect(opts.height).toBeLessThanOrEqual(small.height);
    }
    const setup = setupWindowOptions("win32", small);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });

  it("cannot be resized below the phone layout, and never past a small screen", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.minWidth).toBe(APP_WINDOW_MIN_WIDTH);
    expect(opts.minHeight).toBe(APP_WINDOW_MIN_HEIGHT);
    expect(opts.minWidth).toBeLessThanOrEqual(opts.width);
    expect(opts.minHeight).toBeLessThanOrEqual(opts.height);
    const tiny = browserWindowOptions("darwin", { width: 300, height: 400 });
    expect(tiny.minWidth).toBe(300);
    expect(tiny.minHeight).toBe(400);
  });

  it("caps its size on large displays", () => {
    expect(browserWindowOptions("darwin", { width: 3840, height: 2160 })).toMatchObject({
      width: 1280,
      height: 840,
    });
  });
});

describe("setup window chrome", () => {
  it("matches the app window chrome so first run looks like the product", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const setup = setupWindowOptions(platform, laptop);
      const app = browserWindowOptions(platform, laptop);
      expect(setup.frame).toBe(app.frame);
      expect(setup.titleBarStyle).toBe(app.titleBarStyle);
    }
  });

  it("opens smaller than the app window and stays usable when resized down", () => {
    const setup = setupWindowOptions("win32", laptop);
    expect(setup.width).toBeLessThan(browserWindowOptions("win32", laptop).width);
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
  it("matches the web background token for the system appearance so the app does not flash", async () => {
    const { webDarkTokens, webLightTokens } = await import("@rakazo/ui-tokens");
    expect(appWindowBackground(null, true)).toBe(webDarkTokens.background);
    expect(appWindowBackground(null, false)).toBe(webLightTokens.background);
  });

  it("opens in the background the page last painted while the system appearance is unchanged", () => {
    const saved = parseSavedBackground(
      JSON.stringify({ color: "#0A0A0A", systemUsesDarkColors: false }),
    );
    expect(appWindowBackground(saved, false)).toBe("#0A0A0A");
  });

  it("follows the system once it switches, when the page was following it", () => {
    const saved = parseSavedBackground(
      JSON.stringify({ color: "#0A0A0A", systemUsesDarkColors: true }),
    );
    expect(appWindowBackground(saved, false)).toBe(appWindowBackground(null, false));
  });

  it("keeps an appearance picked in settings after the system switches", () => {
    const saved = parseSavedBackground(
      JSON.stringify({ color: "#0A0A0A", systemUsesDarkColors: false }),
    );
    expect(appWindowBackground(saved, true)).toBe("#0A0A0A");
  });

  it("ignores a saved background that is not a color", () => {
    expect(
      parseSavedBackground(JSON.stringify({ color: "oklch(0.2 0 0)", systemUsesDarkColors: true })),
    ).toBeNull();
    expect(parseSavedBackground("#0A0A0A")).toBeNull();
  });

  it("keeps the always-dark setup page on the dark background", async () => {
    const { webDarkTokens } = await import("@rakazo/ui-tokens");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(setupWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
    }
  });
});

describe("saved window bounds", () => {
  const saved = { x: 100, y: 50, width: 1000, height: 700, maximized: true, fullScreen: false };
  const primary = { x: 0, y: 25, width: 1440, height: 850 };
  const external = { x: 1440, y: 0, width: 1920, height: 1080 };

  it("reads back what was written", () => {
    expect(parseSavedWindowBounds(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([
    "",
    "{",
    "null",
    '{"x":1,"y":2,"width":0,"height":5}',
    '{"x":"1","y":2,"width":3,"height":4}',
  ])("ignores an unusable file (%s)", (text) => {
    expect(parseSavedWindowBounds(text)).toBeNull();
  });

  it("restores a window that is on a connected display, even across two", () => {
    expect(restorableWindowBounds(saved, [primary])).toBe(saved);
    const spanning = { ...saved, x: 1000 };
    expect(restorableWindowBounds(spanning, [primary, external])).toBe(spanning);
  });

  it("falls back to the default when the display it was on is gone", () => {
    const onExternal = { ...saved, x: 2000 };
    expect(restorableWindowBounds(onExternal, [primary])).toBeNull();
    expect(restorableWindowBounds({ ...saved, x: 1100 }, [primary])).toBeNull();
  });
});
