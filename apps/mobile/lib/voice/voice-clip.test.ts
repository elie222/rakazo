import { describe, expect, it, vi } from "vitest";

const fetchServer = vi.hoisted(() =>
  vi.fn(async () => new Response(JSON.stringify({ text: "Hallo" }), { status: 200 })),
);

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

import { transcribeClip } from "./voice-clip";

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
