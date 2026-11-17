import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));

describe("mobile composer model picker preference", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("stays off until turned on, and saves the choice", async () => {
    const {
      COMPOSER_MODEL_PICKER_STORAGE_KEY,
      getCachedComposerModelPicker,
      setComposerModelPicker,
    } = await import("./composer-model-picker-preference");
    expect(getCachedComposerModelPicker()).toBe(false);
    await setComposerModelPicker(true);
    expect(getCachedComposerModelPicker()).toBe(true);
    expect(store.get(COMPOSER_MODEL_PICKER_STORAGE_KEY)).toBe("on");
  });

  it("loads a saved choice and notifies subscribers", async () => {
    const {
      COMPOSER_MODEL_PICKER_STORAGE_KEY,
      getCachedComposerModelPicker,
      loadComposerModelPickerPreference,
      subscribeComposerModelPicker,
    } = await import("./composer-model-picker-preference");
    store.set(COMPOSER_MODEL_PICKER_STORAGE_KEY, "on");
    const listener = vi.fn();
    subscribeComposerModelPicker(listener);
    await expect(loadComposerModelPickerPreference()).resolves.toBe(true);
    expect(getCachedComposerModelPicker()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });
});
