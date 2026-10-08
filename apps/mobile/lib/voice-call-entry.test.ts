import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallStatus } from "./voice-call-entry";
import {
  loadCallCallerName,
  probeProviderTranscribe,
  resolveVoiceCallPlan,
} from "./voice-call-entry";

function deps(options: { deviceVoice: boolean; dictation: boolean; status: VoiceCallStatus }) {
  return {
    loadDeviceVoiceEnabled: vi.fn(async () => options.deviceVoice),
    dictationAvailable: vi.fn(async () => options.dictation),
    loadVoiceStatus: vi.fn(async () => options.status),
  };
}

describe("mobile voice call entry", () => {
  it("starts a device-only call without asking the API for provider readiness", async () => {
    const fakes = deps({
      deviceVoice: true,
      dictation: true,
      status: { ready: false, transcribe: false },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({
      kind: "device",
      transcribe: false,
    });
    expect(fakes.loadVoiceStatus).not.toHaveBeenCalled();
  });

  it("reports missing speech recognition instead of opening provider setup", async () => {
    const fakes = deps({
      deviceVoice: true,
      dictation: false,
      status: { ready: false, transcribe: false },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({ kind: "dictation" });
    expect(fakes.loadVoiceStatus).toHaveBeenCalledOnce();
  });

  it("keeps the normal cloud provider path when device voice is off", async () => {
    const fakes = deps({
      deviceVoice: false,
      dictation: false,
      status: { ready: true, transcribe: true },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({
      kind: "provider",
      transcribe: true,
    });
    expect(fakes.dictationAvailable).not.toHaveBeenCalled();
  });

  it("keeps provider setup when only on-device dictation is available", async () => {
    const fakes = deps({
      deviceVoice: false,
      dictation: true,
      status: { ready: false, transcribe: false },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({ kind: "settings" });
    expect(fakes.dictationAvailable).not.toHaveBeenCalled();
  });

  it("falls back to provider transcription when local dictation is unavailable", async () => {
    const fakes = deps({
      deviceVoice: true,
      dictation: false,
      status: { ready: true, transcribe: true },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({
      kind: "provider",
      transcribe: true,
    });
  });

  it("uses on-device dictation with a configured speak-only provider", async () => {
    const fakes = deps({
      deviceVoice: false,
      dictation: true,
      status: { ready: true, transcribe: false },
    });

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({
      kind: "provider",
      transcribe: false,
    });
    expect(fakes.dictationAvailable).toHaveBeenCalledOnce();
  });

  it("fails closed to device voice if its preference cannot be read", async () => {
    const fakes = deps({
      deviceVoice: true,
      dictation: true,
      status: { ready: false, transcribe: false },
    });
    fakes.loadDeviceVoiceEnabled.mockRejectedValueOnce(new Error("device locked"));

    await expect(resolveVoiceCallPlan(fakes)).resolves.toEqual({
      kind: "device",
      transcribe: false,
    });
    expect(fakes.loadVoiceStatus).not.toHaveBeenCalled();
  });
});

describe("probeProviderTranscribe", () => {
  it("is true only when the provider is ready to transcribe", async () => {
    const loadVoiceStatus = vi.fn(async () => ({ ready: true, transcribe: true }));

    await expect(probeProviderTranscribe(loadVoiceStatus)).resolves.toBe(true);
  });

  it("is false when the provider is not ready", async () => {
    const loadVoiceStatus = vi.fn(async () => ({ ready: false, transcribe: true }));

    await expect(probeProviderTranscribe(loadVoiceStatus)).resolves.toBe(false);
  });

  it("is false for a speak-only provider", async () => {
    const loadVoiceStatus = vi.fn(async () => ({ ready: true, transcribe: false }));

    await expect(probeProviderTranscribe(loadVoiceStatus)).resolves.toBe(false);
  });

  it("is false when the status probe throws", async () => {
    const loadVoiceStatus = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(probeProviderTranscribe(loadVoiceStatus)).resolves.toBe(false);
  });
});

describe("loadCallCallerName", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the first name when the profile arrives promptly", async () => {
    vi.useFakeTimers();
    await expect(loadCallCallerName(async () => ({ name: "  Alex Example  " }))).resolves.toBe(
      "Alex",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues without a name after 500 ms even if the profile never arrives", async () => {
    vi.useFakeTimers();
    const result = loadCallCallerName(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a profile failure after the deadline", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const result = loadCallCallerName(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeUndefined();
    reject(new Error("offline"));
    await Promise.resolve();
  });

  it("continues without a name on a failed or empty profile", async () => {
    await expect(
      loadCallCallerName(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
    await expect(loadCallCallerName(async () => ({ name: " " }))).resolves.toBeUndefined();
  });
});
