import { type Model, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { registerOpenAiCompatibleRuntime } from "./pi-openai-compatible-provider.js";

const modelId = "arbitrary-model";
const baseUrl = "http://127.0.0.1:8090/v1";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps the existing keyless connection format", () => {
  const plaintext = buildModelConnectPlaintext({ provider: "openai-compatible", baseUrl, modelId });
  expect(plaintext).toContain(baseUrl);
  expect(plaintext).not.toContain("apiKey");
});

type Payload = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string }>;
  tools: Array<{ function: { name: string } }>;
  chat_template_kwargs?: Record<string, unknown>;
  reasoning_effort?: string;
};

function fixtureResponse(): Response {
  const deltas = [
    { reasoning_content: "Check the fixture." },
    { content: "Ready." },
    {
      tool_calls: [
        {
          index: 0,
          id: "call_test",
          type: "function",
          function: { name: "lookup", arguments: '{"value":' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: "42}" } }] },
  ];
  const chunks = [...deltas, {}].map((delta, index) => ({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: index === deltas.length ? "tool_calls" : null }],
  }));
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAI-compatible standard thinking transport", () => {
  const provider = "openai-compatible";
  async function capture(
    reasoning?: "minimal" | "low" | "medium" | "high",
    supportsThinking = true,
  ) {
    let payload: Payload | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      payload = JSON.parse(String(init?.body)) as Payload;
      return fixtureResponse();
    });
    vi.stubGlobal("fetch", mockFetch);
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId,
      baseUrl,
      reasoning: supportsThinking,
    });
    const model = models.getModel(provider, modelId) as Model<"openai-completions">;
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: "Use the fixture.",
        messages: [{ role: "user", content: "Look it up.", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Look up a fixture",
            parameters: Type.Object({ value: Type.Number() }),
          },
        ],
      },
      { reasoning, fetch: mockFetch },
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("toolUse");
    return { payload: payload!, result, events };
  }

  it.each(["minimal", "low", "medium", "high"] as const)(
    "sends standard effort %s unchanged",
    async (level) => {
      const { payload } = await capture(level);
      expect(payload.reasoning_effort).toBe(level);
      expect(payload.chat_template_kwargs).toBeUndefined();
    },
  );

  it("sends none when thinking is off", async () => {
    const { payload } = await capture();
    expect(payload.reasoning_effort).toBe("none");
    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it("does not send reasoning fields on a connection without support, even for the same model ID", async () => {
    await capture("high");
    const { payload } = await capture("high", false);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.chat_template_kwargs).toBeUndefined();
  });

  it("streams system-role requests, reasoning, text and fragmented tool arguments", async () => {
    const { payload, result, events } = await capture("medium");
    expect(payload.messages[0]?.role).toBe("system");
    expect(payload.stream).toBe(true);
    expect(payload.tools[0]?.function.name).toBe("lookup");
    expect(events).toEqual(
      expect.arrayContaining(["thinking_delta", "text_delta", "toolcall_delta", "done"]),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "Check the fixture." }),
        expect.objectContaining({ type: "text", text: "Ready." }),
        expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { value: 42 } }),
      ]),
    );
  });
});
