import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import { MODEL_CONTEXT_TOO_SMALL_ERROR, MODEL_OUTPUT_LIMIT_ERROR } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ errorMessage: "" }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: provider.errorMessage, messages: [] };

    subscribe() {}
    async prompt() {}
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: () => ({ provider: "openai-codex", id: "gpt-test" }),
    streamSimple: vi.fn(),
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

function consume() {
  const runtime = new PiAgentRuntime();
  return (async () => {
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "continue",
        instructions: "test",
        history: [],
        tools: [],
        model: { provider: "openai-codex", id: "gpt-test" },
      },
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // Consume the stream so terminal failures surface to the executor.
    }
  })();
}

describe("Pi runtime errors", () => {
  beforeEach(() => {
    provider.errorMessage = "Request was aborted by policy";
  });

  it("propagates provider failures instead of completing with error text", async () => {
    const failure = consume();
    await expect(failure).rejects.toThrow("Request was aborted by policy");
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it("marks a provider overload that outlasted its retries as transient", async () => {
    provider.errorMessage =
      "Codex error: Our servers are currently overloaded. Please try again later.";
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.toThrow("overloaded");
  });

  it.each([
    '401: {"message":"Invalid API-key provided.","type":"invalid_request_error"}',
    '402: {"message":"This request requires more credits.","code":402}',
    "You have no credits remaining. Add credits to continue using the API.",
    'xai API error (400): 400 "Incorrect API key provided."',
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}',
    'opencode API error (410): {"type":"ModelDeprecated","message":"Model example-free has been deprecated."}',
    '404: {"message":"No endpoints found that support tool use.","code":404}',
    '400: {"message":"`tool calling` is not supported with this model","type":"invalid_request_error"}',
    '413: {"message":"Request too large for model `example/model` on tokens per minute (TPM)."}',
    MODEL_CONTEXT_TOO_SMALL_ERROR,
  ])("marks a provider account failure the user can fix: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    "Provider finish_reason: error",
    "Provider stopped with: MALFORMED_FUNCTION_CALL",
    "Provider returned an empty response",
    "Failed to parse tool call arguments as JSON",
    "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
    MODEL_OUTPUT_LIMIT_ERROR,
  ])("marks unusable model output as the model's failure: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    '400: {"message":"Unexpected message role.","type":"invalid_request_error"}',
    '{"error":{"message":"Function call is missing a thought_signature in functionCall parts.","code":400}}',
    '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"The `uniqueItems` JSON Schema keyword is not supported."}}',
    "Cannot read properties of undefined (reading 'content')",
  ])("keeps a request we built or an unknown failure ordinary: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    "WebSocket closed 1006",
    // The Google SDK reports a stream that closed partway through an event this way.
    "Incomplete JSON segment at the end",
    "OpenCode rejected this chat session. Send the message again.",
  ])("keeps a dropped connection transient: %s", async (message) => {
    provider.errorMessage = message;
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });
});
