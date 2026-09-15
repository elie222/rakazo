import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { conversationSessionId, isOpenCodeProvider, reliableStreamOptions } from "./pi-runtime.js";
import { MODEL_STREAM_MAX_RETRIES, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";

const streamDefaults = {
  timeoutMs: MODEL_STREAM_TIMEOUT_MS,
  maxRetries: MODEL_STREAM_MAX_RETRIES,
  maxTokens: DEFAULT_MODEL_MAX_TOKENS,
};

describe("Pi runtime transport", () => {
  it.each([
    { source: "provider", provider: "openai-codex", api: "openai-completions" },
    { source: "API", provider: "custom-provider", api: "openai-codex-responses" },
  ])("forces SSE when Codex is identified by $source", ({ provider, api }) => {
    const model = { provider, api } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto", maxRetries: 4 })).toEqual({
      ...streamDefaults,
      transport: "sse",
      maxRetries: 4,
    });
  });

  it("applies a stream timeout and output cap without changing other transports", () => {
    const model = {
      provider: "openrouter",
      api: "openai-completions",
      maxTokens: 128_000,
    } as Model<Api>;
    const options = { transport: "auto" as const, maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toEqual({
      transport: "auto",
      maxRetries: 2,
      timeoutMs: MODEL_STREAM_TIMEOUT_MS,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    });
  });

  it("keeps a configured maxTokens as the escape hatch", () => {
    const model = {
      provider: "openrouter",
      api: "openai-completions",
      maxTokens: 128_000,
    } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto" }, 8_192)?.maxTokens).toBe(8_192);
  });

  it.each(["opencode", "opencode-go"] as const)(
    "attaches a sticky OpenCode session header for %s",
    (provider) => {
      const model = { provider, api: "openai-completions" } as Model<Api>;
      const options = {
        sessionId: "thread-1:bot-1",
        transport: "auto" as const,
        headers: { "X-Custom": "1" },
      };

      expect(isOpenCodeProvider(provider)).toBe(true);
      expect(reliableStreamOptions(model, options)).toEqual({
        ...streamDefaults,
        sessionId: "thread-1:bot-1",
        transport: "auto",
        headers: {
          "x-opencode-session": "thread-1:bot-1",
          "x-opencode-client": "rakazo",
          "X-Custom": "1",
        },
      });
    },
  );

  it("generates an OpenCode session id when the agent did not provide one", () => {
    const model = { provider: "opencode-go", api: "openai-completions" } as Model<Api>;
    const result = reliableStreamOptions(model, { transport: "auto" });

    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.headers?.["x-opencode-session"]).toBe(result.sessionId);
    expect(result.headers?.["x-opencode-client"]).toBe("rakazo");
    expect(result.timeoutMs).toBe(MODEL_STREAM_TIMEOUT_MS);
  });

  it("keeps a stable conversation session id per bot thread", () => {
    expect(conversationSessionId("thread-1", "bot-1")).toBe("thread-1:bot-1");
    expect(conversationSessionId("thread-1", "bot-1", "sub-1")).toBe("thread-1:bot-1:sub-1");
  });
});
