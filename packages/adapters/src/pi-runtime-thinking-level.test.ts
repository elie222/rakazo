import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  thinkingLevels: [] as string[],
}));

type FakeAgentTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: FakeAgentTool[];

    constructor(options: { initialState: { thinkingLevel: string; tools: FakeAgentTool[] } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.thinkingLevels.push(options.initialState.thinkingLevel);
    }

    subscribe(_listener: unknown) {}
    async prompt() {
      const runSubagent = this.tools.find((tool) => tool.name === "run_subagent");
      await runSubagent?.execute("subagent-call", { name: "helper", task: "help" });
    }
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

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
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
  return fakeAgentState.thinkingLevels;
}

describe("Pi agent thinking level", () => {
  beforeEach(() => {
    fakeAgentState.thinkingLevels = [];
  });

  it("uses medium reasoning for the main agent and subagent", async () => {
    expect(await runWithModel("reasoning-model")).toEqual(["medium", "medium"]);
  });

  it("keeps reasoning off for the main agent and subagent", async () => {
    expect(await runWithModel("plain-model")).toEqual(["off", "off"]);
  });
});
