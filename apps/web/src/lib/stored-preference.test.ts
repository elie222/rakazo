// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoredPreference, readStoredString, writeStoredString } from "./stored-preference";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
}

const blockedStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

function flagPreference() {
  return createStoredPreference({
    key: "test.flag",
    parse: (raw) => raw === "1",
    serialize: (on) => (on ? "1" : null),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createStoredPreference", () => {
  it("parses the saved value and lets parse choose the default", () => {
    vi.stubGlobal("localStorage", memoryStorage({ "test.flag": "1" }).storage);
    expect(flagPreference().get()).toBe(true);
    vi.stubGlobal("localStorage", memoryStorage().storage);
    expect(flagPreference().get()).toBe(false);
  });

  it("persists, removes on null, and notifies subscribers until they unsubscribe", () => {
    const { store, storage } = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const preference = flagPreference();
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);

    expect(preference.set(true)).toBe(true);
    expect(preference.get()).toBe(true);
    expect(store.get("test.flag")).toBe("1");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    preference.set(false);
    expect(store.has("test.flag")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("takes a change saved in another tab", () => {
    vi.stubGlobal("localStorage", memoryStorage().storage);
    const preference = flagPreference();
    const listener = vi.fn();
    preference.subscribe(listener);
    expect(preference.get()).toBe(false);

    window.dispatchEvent(new StorageEvent("storage", { key: "other.key", newValue: "1" }));
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", { key: "test.flag", newValue: "1" }));
    expect(preference.get()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    // Another tab cleared all of storage.
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(preference.get()).toBe(false);
  });

  it("keeps working in memory when storage is blocked or missing", () => {
    vi.stubGlobal("localStorage", blockedStorage);
    const preference = flagPreference();
    expect(preference.get()).toBe(false);
    expect(() => preference.set(true)).not.toThrow();
    expect(preference.get()).toBe(true);

    vi.stubGlobal("localStorage", undefined);
    expect(flagPreference().get()).toBe(false);
    expect(readStoredString("test.flag")).toBeNull();
    expect(() => writeStoredString("test.flag", "1")).not.toThrow();
  });
});
