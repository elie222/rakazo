import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  tools: [] as Array<{
    name: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
  invoke: {
    name: "destination_write",
    args: { collection: "notes", title: "Result", body: "Done" } as Record<string, unknown>,
  },
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      const target =
        this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
      if (!target) throw new Error("expected tool was not exposed");
      const rawArgs = fakeAgentState.invoke.args;
      const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
      await target.execute("call-1", args);
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "dispatch-test-model" ? { provider: "test", id: modelId } : undefined,
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const destinationTool: ConnectorTool = {
  name: "destination.write",
  description: "Write a record to the connected destination",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
};

const writeFileTool: ConnectorTool = {
  name: "write_file",
  description: "Write a UTF-8 file into this bot's home.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

describe("Pi connector tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.tools = [];
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
  });

  it("exposes a provider-safe name while executing the original connector name", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "write the result",
        instructions: "Use destination_write for connected destination records.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        workspaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(fakeAgentState.tools.map((tool) => tool.name)).toEqual(["destination_write"]);
    expect(executeTool).toHaveBeenCalledWith(
      "destination.write",
      { collection: "notes", title: "Result", body: "Done" },
      "call-1",
    );
  });

  it("serialises object content instead of writing [object Object] for write_file", async () => {
    fakeAgentState.invoke = {
      name: "write_file",
      args: { path: "shared/state.json", content: { last_run: 1_787_648_953 } },
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "save the state file",
        instructions: "Use write_file to save state.",
        history: [],
        tools: [writeFileTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2",
        traceId: "2",
        workspaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so tool execution completes.
    }

    expect(executeTool).toHaveBeenCalledWith(
      "write_file",
      {
        path: "shared/state.json",
        content: '{\n  "last_run": 1787648953\n}',
      },
      "call-1",
    );
  });
});
