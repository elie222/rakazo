import { describe, expect, it, vi } from "vitest";
import {
  appRailExpandedStorageKey,
  readAppRailExpanded,
  writeAppRailExpanded,
} from "./app-rail-pref";

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return store;
}

describe("app rail preference", () => {
  it("builds a per-user storage key", () => {
    expect(appRailExpandedStorageKey(null)).toBeNull();
    expect(appRailExpandedStorageKey("user-1")).toBe("rakazo:app-rail-expanded:user-1");
  });

  it("keeps an explicit collapsed choice instead of falling back to the wide default", () => {
    stubStorage();
    try {
      expect(readAppRailExpanded("user-1")).toBeNull();
      writeAppRailExpanded("user-1", false);
      expect(readAppRailExpanded("user-1")).toBe(false);
      writeAppRailExpanded("user-1", true);
      expect(readAppRailExpanded("user-1")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
