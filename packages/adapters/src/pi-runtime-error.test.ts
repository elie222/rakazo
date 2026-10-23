import { ModelAccountError, TransientModelError } from "@rakazo/adapter-kit";
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
  ])("marks a provider account failure the user can fix: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.toThrow(message);
  });

  it("keeps a malformed request as an ordinary failure", async () => {
    provider.errorMessage =
      '400: {"message":"Unexpected message role.","type":"invalid_request_error"}';
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it("keeps a dropped connection transient", async () => {
    provider.errorMessage = "WebSocket closed 1006";
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });
});
