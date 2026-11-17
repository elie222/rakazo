import { REMOTE_IMAGES_STORAGE_KEY } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

describe("mobile remote images preference", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("keeps web images behind a tap until the reader turns loading on", async () => {
    const { getCachedRemoteImagesEnabled, setRemoteImagesPreference } = await import(
      "./remote-images-preference"
    );
    expect(getCachedRemoteImagesEnabled()).toBe(false);
    await setRemoteImagesPreference("on");
    expect(getCachedRemoteImagesEnabled()).toBe(true);
    expect(store.get(REMOTE_IMAGES_STORAGE_KEY)).toBe("on");
  });

  it("loads a saved choice and notifies subscribers", async () => {
    const { getCachedRemoteImagesEnabled, loadRemoteImagesPreference, subscribeRemoteImages } =
      await import("./remote-images-preference");
    store.set(REMOTE_IMAGES_STORAGE_KEY, "on");
    const listener = vi.fn();
    subscribeRemoteImages(listener);

    await expect(loadRemoteImagesPreference()).resolves.toBe("on");
    expect(getCachedRemoteImagesEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });
});
