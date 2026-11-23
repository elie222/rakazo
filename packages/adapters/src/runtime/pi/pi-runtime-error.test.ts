import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import {
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_CREDITS_EXHAUSTED_ERROR,
  MODEL_OUTPUT_LIMIT_ERROR,
  MODEL_UNPRICED_FOR_CREDITS_ERROR,
  modelFallbackFailure,
} from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ errorMessage: "", rejectRequest: false, status: 400 }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: provider.errorMessage, messages: [] as unknown[] };
    constructor(
      private readonly options: {
        streamFn: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>;
      },
    ) {}

    subscribe() {}
    async prompt() {
      if (!provider.rejectRequest) return;
      const stream = this.options.streamFn(
        undefined,
        { systemPrompt: "SYSTEM-PROMPT-secret", messages: [] },
        {},
      );
      // Drain the request so its response hooks run; the agent keeps the failed reply.
      for await (const event of stream as AsyncIterable<{ type: string; error?: unknown }>) {
        if (event.type === "error") this.state.messages.push(event.error);
      }
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  return {
    builtinModels: () => ({
      getModel: () => ({
        provider: "openai-codex",
        id: "gpt-test",
        api: "openai-codex-responses",
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 32_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      streamSimple: (
        model: { provider: string; id: string },
        _context: unknown,
        options: {
          onPayload?: (body: unknown, model: unknown) => unknown;
          onResponse?: (response: unknown, model: unknown) => unknown;
        },
      ) => {
        const stream = new AssistantMessageEventStream();
        void (async () => {
          await options.onPayload?.(
            {
              model: model.id,
              instructions: "SYSTEM-PROMPT-secret",
              input: [{ role: "user", content: [{ type: "input_text", text: "PROMPT-secret" }] }],
              reasoning: { effort: "high" },
            },
            model,
          );
          await options.onResponse?.({ status: provider.status, headers: {} }, model);
          const error = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: '{"detail":"Bad Request"}',
            api: "openai-codex-responses",
            provider: model.provider,
            model: model.id,
            usage: {},
            timestamp: 0,
          };
          stream.push({ type: "error", reason: "error", error } as never);
          stream.end(error as never);
        })();
        return stream;
      },
    }),
  };
});

vi.mock("./models/pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { rejectedRequestsOf } from "../provider-request-shape.js";
import { PiAgentRuntime } from "./pi-runtime.js";

function consume(model = { provider: "openai-codex", id: "gpt-test" }) {
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
        model,
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
    provider.rejectRequest = false;
    provider.status = 400;
  });

  it("attaches the shape of a request a provider rejected for no known reason", async () => {
    provider.errorMessage = '{"detail":"Bad Request"}';
    provider.rejectRequest = true;
    const error = await consume().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ModelAccountError);
    const rejection = rejectedRequestsOf(error);
    expect(rejection).toHaveLength(1);
    expect(rejection?.[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-test",
      status: 400,
      body: {
        params: { model: "gpt-test", "reasoning.effort": "high" },
        messages: { count: 1, items: ["user:input_text"] },
      },
    });
    expect(JSON.stringify(rejection)).not.toMatch(/secret/);
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
    'Headers.append: "example key\nclient = Client(timeout=30, rate_limit=1)" is an invalid header value.',
    '413: {"message":"Request too large for model `example/model` on tokens per minute (TPM)."}',
    MODEL_CONTEXT_TOO_SMALL_ERROR,
    "Prompt tokens limit exceeded: 11298 > 992. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    MODEL_CREDITS_EXHAUSTED_ERROR,
    MODEL_UNPRICED_FOR_CREDITS_ERROR,
    `400: {"type":"server_error","message":"Upstream request failed: This example model requires Global regions. Select Global in your workspace's Privacy settings to use it."}`,
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
    '400 {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"example upstream failure\\"}}","provider_name":"ExampleUpstream","is_byok":false}}',
  ])("marks a provider account failure the user can fix: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    "Provider finish_reason: error",
    "Provider returned an empty response",
    '500: {"message":"unexpected tokens remaining in message header: Some(\\"analysis\\")"}',
    'unexpected tokens remaining in message header: Some("credit limit, timeout, model not found")',
    '400 {"type":"error","error":{"type":"api_error","message":"Upstream request failed: [api_error] Upstream response was not valid JSON"}}',
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
    '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"code\\":400,\\"msg\\":\\"bad request\\"}"}}',
    "Internal failure while handling unexpected tokens remaining in message header: unknown",
  ])("keeps a request we built or an unknown failure ordinary: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    ["openai-compatible", "example-model"],
    ["local", "example-local"],
  ])(
    "marks a request the user's own %s endpoint rejects as theirs to fix",
    async (endpoint, id) => {
      provider.errorMessage = '400 "Invalid request parameters"';
      const failure = consume({ provider: endpoint, id });
      await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
      await expect(failure).rejects.toThrow("Invalid request parameters");
    },
  );

  it.each([
    ["openai-compatible", "example-model"],
    ["local", "example-local"],
  ])(
    "marks a failure the user's own %s endpoint reports after accepting the request as transient",
    async (endpoint, id) => {
      provider.errorMessage = "This model is offline right now; try again or pick another";
      provider.rejectRequest = true;
      provider.status = 200;
      const failure = consume({ provider: endpoint, id });
      await expect(failure).rejects.toBeInstanceOf(TransientModelError);
      await expect(failure).rejects.toThrow("This model is offline right now");
    },
  );

  it("keeps an unexplained failure from the user's own endpoint a server error when it never answered", async () => {
    provider.errorMessage = "This model is offline right now; try again or pick another";
    const failure = consume({ provider: "openai-compatible", id: "example-model" });
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
  });

  it("keeps a named provider's failure after accepting the request a server error", async () => {
    provider.errorMessage = "This model is offline right now; try again or pick another";
    provider.rejectRequest = true;
    provider.status = 200;
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
  });

  it("keeps a named provider's bare 400 a server error, since Rakazo may have built it wrong", async () => {
    provider.errorMessage = '400 "Invalid request parameters"';
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    // The Google SDK reports a stream that closed partway through an event this way.
    "Incomplete JSON segment at the end",
    "OpenCode rejected this chat session. Send the message again.",
    "The upstream model provider could not complete this request. Please retry shortly.",
    "server_error: The model failed to generate a response.",
  ])("keeps a dropped connection transient: %s", async (message) => {
    provider.errorMessage = message;
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });

  it.each(["ResourceExhausted: Worker local total request limit reached (4358/16)"])(
    "treats a provider concurrency limit as transient: %s",
    async (message) => {
      provider.errorMessage = message;
      await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
    },
  );
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
      "a provider out of credits backed by a key the provider rejects",
      exhausted('402: {"message":"Add usage credits to use cloud models."}', [
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."}}',
      ]),
      ModelAccountError,
    ],
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

  it("credits a backup's bare 400 to its own endpoint, not to the primary's provider", async () => {
    const rejected = '400 "Invalid request parameters"';
    const chain = (backupProvider: string) =>
      modelFallbackFailure(timedOut, [
        { provider: backupProvider, modelId: "example", status: "failed", reason: rejected },
      ]);
    provider.errorMessage = chain("openai-compatible");
    await expect(consume()).rejects.toBeInstanceOf(ModelAccountError);
    provider.errorMessage = chain("fake-provider");
    await expect(consume()).rejects.not.toBeInstanceOf(ModelAccountError);
  });

  it("keeps the chain a server error when any failure is unexplained", async () => {
    provider.errorMessage = exhausted(timedOut, [freeTier, unknown]);
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
  });
});
