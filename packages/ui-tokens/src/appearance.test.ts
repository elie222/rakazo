import { describe, expect, it } from "vitest";
import {
  normalizeAppearancePreference,
  persistAppearancePreference,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
} from "./index.js";

describe("appearance preference", () => {
  it("defaults unknown values to system", () => {
    expect(normalizeAppearancePreference(null)).toBe("system");
    expect(normalizeAppearancePreference("nope")).toBe("system");
    expect(normalizeAppearancePreference("light")).toBe("light");
  });

  it("resolves system from the platform scheme", () => {
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("reads and writes storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(resolveAppearancePreference({ storage })).toBe("system");
    persistAppearancePreference("light", storage);
    expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(resolveAppearancePreference({ storage })).toBe("light");
  });

  it("returns distinct light and dark token sets", () => {
    expect(tokensForAppearance("dark").page).toBe("#050506");
    expect(tokensForAppearance("light").page).toBe("#F4F4F2");
    expect(tokensForAppearance("light").ink).not.toBe(tokensForAppearance("dark").ink);
  });

  it("maps cream button ink separately from hairline", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.creamInk).toBe("#1A1A1A");
    expect(light.creamInk).toBe("#F1F1EF");
    expect(dark.creamInk).not.toBe(dark.hairline);
    expect(light.creamInk).not.toBe(light.hairline);
  });

  it("tolerates a throwing localStorage getter", () => {
    const storageProbe = {
      get storage() {
        throw new Error("blocked");
      },
    };
    // Simulate environments where accessing localStorage throws.
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(resolveAppearancePreference()).toBe("system");
      persistAppearancePreference("light");
      expect(resolveAppearancePreference()).toBe("system");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
    void storageProbe;
  });
});
