import { describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  thinkingLevel: undefined as string | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };

    constructor(options: { initialState: { thinkingLevel: string } }) {
      fakeAgentState.thinkingLevel = options.initialState.thinkingLevel;
    }

    subscribe(_listener: unknown) {}
    async prompt() {}
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => {
      if (modelId === "reasoning-model") return { provider: "test", id: modelId, reasoning: true };
      if (modelId === "plain-model") return { provider: "test", id: modelId, reasoning: false };
      return undefined;
    },
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./local-providers.js", () => ({
  withLocalProviders: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

async function runWithModel(modelId: string) {
  const runtime = new PiAgentRuntime();
  for await (const _event of runtime.run(
    {
      botId: "b",
      threadId: "t",
      runId: "r",
      prompt: "hello",
      instructions: "",
      history: [],
      tools: [],
      model: { provider: "test", id: modelId },
      executeTool: vi.fn(async () => ({ ok: true })),
    },
    {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    },
  )) {
    // Exhaust the runtime event stream so the run completes.
  }
  return fakeAgentState.thinkingLevel;
}

describe("Pi agent thinking level", () => {
  it("enables reasoning for a model configured with reasoning support", async () => {
    expect(await runWithModel("reasoning-model")).not.toBe("off");
  });

  it("keeps reasoning off for a model without reasoning support", async () => {
    expect(await runWithModel("plain-model")).toBe("off");
  });
});
