import * as SecureStore from "expo-secure-store";
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
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
      store.delete(key);
    });
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

  it("rejects when SecureStore cannot write, so callers can roll back", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { saveDeviceVoiceEnabled, loadDeviceVoiceEnabled } = await import("./device-voice");

    await expect(saveDeviceVoiceEnabled(true)).rejects.toThrow("device locked");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("rejects when SecureStore cannot read, instead of treating the preference as off", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { loadDeviceVoiceEnabled } = await import("./device-voice");

    await expect(loadDeviceVoiceEnabled()).rejects.toThrow("device locked");
  });
});
