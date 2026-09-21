import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

describe("device voice preference", () => {
  beforeEach(() => {
    store.clear();
  });

  it("defaults to off", async () => {
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("persists on and off, reporting success", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    await expect(saveDeviceVoiceEnabled(true)).resolves.toBe(true);
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    await expect(saveDeviceVoiceEnabled(false)).resolves.toBe(true);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("reports failure instead of silently dropping a write", async () => {
    const SecureStore = await import("expo-secure-store");
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { saveDeviceVoiceEnabled } = await import("./device-voice");

    await expect(saveDeviceVoiceEnabled(true)).resolves.toBe(false);
  });
});
