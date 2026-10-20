import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSED_SECTIONS_KEY,
  loadCollapsedSections,
  saveCollapsedSections,
} from "./collapsed-sections";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

describe("collapsed sections", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(SecureStore.getItemAsync).mockClear();
    vi.mocked(SecureStore.setItemAsync).mockClear();
  });

  it("restores the keys with the account that saved them", async () => {
    saveCollapsedSections("user-1", new Set(["space-1:pinned", "space-1:section:work", "bot-1"]));
    await vi.waitFor(() => expect(store.has(COLLAPSED_SECTIONS_KEY)).toBe(true));
    expect(await loadCollapsedSections()).toEqual({
      userId: "user-1",
      keys: new Set(["space-1:pinned", "space-1:section:work", "bot-1"]),
    });
  });

  it("starts expanded when nothing is stored", async () => {
    expect(await loadCollapsedSections()).toBeNull();
  });

  it("waits for a pending save before loading", async () => {
    store.set(COLLAPSED_SECTIONS_KEY, JSON.stringify({ userId: "user-1", keys: [] }));
    let finishWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await writeReady;
      store.set(key, value);
    });

    saveCollapsedSections("user-1", new Set(["bot-1"]));
    const loaded = loadCollapsedSections();
    finishWrite();

    expect(await loaded).toEqual({ userId: "user-1", keys: new Set(["bot-1"]) });
  });

  it("starts expanded when the stored value is unreadable", async () => {
    store.set(COLLAPSED_SECTIONS_KEY, "{not json");
    expect(await loadCollapsedSections()).toBeNull();
    store.set(COLLAPSED_SECTIONS_KEY, JSON.stringify({ userId: "user-1", keys: "bot-1" }));
    expect(await loadCollapsedSections()).toBeNull();
    store.set(COLLAPSED_SECTIONS_KEY, JSON.stringify({ keys: ["bot-1"] }));
    expect(await loadCollapsedSections()).toBeNull();
  });

  it("keeps the last of several quick changes", async () => {
    // The first write is slow; later writes must still land after it.
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.set(key, value);
    });
    saveCollapsedSections("user-1", new Set(["bot-1"]));
    saveCollapsedSections("user-1", new Set(["bot-1", "space-1:pinned"]));
    saveCollapsedSections("user-1", new Set(["space-1:pinned"]));
    await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await loadCollapsedSections()).toEqual({
      userId: "user-1",
      keys: new Set(["space-1:pinned"]),
    });
  });

  it("ignores storage failures", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("unavailable"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("unavailable"));
    expect(await loadCollapsedSections()).toBeNull();
    expect(() => saveCollapsedSections("user-1", new Set(["bot-1"]))).not.toThrow();
    await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1));
  });
});
