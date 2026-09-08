import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { conversationSessionId, isOpenCodeProvider, reliableStreamOptions } from "./pi-runtime.js";

describe("Pi runtime transport", () => {
  it.each([
    { source: "provider", provider: "openai-codex", api: "openai-completions" },
    { source: "API", provider: "custom-provider", api: "openai-codex-responses" },
  ])("forces SSE when Codex is identified by $source", ({ provider, api }) => {
    const model = { provider, api } as Model<Api>;

    expect(reliableStreamOptions(model, { transport: "auto", maxRetries: 4 })).toEqual({
      transport: "sse",
      maxRetries: 4,
    });
  });

  it("leaves other provider transports unchanged", () => {
    const model = { provider: "openrouter", api: "openai-completions" } as Model<Api>;
    const options = { transport: "auto" as const, maxRetries: 2 };

    expect(reliableStreamOptions(model, options)).toBe(options);
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

    expect(result?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result?.headers?.["x-opencode-session"]).toBe(result?.sessionId);
    expect(result?.headers?.["x-opencode-client"]).toBe("rakazo");
  });

  it("keeps a stable conversation session id per bot thread", () => {
    expect(conversationSessionId("thread-1", "bot-1")).toBe("thread-1:bot-1");
    expect(conversationSessionId("thread-1", "bot-1", "sub-1")).toBe("thread-1:bot-1:sub-1");
  });
});
