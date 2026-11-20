import { deferred } from "@rakazo/core/test-async";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../api/api";
import { resolveVoiceCallPlan } from "../calls/voice-call-entry";
import { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } from "./device-voice";

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
vi.mock("../api/api", () => ({
  rpc: vi.fn(async () => {
    await status.gate;
    if (status.fail) throw new Error("offline");
    return { ready: status.ready, transcribe: true };
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

  it("inherits live hosted readiness without saving an inferred device preference", async () => {
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    status.ready = true;
    expect(await loadDeviceVoiceEnabled()).toBe(false);
    expect(store.size).toBe(0);
  });

  it("uses one live readiness answer for each inherited call plan", async () => {
    vi.mocked(rpc).mockClear();
    const plan = () =>
      resolveVoiceCallPlan({
        loadDeviceVoiceEnabled: (loadVoiceStatus) =>
          loadDeviceVoiceEnabled("bot-voice", undefined, loadVoiceStatus),
        dictationAvailable: async () => true,
        loadVoiceStatus: () => rpc("voice/status", { botId: "bot-voice" }),
      });
    status.ready = true;
    await expect(plan()).resolves.toEqual({ kind: "provider", transcribe: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    status.ready = false;
    await expect(plan()).resolves.toEqual({ kind: "device", transcribe: false });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("falls back to the device when the hosted default stops being ready", async () => {
    status.ready = true;
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
    status.ready = false;
    expect(await loadDeviceVoiceEnabled()).toBe(true);
  });

  it("uses this device without remembering it when the server cannot answer", async () => {
    status.fail = true;
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    status.fail = false;
    status.ready = true;
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("checks the bot's effective voice without requiring a global default", async () => {
    status.ready = true;
    const requestContext = { apiBase: "https://api.example.test", headers: {} };
    expect(await loadDeviceVoiceEnabled("bot-voice", requestContext)).toBe(false);
    expect(rpc).toHaveBeenLastCalledWith(
      "voice/status",
      { botId: "bot-voice" },
      { requestContext },
    );
    expect(store.size).toBe(0);
  });

  it("honors explicit device-only speech even when the bot has a hosted voice", async () => {
    await saveDeviceVoiceEnabled(true);
    status.ready = true;
    expect(await loadDeviceVoiceEnabled("bot-voice")).toBe(true);
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
    const { rpc } = await import("../api/api");
    const asked = vi.mocked(rpc).mock.calls.length;
    const answer = deferred();
    status.gate = answer.promise;
    status.ready = true;
    const loading = loadDeviceVoiceEnabled();
    await vi.waitFor(() => expect(vi.mocked(rpc).mock.calls.length).toBe(asked + 1));
    await saveDeviceVoiceEnabled(true);
    answer.resolve();
    expect(await loading).toBe(true);
    expect(store.get(DEVICE_VOICE_KEY)).toBe("1");
  });

  it("reads a choice still being saved instead of writing a default over it", async () => {
    const { DEVICE_VOICE_KEY, loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import(
      "./device-voice"
    );
    const landed = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await landed.promise;
      store.set(key, value);
    });
    status.ready = true;
    const saving = saveDeviceVoiceEnabled(true);
    const loading = loadDeviceVoiceEnabled();
    landed.resolve();
    await saving;
    expect(await loading).toBe(true);
    expect(store.get(DEVICE_VOICE_KEY)).toBe("1");
  });

  it("keeps an explicit hosted choice when the in-flight inherited status request fails", async () => {
    const answer = deferred();
    status.gate = answer.promise;
    vi.mocked(rpc).mockClear();
    const loading = loadDeviceVoiceEnabled("bot-voice");
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("voice/status", { botId: "bot-voice" }, undefined),
    );
    await saveDeviceVoiceEnabled(false);
    status.fail = true;
    answer.resolve();

    await expect(loading).resolves.toBe(false);
    expect(store.get("rakazo.device-voice")).toBe("0");
  });

  it("tells listeners at once and keeps a save that a listener fails in", async () => {
    const { saveDeviceVoiceEnabled, subscribeDeviceVoiceChoice } = await import("./device-voice");
    const heard = vi.fn(() => {
      throw new Error("listener broke");
    });
    const unsubscribe = subscribeDeviceVoiceChoice(heard);
    try {
      const saving = saveDeviceVoiceEnabled(true);
      expect(heard).toHaveBeenCalledOnce();
      await expect(saving).resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }
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
