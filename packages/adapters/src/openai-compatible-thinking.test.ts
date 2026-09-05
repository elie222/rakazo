import { type Model, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { openAiCompatibleThinking, qwenModelIds } from "./openai-compatible-thinking.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { registerOpenAiCompatibleRuntime } from "./pi-openai-compatible-provider.js";

const modelId = "test-qwen";
const baseUrl = "http://127.0.0.1:8090/v1";

beforeEach(() => {
  vi.stubEnv("RAKAZO_OPENAI_COMPAT_QWEN_MODELS", modelId);
  vi.stubEnv("RAKAZO_LOCAL_MODELS", modelId);
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", baseUrl);
  vi.stubEnv("RAKAZO_LOCAL_CONTEXT_WINDOW", "32768");
  vi.stubEnv("RAKAZO_LOCAL_MAX_TOKENS", "4096");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("requires an exact opt-in and trims and deduplicates configured IDs", () => {
  vi.stubEnv("RAKAZO_OPENAI_COMPAT_QWEN_MODELS", " test-qwen, ,test-qwen,other ");
  expect(qwenModelIds()).toEqual([modelId, "other"]);
  expect(openAiCompatibleThinking("test-qwen-extra").reasoning).toBe(false);
  expect(openAiCompatibleThinking("Test-qwen").reasoning).toBe(false);
  vi.stubEnv("RAKAZO_OPENAI_COMPAT_QWEN_MODELS", "");
  expect(openAiCompatibleThinking(modelId)).toEqual({
    reasoning: false,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  });
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

describe.each(["local", "openai-compatible"] as const)("%s thinking transport", (provider) => {
  async function capture(reasoning?: "minimal" | "low" | "medium" | "high") {
    let payload: Payload | undefined;
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      payload = JSON.parse(String(init?.body)) as Payload;
      return fixtureResponse();
    });
    vi.stubGlobal("fetch", mockFetch);
    const models =
      provider === "local"
        ? registerLocalProvider(builtinModels())
        : registerOpenAiCompatibleRuntime(builtinModels(), { modelId, baseUrl });
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

  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "xhigh"],
  ] as const)("sends %s as explicit Qwen effort %s", async (level, effort) => {
    const { payload } = await capture(level);
    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: effort,
      preserve_thinking: true,
    });
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("turns thinking off explicitly without sending an effort", async () => {
    const { payload } = await capture();
    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: true,
    });
  });

  it("leaves unconfigured models free of Qwen-specific request fields", async () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_QWEN_MODELS", "");
    const { payload } = await capture("high");
    expect(payload.chat_template_kwargs).toBeUndefined();
    expect(payload.reasoning_effort).toBeUndefined();
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
