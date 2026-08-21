import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { isMissingFinishReasonError, PiAgentRuntime } from "./pi-runtime.js";

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = {
      errorMessage: "Stream ended without finish_reason",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "The gateway already sent this reply." }],
        },
      ],
    };
    subscribe() {}
    async prompt() {}
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "flash" ? { provider: "gateway:test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("provider should not be called");
    },
  }),
}));

const tools: ConnectorTool[] = [];

describe("missing streamed finish_reason", () => {
  it("recognizes the Pi protocol error", () => {
    expect(isMissingFinishReasonError("Stream ended without finish_reason")).toBe(true);
    expect(isMissingFinishReasonError("Provider finish_reason: length")).toBe(false);
  });

  it("keeps the model reply instead of posting I hit a problem", async () => {
    const runtime = new PiAgentRuntime();
    const events: Array<{ type?: string; text?: string }> = [];
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "hello",
        instructions: "Be concise.",
        history: [],
        tools,
        model: { provider: "gateway:test", id: "flash" },
      },
      {
        operationId: "stream-close",
        traceId: "stream-close",
        workspaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.text?.includes("I hit a problem"))).toBe(false);
    expect(events.some((event) => event.text === "The gateway already sent this reply.")).toBe(
      true,
    );
    expect(events.at(-1)?.type).toBe("done");
  });
});
