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
    vi.unstubAllEnvs();
  });

  it("defaults to streaming off", async () => {
    const { getCachedResponseStreamingEnabled, setResponseStreamingPreference } = await import(
      "./response-streaming"
    );
    expect(getCachedResponseStreamingEnabled()).toBe(false);
    await setResponseStreamingPreference("on");
    expect(getCachedResponseStreamingEnabled()).toBe(true);
  });

  it("loads a saved on preference and notifies subscribers", async () => {
    const { loadResponseStreamingPreference, subscribeResponseStreaming } = await import(
      "./response-streaming"
    );
    store.set(RESPONSE_STREAMING_STORAGE_KEY, "on");
    const listener = vi.fn();
    subscribeResponseStreaming(listener);

    await expect(loadResponseStreamingPreference()).resolves.toBe("on");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("notifies subscribers before SecureStore finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { setItemAsync } = await import("expo-secure-store");
    vi.mocked(setItemAsync).mockImplementation(async () => {
      await gate;
    });
    const {
      getCachedResponseStreamingEnabled,
      setResponseStreamingPreference,
      subscribeResponseStreaming,
    } = await import("./response-streaming");
    const listener = vi.fn();
    subscribeResponseStreaming(listener);

    const pending = setResponseStreamingPreference("on");
    expect(getCachedResponseStreamingEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    release();
    await pending;
  });

  it("normalizes an empty stored value to off", async () => {
    store.set(RESPONSE_STREAMING_STORAGE_KEY, "");
    const { loadResponseStreamingPreference } = await import("./response-streaming");
    await expect(loadResponseStreamingPreference()).resolves.toBe("off");
  });
});
