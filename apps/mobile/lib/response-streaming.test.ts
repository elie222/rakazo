import { RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

describe("mobile response streaming preference", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("defaults to streaming on", async () => {
    const { getCachedResponseStreamingEnabled, setResponseStreamingPreference } = await import(
      "./response-streaming"
    );
    expect(getCachedResponseStreamingEnabled()).toBe(true);
    await setResponseStreamingPreference("off");
    expect(getCachedResponseStreamingEnabled()).toBe(false);
  });

  it("loads a saved off preference and notifies subscribers", async () => {
    const { loadResponseStreamingPreference, subscribeResponseStreaming } = await import(
      "./response-streaming"
    );
    store.set(RESPONSE_STREAMING_STORAGE_KEY, "off");
    const listener = vi.fn();
    subscribeResponseStreaming(listener);

    await expect(loadResponseStreamingPreference()).resolves.toBe("off");
    expect(listener).toHaveBeenCalledOnce();
  });
});
