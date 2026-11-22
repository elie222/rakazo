import { describe, expect, it, vi } from "vitest";

const fetchServer = vi.hoisted(() =>
  vi.fn(async () => new Response(JSON.stringify({ text: "Hallo" }), { status: 200 })),
);

const permissions = vi.hoisted(() => ({
  get: vi.fn(async () => ({ granted: true })),
  request: vi.fn(async () => ({ granted: true })),
}));

vi.mock("expo-audio", () => ({
  AudioModule: {
    getRecordingPermissionsAsync: permissions.get,
    requestRecordingPermissionsAsync: permissions.request,
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("../api/server-headers", () => ({ fetchServer }));
vi.mock("../api/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
  voiceAccountErrorText: () => undefined,
}));
vi.mock("./voice", () => ({
  ensureVoiceConsent: vi.fn(async () => undefined),
  setDictationAudio: vi.fn(),
}));
vi.mock("../i18n/i18n", () => ({
  deviceLanguage: vi.fn(async () => "de-AT"),
  getActiveUiLocale: () => "de",
}));

import { microphonePermission, transcribeClip } from "./voice-clip";

describe("transcribeClip", () => {
  it("tells the provider which language was spoken", async () => {
    const text = await transcribeClip(
      { base64: "AAAA", mimeType: "audio/m4a" },
      new AbortController().signal,
      { apiBase: "https://api.test", headers: {}, sessionGeneration: 1 } as never,
    );
    expect(text).toBe("Hallo");
    const [, init] = fetchServer.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ language: "de-AT" });
  });
});

describe("microphonePermission", () => {
  // Android opens its prompt even when access is granted, and leaving for it ends a dictation.
  it("does not open the prompt when the microphone is already allowed", async () => {
    expect(await microphonePermission(new AbortController().signal)).toEqual({ granted: true });
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("does not open the prompt for a session that ended during the lookup", async () => {
    const ended = new AbortController();
    permissions.get.mockImplementationOnce(async () => {
      ended.abort();
      return { granted: false };
    });
    expect(await microphonePermission(ended.signal)).toEqual({ granted: false });
    expect(permissions.request).not.toHaveBeenCalled();
  });
});
