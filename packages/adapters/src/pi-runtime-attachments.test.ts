import { beforeEach, describe, expect, it, vi } from "vitest";

const promptCalls = vi.hoisted(() => ({
  images: [] as Array<{ type: "image"; data: string; mimeType: string }> | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    subscribe() {}
    async prompt(
      _input: string,
      images?: Array<{ type: "image"; data: string; mimeType: string }>,
    ) {
      promptCalls.images = images;
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "vision-test-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("provider should not be called");
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

describe("Pi runtime attachments", () => {
  beforeEach(() => {
    promptCalls.images = undefined;
  });

  it("forwards current-turn images to agent.prompt", async () => {
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "what is in this image?",
        instructions: "test",
        history: [],
        currentTurnImages: [
          {
            name: "shot.png",
            mimeType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
          },
        ],
        tools: [],
        model: { provider: "test", id: "vision-test-model" },
      },
      {
        operationId: "attachment-test",
        traceId: "attachment-test",
        workspaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // exhaust runtime
    }

    expect(promptCalls.images).toEqual([
      {
        type: "image",
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });
});
