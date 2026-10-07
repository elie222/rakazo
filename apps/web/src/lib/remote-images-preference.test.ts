import { REMOTE_IMAGES_STORAGE_KEY } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("web remote images preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps web images behind a tap until the reader turns loading on", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    const { getRemoteImagesEnabled, setRemoteImagesPreference, subscribeRemoteImages } =
      await import("./remote-images-preference");
    expect(getRemoteImagesEnabled()).toBe(false);

    const listener = vi.fn();
    subscribeRemoteImages(listener);
    setRemoteImagesPreference("on");
    expect(getRemoteImagesEnabled()).toBe(true);
    expect(store.get(REMOTE_IMAGES_STORAGE_KEY)).toBe("on");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("reads a saved choice", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === REMOTE_IMAGES_STORAGE_KEY ? "on" : null),
      setItem: () => undefined,
    });
    const { getRemoteImagesEnabled } = await import("./remote-images-preference");
    expect(getRemoteImagesEnabled()).toBe(true);
  });
});
