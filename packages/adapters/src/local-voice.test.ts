import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceProvider } from "./local-voice.js";

const context = {
  operationId: "voice",
  traceId: "voice",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe("LocalVoiceProvider", () => {
  it("checks both local services with separate tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new LocalVoiceProvider().verify("whisper-token\nkokoro-token", context)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer whisper-token" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ authorization: "Bearer kokoro-token" });
  });

  it("lists Kokoro voices and uses Whisper for transcription", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ voices: [{ id: "af_heart", description: "Warm" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "hello locally" }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalVoiceProvider();
    await expect(provider.listVoices("w\nk", context)).resolves.toEqual([
      { id: "af_heart", label: "af_heart", description: "Warm" },
    ]);
    await expect(
      provider.transcribe!({ audio: new Uint8Array([1, 2]), mimeType: "audio/webm", apiKey: "w\nk" }, context),
    ).resolves.toEqual({ text: "hello locally" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("9000/v1/audio/transcriptions");
  });

  it("returns Kokoro audio as MPEG", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new LocalVoiceProvider().synthesize({ text: "Hi", voiceId: "af_heart", apiKey: "w\nk" }, context),
    ).resolves.toMatchObject({ mimeType: "audio/mpeg", bytes: Uint8Array.from([1, 2, 3]) });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("8880/v1/audio/speech");
  });
});
