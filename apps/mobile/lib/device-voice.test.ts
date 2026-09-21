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

  it("persists on and off", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    await saveDeviceVoiceEnabled(true);
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    await saveDeviceVoiceEnabled(false);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });
});
