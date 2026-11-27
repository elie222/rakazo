import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypecastVoiceProvider } from "./typecast-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("TypecastVoiceProvider", () => {
  it.each([
    [undefined, "ssfm-v31"],
    [" ", "ssfm-v31"],
    ["ssfm-v21", "ssfm-v21"],
  ])("speaks MP3 with the connection model %j as %s", async (model, expected) => {
    const fetch = stubFetch(
      () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } }),
    );

    const clip = await new TypecastVoiceProvider().synthesize(
      { text: "안녕하세요", voiceId: "tc_abc", apiKey: "tc-key", model },
      context,
    );

    expect(clip).toEqual({ bytes: new Uint8Array([1, 2]), mimeType: "audio/mpeg" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typecast.ai/v1/text-to-speech");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("tc-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      voice_id: "tc_abc",
      text: "안녕하세요",
      model: expected,
      prompt: { emotion_type: "smart" },
      output: { audio_format: "mp3" },
    });
  });

  it("lists the voices of the connection model with their localized names", async () => {
    const fetch = stubFetch(() =>
      Response.json([
        {
          voice_id: "tc_1",
          voice_name: { eng: "Olivia", kor: "올리비아" },
          gender: "female",
          age: "young_adult",
        },
        { voice_id: "tc_2", voice_name: { eng: "", kor: "민준" } },
        { voice_name: { eng: "No id" } },
      ]),
    );

    await expect(
      new TypecastVoiceProvider().listVoices("tc-key", context, { model: "ssfm-v30" }),
    ).resolves.toEqual([
      { id: "tc_1", label: "Olivia", description: "Female · Young adult" },
      { id: "tc_2", label: "민준", description: undefined },
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://api.typecast.ai/v3/voices?model=ssfm-v30",
    );
  });

  it("lists the models its voices support, newest first", async () => {
    const fetch = stubFetch(() =>
      Response.json([
        { voice_id: "tc_1", models: [{ version: "ssfm-v21" }, { version: "ssfm-v31" }] },
        { voice_id: "tc_2", models: [{ version: "ssfm-v31" }, { version: "ssfm-v30" }, {}] },
        { voice_id: "tc_3" },
      ]),
    );

    await expect(new TypecastVoiceProvider().listModels("tc-key", context)).resolves.toEqual([
      { id: "ssfm-v31", label: "ssfm-v31" },
      { id: "ssfm-v30", label: "ssfm-v30" },
      { id: "ssfm-v21", label: "ssfm-v21" },
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.typecast.ai/v3/voices");
  });
});
