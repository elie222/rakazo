import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import {
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_OUTPUT_LIMIT_ERROR,
  modelFallbackFailure,
} from "@rakazo/core";
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
    "Your authentication token has expired. Please try refreshing it.",
    "Provided authentication token is expired.",
    "Encountered invalidated oauth token for user, failing request",
    'Headers.append: "example key\nclient = Client(timeout=30, rate_limit=1)" is an invalid header value.',
    "Cannot convert argument to a ByteString because the character at index 0 has a value of 48120 which is greater than 255.",
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}',
    'opencode API error (410): {"type":"ModelDeprecated","message":"Model example-free has been deprecated."}',
    '404: {"message":"No endpoints found that support tool use.","code":404}',
    '400: {"message":"`tool calling` is not supported with this model","type":"invalid_request_error"}',
    `400: {"message":"feature 'tool calls' is not currently supported"}`,
    '413: {"message":"Request too large for model `example/model` on tokens per minute (TPM)."}',
    MODEL_CONTEXT_TOO_SMALL_ERROR,
    '400: {"code":"400","message":"Unsupported model example-model"}',
    '400: {"message":"The model `example/model` requires terms acceptance.","type":"invalid_request_error","code":"model_terms_required"}',
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
  ])("marks a provider account failure the user can fix: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    "Provider finish_reason: error",
    "Provider stopped with: MALFORMED_FUNCTION_CALL",
    "Unhandled stop reason: MALFORMED_RESPONSE",
    "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
    "Provider returned an empty response",
    "Failed to parse tool call arguments as JSON",
    "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
    MODEL_OUTPUT_LIMIT_ERROR,
    "Upstream error from Example: HttpError: HTTP 400: Tool calls cutoff by max_tokens.",
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

  it.each([
    "ResourceExhausted: Worker local total request limit reached (16/16)",
    "ResourceExhausted: Worker local total request limit reached (4358/16)",
  ])("treats a provider concurrency limit as transient: %s", async (message) => {
    provider.errorMessage = message;
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });
});

describe("Pi runtime errors after every backup failed", () => {
  const timedOut = "Request timed out.";
  const freeTier =
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}';
  const unknown = "Cannot read properties of undefined (reading 'content')";
  const emptyReply = "Provider returned an empty response";
  const dailyQuota = `429 ${JSON.stringify({
    error: {
      message: "Rate limit exceeded: free-models-per-day",
      code: 429,
      metadata: { headers: { "X-RateLimit-Reset": String(Date.now() + 10 * 60 * 60_000) } },
    },
  })}`;
  const rateLimited =
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}';

  function exhausted(primaryError: string, reasons: string[], skipped: string[] = []) {
    return modelFallbackFailure(primaryError, [
      ...reasons.map((reason, index) => ({
        provider: "fake-provider",
        modelId: `fake-model-${index}`,
        status: "failed" as const,
        reason,
      })),
      ...skipped.map((reason, index) => ({
        provider: "fake-provider",
        modelId: `fake-skipped-${index}`,
        status: "skipped" as const,
        reason,
      })),
    ]);
  }

  it.each([
    ["every model timed out", exhausted(timedOut, [timedOut, timedOut]), TransientModelError],
    [
      "skipped backups do not count",
      exhausted(timedOut, [timedOut], [unknown]),
      TransientModelError,
    ],
    ["every model refused the account", exhausted(freeTier, [freeTier]), ModelAccountError],
    [
      "an account failure outranks timeouts",
      exhausted(timedOut, [timedOut, freeTier]),
      ModelAccountError,
    ],
    [
      "a quota that resets hours away outranks a rate-limited backup",
      exhausted(dailyQuota, [rateLimited]),
      ModelAccountError,
    ],
    ["bad output outranks timeouts", exhausted(timedOut, [emptyReply]), ModelOutputError],
    [
      "an account failure outranks bad output",
      exhausted(emptyReply, [freeTier]),
      ModelAccountError,
    ],
  ])("classifies the chain when %s", async (_label, message, kind) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(kind);
    await expect(failure).rejects.toThrow(message);
  });

  it("keeps the chain a server error when any failure is unexplained", async () => {
    provider.errorMessage = exhausted(timedOut, [freeTier, unknown]);
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
  });
});
