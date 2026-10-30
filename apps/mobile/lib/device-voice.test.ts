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
const status = vi.hoisted(() => ({
  ready: false,
  fail: false,
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("./api", () => ({
  rpc: vi.fn(async () => {
    await status.gate;
    if (status.fail) throw new Error("offline");
    return { ready: status.ready };
  }),
}));

describe("device voice preference", () => {
  beforeEach(() => {
    store.clear();
    status.ready = false;
    status.fail = false;
    status.gate = undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
      store.delete(key);
    });
  });

  it("defaults to on, and keeps that answer, when no hosted voice is ready", async () => {
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    status.ready = true;
    expect(await loadDeviceVoiceEnabled()).toBe(true);
  });

  it("keeps a hosted voice that is already ready", async () => {
    status.ready = true;
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
    status.ready = false;
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("uses this device without remembering it when the server cannot answer", async () => {
    status.fail = true;
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    status.fail = false;
    status.ready = true;
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("persists on and off", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    await saveDeviceVoiceEnabled(true);
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    await saveDeviceVoiceEnabled(false);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("never overwrites a choice saved while the default was being worked out", async () => {
    const { DEVICE_VOICE_KEY, loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import(
      "./device-voice"
    );
    const { rpc } = await import("./api");
    const asked = vi.mocked(rpc).mock.calls.length;
    let answer!: () => void;
    status.gate = new Promise((resolve) => {
      answer = resolve;
    });
    status.ready = true;
    const loading = loadDeviceVoiceEnabled();
    await vi.waitFor(() => expect(vi.mocked(rpc).mock.calls.length).toBe(asked + 1));
    await saveDeviceVoiceEnabled(true);
    answer();
    expect(await loading).toBe(true);
    expect(store.get(DEVICE_VOICE_KEY)).toBe("1");
  });

  it("rejects when SecureStore cannot write, so callers can roll back", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { saveDeviceVoiceEnabled, loadDeviceVoiceEnabled } = await import("./device-voice");

    status.ready = true;
    await expect(saveDeviceVoiceEnabled(true)).rejects.toThrow("device locked");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("rejects when SecureStore cannot read, instead of treating the preference as off", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { loadDeviceVoiceEnabled } = await import("./device-voice");

    await expect(loadDeviceVoiceEnabled()).rejects.toThrow("device locked");
  });
});
