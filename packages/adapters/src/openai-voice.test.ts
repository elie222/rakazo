import { afterEach, expect, it, vi } from "vitest";
import { OpenAIVoiceProvider } from "./openai-voice.js";

const context = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

it.each(["marin"])("lists and sends the %s voice for speech", async (voiceId) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new OpenAIVoiceProvider();

  expect((await provider.listVoices("test-key", context)).map((voice) => voice.id)).toContain(
    voiceId,
  );
  await provider.synthesize({ apiKey: "test-key", voiceId, text: "Hello" }, context);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
    model: "gpt-4o-mini-tts",
    voice: voiceId,
  });
});
