import { describe, expect, it } from "vitest";
import {
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
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
