import { describe, expect, it } from "vitest";
import {
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
  developmentIconFile,
  parseSavedWindow,
  restorableWindow,
  setupWindowOptions,
  warmWindowTtlMs,
  windowStateReader,
} from "./window-options.js";

const laptop = { width: 1440, height: 875 };

describe("desktop window chrome", () => {
  it("uses native traffic lights on macOS", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.frame).toBe(true);
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 16, y: 16 });
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
      expect(setup.backgroundColor).toBe(app.backgroundColor);
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
  it("matches the web dark background token so startup chrome does not flash", async () => {
    const { webDarkTokens } = await import("@rakazo/ui-tokens");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(browserWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
      expect(setupWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
    }
  });
});

describe("saved window", () => {
  const display = (area: { x: number; y: number; width: number; height: number }) => ({
    bounds: area,
    workArea: area,
  });
  const primary = display({ x: 0, y: 0, width: 1440, height: 875 });
  const second = display({ x: 1440, y: 0, width: 1920, height: 1080 });
  const onSecond = {
    x: 1600,
    y: 100,
    width: 1400,
    height: 900,
    maximized: true,
    fullScreen: false,
  };

  it("reads only complete, usable bounds", () => {
    expect(parseSavedWindow(JSON.stringify(onSecond))).toEqual(onSecond);
    expect(
      parseSavedWindow(JSON.stringify({ ...onSecond, maximized: "yes", fullScreen: "yes" })),
    ).toEqual({ ...onSecond, maximized: false, fullScreen: false });
    expect(parseSavedWindow(JSON.stringify({ ...onSecond, fullScreen: true }))).toEqual({
      ...onSecond,
      fullScreen: true,
    });
    expect(parseSavedWindow(JSON.stringify({ ...onSecond, x: 1600.4, width: 1399.6 }))).toEqual(
      onSecond,
    );
    for (const raw of ["", "null", "not json", JSON.stringify({ x: 1, y: 2, width: 3 })])
      expect(parseSavedWindow(raw)).toBeNull();
    for (const size of [{ width: 1 }, { height: 1 }, { width: 0 }])
      expect(parseSavedWindow(JSON.stringify({ ...onSecond, ...size }))).toBeNull();
  });

  it("reopens on the display it was closed on", () => {
    expect(restorableWindow(onSecond, [primary, second])).toEqual(onSecond);
    const fullScreen = { ...onSecond, fullScreen: true };
    expect(restorableWindow(fullScreen, [primary, second])).toEqual(fullScreen);
  });

  it("opens at the default when that display is gone", () => {
    expect(restorableWindow(onSecond, [primary])).toBeNull();
    expect(restorableWindow(null, [primary])).toBeNull();
  });

  it("moves a window that runs past an edge back onto its display", () => {
    const past = (x: number, y: number) => ({
      x,
      y,
      width: 1000,
      height: 700,
      maximized: false,
      fullScreen: false,
    });
    expect(restorableWindow(past(900, 100), [primary])).toMatchObject({ x: 440, y: 100 });
    expect(restorableWindow(past(-400, 100), [primary])).toMatchObject({ x: 0, y: 100 });
    expect(restorableWindow(past(100, 400), [primary])).toMatchObject({ x: 100, y: 175 });
    expect(restorableWindow(past(100, -20), [primary])).toMatchObject({ x: 100, y: 0 });
  });

  it("keeps a window whose center is under the taskbar, above the taskbar", () => {
    const withTaskbar = {
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 840 },
    };
    expect(
      restorableWindow(
        { x: 100, y: 500, width: 800, height: 700, maximized: false, fullScreen: false },
        [withTaskbar],
      ),
    ).toEqual({ x: 100, y: 140, width: 800, height: 700, maximized: false, fullScreen: false });
  });

  it("shrinks to fit a smaller display", () => {
    expect(restorableWindow({ ...onSecond, x: 100, y: 0 }, [primary])).toEqual({
      x: 40,
      y: 0,
      width: 1400,
      height: 875,
      maximized: true,
      fullScreen: false,
    });
  });

  it("stays inside a display that does not start at the origin", () => {
    expect(
      restorableWindow(
        { x: 2700, y: 500, width: 800, height: 700, maximized: false, fullScreen: false },
        [second],
      ),
    ).toEqual({ x: 2560, y: 380, width: 800, height: 700, maximized: false, fullScreen: false });
  });
});

describe("window state to save", () => {
  // Electron's reports for one window, which a test changes as the window would.
  function fakeWindow() {
    return {
      minimized: false,
      maximized: false,
      fullScreen: false,
      normal: { x: 10, y: 20, width: 900, height: 700 },
      isMinimized() {
        return this.minimized;
      },
      isMaximized() {
        return this.maximized;
      },
      isFullScreen() {
        return this.fullScreen;
      },
      getNormalBounds() {
        return this.normal;
      },
    };
  }
  const normal = { x: 10, y: 20, width: 900, height: 700 };

  it("keeps the state from before a maximized window was minimized", () => {
    const read = windowStateReader<ReturnType<typeof fakeWindow>>();
    const win = fakeWindow();
    win.maximized = true;
    read(win);
    // macOS overwrites the normal bounds with the maximized frame, and Windows reports a
    // minimized window as not maximized.
    win.minimized = true;
    win.maximized = false;
    win.normal = { x: 0, y: 0, width: 1440, height: 875 };
    expect(read(win)).toEqual({ ...normal, maximized: true, fullScreen: false });
  });

  it("keeps the normal bounds of a maximized window restored from minimized", () => {
    const read = windowStateReader<ReturnType<typeof fakeWindow>>();
    const win = fakeWindow();
    read(win);
    win.maximized = true;
    read(win);
    win.minimized = true;
    win.normal = { x: 0, y: 0, width: 1440, height: 875 };
    read(win);
    // macOS keeps reporting the maximized frame as the normal bounds after the restore.
    win.minimized = false;
    expect(read(win)).toEqual({ ...normal, maximized: true, fullScreen: false });
    win.maximized = false;
    win.normal = { x: 30, y: 40, width: 800, height: 600 };
    expect(read(win)).toEqual({ ...win.normal, maximized: false, fullScreen: false });
  });

  it("keeps the normal bounds from before full screen", () => {
    const read = windowStateReader<ReturnType<typeof fakeWindow>>();
    const win = fakeWindow();
    read(win);
    win.fullScreen = true;
    win.normal = { x: 0, y: 0, width: 1440, height: 900 };
    expect(read(win)).toEqual({ ...normal, maximized: false, fullScreen: true });
  });

  it("reads the current state once the window is restored", () => {
    const read = windowStateReader<ReturnType<typeof fakeWindow>>();
    const win = fakeWindow();
    read(win);
    win.minimized = true;
    read(win);
    win.minimized = false;
    win.normal = { x: 30, y: 40, width: 800, height: 600 };
    expect(read(win)).toEqual({ ...win.normal, maximized: false, fullScreen: false });
  });

  it("reads a window first seen minimized as it is", () => {
    const read = windowStateReader<ReturnType<typeof fakeWindow>>();
    const win = fakeWindow();
    win.minimized = true;
    expect(read(win)).toEqual({ ...normal, maximized: false, fullScreen: false });
  });
});
