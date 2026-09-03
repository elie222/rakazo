import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  thinkingLevels: [] as string[],
  models: [] as Array<{
    id: string;
    provider: string;
    reasoning: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>,
  sessionIds: [] as Array<string | undefined>,
  failPrompt: false,
}));

type FakeAgentTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: FakeAgentTool[];

    constructor(options: {
      sessionId?: string;
      initialState: {
        thinkingLevel: string;
        tools: FakeAgentTool[];
        model: (typeof fakeAgentState.models)[number];
      };
    }) {
      this.tools = options.initialState.tools;
      fakeAgentState.sessionIds.push(options.sessionId);
      fakeAgentState.thinkingLevels.push(options.initialState.thinkingLevel);
      fakeAgentState.models.push(options.initialState.model);
    }

    subscribe(_listener: unknown) {}
    async prompt() {
      if (fakeAgentState.failPrompt) throw new Error("prompt failed");
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
      if (modelId === "grok-4.6") {
        return {
          provider: "xai",
          id: modelId,
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: null,
          },
        };
      }
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

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

async function runWithModel(
  modelId: string,
  provider = "test",
  signal = new AbortController().signal,
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null,
) {
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
      model: { provider, id: modelId, thinkingLevel },
      executeTool: vi.fn(async () => ({ ok: true })),
    },
    {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal,
    },
  )) {
    // Exhaust the runtime event stream so the run completes.
  }
  return fakeAgentState.thinkingLevels;
}

describe("Pi agent thinking level", () => {
  beforeEach(() => {
    fakeAgentState.thinkingLevels = [];
    fakeAgentState.models = [];
    fakeAgentState.sessionIds = [];
    fakeAgentState.failPrompt = false;
    vi.unstubAllEnvs();
  });

  it("uses medium reasoning for the main agent and subagent", async () => {
    // Regression for OpenRouter mandatory-reasoning models (#114): forcing
    // thinkingLevel "off" becomes effort "none" and the provider returns 400.
    const levels = await runWithModel("reasoning-model");
    expect(levels).toEqual(["medium", "medium"]);
    expect(levels.every((level) => level !== "off")).toBe(true);
  });

  it("uses a stable provider session for each bot thread", async () => {
    await runWithModel("plain-model");

    expect(fakeAgentState.sessionIds[0]).toBe("t:b");
  });

  it("honors a per-bot thinking level on reasoning models", async () => {
    const levels = await runWithModel("grok-4.6", "xai", new AbortController().signal, "high");
    expect(levels).toEqual(["high", "high"]);
  });

  it("keeps reasoning off for the main agent and subagent", async () => {
    expect(await runWithModel("plain-model")).toEqual(["off", "off"]);
  });

  it("normalizes and runs a configured OpenRouter model absent from the static catalog", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
    vi.stubEnv("PI_DEFAULT_MODEL", "  stealth/ox-alpha  ");

    const levels = await runWithModel("  stealth/ox-alpha  ", "openrouter");

    expect(fakeAgentState.models).toHaveLength(2);
    expect(fakeAgentState.models[0]).toMatchObject({
      id: "stealth/ox-alpha",
      provider: "openrouter",
      reasoning: true,
      contextWindow: 16_384,
      maxTokens: 4_096,
    });
    // Unknown OpenRouter PI_DEFAULT_MODEL must not force thinking off (#114).
    expect(levels).toEqual(["medium", "medium"]);
    expect(levels.every((level) => level !== "off")).toBe(true);
  });

  it("uses the trimmed configured default for scripted requests", async () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "  stealth/ox-alpha  ");

    await runWithModel("scripted", "scripted");

    expect(fakeAgentState.models[0]?.id).toBe("stealth/ox-alpha");
  });

  it("removes the abort listener when prompting fails", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    fakeAgentState.failPrompt = true;

    await expect(runWithModel("plain-model", "test", controller.signal)).rejects.toThrow(
      "prompt failed",
    );

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
