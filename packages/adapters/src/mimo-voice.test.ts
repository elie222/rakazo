import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleVoiceProvider,
  serializeOpenAiCompatibleVoiceSecret,
} from "./openai-compatible-voice.js";
import { speechToWav } from "./speech-to-wav.js";

vi.mock("./speech-to-wav.js", () => ({ speechToWav: vi.fn() }));

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};
const settings = {
  baseUrl: "https://speech.example.com/v1",
  apiKey: "test-secret",
  ttsModel: "mimo-v2.5-tts",
  sttModel: "mimo-v2.5-asr",
};
const secret = JSON.stringify({ kind: "openai_compatible", ...settings });
const reply = (message: unknown) => Response.json({ choices: [{ message }] });

function setup() {
  const fetch = vi.fn();
  return { fetch, provider: new OpenAiCompatibleVoiceProvider({ fetch }) };
}

afterEach(() => vi.clearAllMocks());

describe("MiMo speech through the shared connection", () => {
  it("rejects reversed speech and transcription models before saving", () => {
    expect(() =>
      serializeOpenAiCompatibleVoiceSecret({ ...settings, ttsModel: "mimo-v2.5-asr" }),
    ).toThrow("reversed");
    expect(() =>
      serializeOpenAiCompatibleVoiceSecret({ ...settings, sttModel: "mimo-v2.5-tts" }),
    ).toThrow("reversed");
  });

  it("verifies with the same guarded, authenticated models request", async () => {
    const { fetch, provider } = setup();
    fetch.mockResolvedValue(Response.json({ data: [{ id: settings.ttsModel }] }));
    expect(await provider.verify(secret, ctx)).toEqual({ ok: true });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${settings.baseUrl}/models`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer test-secret" },
    });
  });

  it("lists the documented preset voices with the preferred Chinese voice first", async () => {
    const { fetch, provider } = setup();
    const voices = await provider.listVoices(secret, ctx);
    expect(voices[0]).toEqual({ id: "冰糖", label: "冰糖" });
    expect(voices).toHaveLength(9);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends assistant text and decodes a bounded MP3 response", async () => {
    const { fetch, provider } = setup();
    // Large enough to exceed the metadata JSON limit without exceeding the audio limit.
    const bytes = Buffer.alloc(800_000, 65);
    fetch.mockResolvedValue(reply({ audio: { data: bytes.toString("base64") } }));
    const clip = await provider.synthesize({ apiKey: secret, text: "你好", voiceId: "冰糖" }, ctx);
    expect(clip).toEqual({ bytes, mimeType: "audio/mpeg" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${settings.baseUrl}/chat/completions`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      model: settings.ttsModel,
      messages: [{ role: "assistant", content: "你好" }],
      audio: { voice: "冰糖", format: "mp3" },
      stream: false,
    });
  });

  it.each([
    null,
    {},
    { audio: { data: "" } },
    { audio: { data: "!!!!" } },
    { audio: { data: "a" } },
  ])("rejects missing or invalid audio: %j", async (message) => {
    const { fetch, provider } = setup();
    fetch.mockResolvedValue(reply(message));
    await expect(
      provider.synthesize({ apiKey: secret, text: "hi", voiceId: "冰糖" }, ctx),
    ).rejects.toThrow(/audio/);
  });

  it("keeps upstream key rejection typed and redacts the key", async () => {
    const { fetch, provider } = setup();
    fetch.mockResolvedValue(
      Response.json({ error: { message: "bad test-secret" } }, { status: 401 }),
    );
    await expect(
      provider.synthesize({ apiKey: secret, text: "hi", voiceId: "冰糖" }, ctx),
    ).rejects.toMatchObject({ code: "VOICE_KEY_REJECTED" });
  });

  it("caps audio JSON before decoding", async () => {
    const { fetch, provider } = setup();
    fetch.mockResolvedValue(
      new Response("{}", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }),
    );
    await expect(
      provider.synthesize({ apiKey: secret, text: "hi", voiceId: "冰糖" }, ctx),
    ).rejects.toThrow("too large");
  });

  it.each(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"])(
    "transcribes %s without conversion",
    async (mimeType) => {
      const { fetch, provider } = setup();
      fetch.mockResolvedValue(reply({ content: "  测试文本  " }));
      const audio = new Uint8Array([1, 2, 3]);
      expect(
        await provider.transcribe({ apiKey: secret, audio, mimeType, language: "zh-CN" }, ctx),
      ).toEqual({ text: "测试文本" });
      expect(speechToWav).not.toHaveBeenCalled();
      const body = JSON.parse(fetch.mock.calls[0]?.[1].body);
      expect(String(fetch.mock.calls[0]?.[0])).toBe(`${settings.baseUrl}/chat/completions`);
      expect(body.asr_options).toEqual({ language: "zh" });
      expect(body.messages[0].content[0].input_audio.data).toBe(
        `data:${mimeType.includes("mp") ? "audio/mpeg" : "audio/wav"};base64,AQID`,
      );
    },
  );

  it.each(["audio/webm;codecs=opus", "audio/mp4", "audio/ogg", ""])(
    "converts %s using the same cancellation deadline",
    async (mimeType) => {
      const { fetch, provider } = setup();
      vi.mocked(speechToWav).mockResolvedValue(new Uint8Array([4, 5, 6]));
      fetch.mockResolvedValue(reply({ content: "ok" }));
      const audio = new Uint8Array([1, 2]);
      await provider.transcribe({ apiKey: secret, audio, mimeType }, ctx);
      expect(speechToWav).toHaveBeenCalledWith(audio, expect.any(AbortSignal), 7_864_320);
      expect(fetch.mock.calls[0]?.[1].signal).toBe(vi.mocked(speechToWav).mock.calls[0]?.[1]);
      const body = JSON.parse(fetch.mock.calls[0]?.[1].body);
      expect(body.messages[0].content[0].input_audio.data).toBe("data:audio/wav;base64,BAUG");
    },
  );

  it("rejects oversized base64 input before contacting the server", async () => {
    const { fetch, provider } = setup();
    await expect(
      provider.transcribe(
        { apiKey: secret, audio: new Uint8Array(7_864_321), mimeType: "audio/wav" },
        ctx,
      ),
    ).rejects.toThrow("10 MiB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps non-JSON transcription key failures typed", async () => {
    const { fetch, provider } = setup();
    fetch.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(
      provider.transcribe(
        { apiKey: secret, audio: new Uint8Array([1]), mimeType: "audio/wav" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VOICE_KEY_REJECTED" });
  });

  it("rejects unsupported language, cancellation, and malformed transcripts", async () => {
    const { fetch, provider } = setup();
    const request = { apiKey: secret, audio: new Uint8Array([1]), mimeType: "audio/wav" };
    await expect(provider.transcribe({ ...request, language: "fr" }, ctx)).rejects.toThrow(
      "Chinese and English",
    );
    await expect(
      provider.transcribe({ ...request, signal: AbortSignal.abort() }, ctx),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(reply({ content: 123 }));
    await expect(provider.transcribe(request, ctx)).rejects.toThrow("transcript");
  });
});
