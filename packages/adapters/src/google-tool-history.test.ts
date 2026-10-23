import type { Api, AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it, vi } from "vitest";
import { withGoogleToolHistory } from "./google-tool-history.js";
import { observedPiStream } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "google",
  id: "gemini-3-flash-preview",
  api: "google-generative-ai",
  name: "Fixture",
  baseUrl: "https://model.example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 256,
};
const call = (id: string, args: ToolCall["arguments"], signature?: string) => ({
  type: "toolCall" as const,
  id,
  name: "fixture_tool",
  arguments: args,
  ...(signature ? { thoughtSignature: signature } : {}),
});
const assistant = (source: string, content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  provider: "google",
  model: source,
  api: model.api,
  content,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 1,
});

it.each(["google", "openai"])(
  "sends transferred %s tool history on the wire and preserves native parallel signatures",
  async (sourceProvider) => {
    const context: Context = {
      messages: [
        { role: "user", content: "Fixture request.", timestamp: 1 },
        {
          ...assistant("fixture-origin", [call("foreign", { query: "earlier" }, "Zm9yZWlnbg==")]),
          provider: sourceProvider,
          api: sourceProvider === "google" ? model.api : "openai-completions",
        },
        {
          role: "toolResult",
          toolCallId: "foreign",
          toolName: "fixture_tool",
          content: [{ type: "text", text: "Historical fixture result." }],
          isError: false,
          timestamp: 2,
        },
        assistant(model.id, [
          call("native", { query: "current" }, "bmF0aXZl"),
          call("parallel", { query: "parallel" }),
        ]),
        ...["native", "parallel"].map((toolCallId) => ({
          role: "toolResult" as const,
          toolCallId,
          toolName: "fixture_tool",
          content: [{ type: "text" as const, text: "Current fixture result." }],
          isError: false,
          timestamp: 3,
        })),
      ],
    };
    const before = JSON.stringify(context);
    let body:
      | {
          contents: Array<{
            parts: Array<{ functionCall?: { name: string }; thoughtSignature?: string }>;
          }>;
        }
      | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Ready"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const onPayload = vi.fn();
    try {
      const events = observedPiStream(
        builtinModels(),
        model,
        context,
        { apiKey: "fixture-key", onPayload, maxRetries: 0 },
        () => undefined,
      );
      const result = await events.result();
      expect(result.stopReason).toBe("stop");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(onPayload).toHaveBeenCalledOnce();
      expect(
        body?.contents.flatMap((content) => content.parts).filter((part) => part.functionCall),
      ).toMatchObject([
        {
          functionCall: { name: "fixture_tool", args: { query: "earlier" } },
          thoughtSignature: "skip_thought_signature_validator",
        },
        {
          functionCall: { name: "fixture_tool", args: { query: "current" } },
          thoughtSignature: "bmF0aXZl",
        },
        { functionCall: { name: "fixture_tool", args: { query: "parallel" } } },
      ]);
      const calls = body?.contents
        .flatMap((content) => content.parts)
        .filter((part) => part.functionCall);
      expect(calls?.[2]).not.toHaveProperty("thoughtSignature");
      expect(JSON.stringify(body)).toContain("Historical fixture result.");
      expect(JSON.stringify(context)).toBe(before);
    } finally {
      fetchMock.mockRestore();
    }
  },
);

it("leaves native-only history and other protocols unchanged", () => {
  const options = { apiKey: "fixture-key" };
  const context: Context = { messages: [assistant(model.id, [call("native", {})])] };
  expect(withGoogleToolHistory(model, context, options)).toBe(options);
  expect(
    withGoogleToolHistory(
      { ...model, api: "openai-completions" },
      { messages: [assistant("other", [call("foreign", {})])] },
      options,
    ),
  ).toBe(options);
});

it("does not repair an ambiguous argument object shared with native history", async () => {
  const args = {};
  const context: Context = {
    messages: [
      assistant("other", [call("foreign", args)]),
      assistant(model.id, [call("native", args)]),
    ],
  };
  const payload = {
    contents: [{ role: "model", parts: [{ functionCall: { name: "fixture_tool", args } }] }],
  };
  const replacement = { fixture: true };
  const onPayload = vi.fn(() => replacement);
  const options = withGoogleToolHistory(model, context, { onPayload });
  expect(await options.onPayload?.(payload, model)).toBe(replacement);
  expect(payload.contents[0]?.parts[0]).not.toHaveProperty("thoughtSignature");
  expect(onPayload).toHaveBeenCalledOnce();
});
