import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  mode: "dispatch" as "dispatch" | "subagent-limit",
  abortCount: 0,
  tools: [] as Array<{
    name: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: typeof fakeAgentState.tools;
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];
    private aborted = false;

    constructor(options: { initialState: { tools: typeof fakeAgentState.tools } }) {
      this.tools = options.initialState.tools;
      fakeAgentState.tools = this.tools;
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    async prompt() {
      if (fakeAgentState.mode === "dispatch") {
        const destination = this.tools.find((tool) => tool.name === "destination_write");
        if (!destination) throw new Error("sanitized destination tool was not exposed");
        const rawArgs = { collection: "notes", title: "Result", body: "Done" };
        const args = destination.prepareArguments?.(rawArgs) ?? rawArgs;
        await destination.execute("call-1", args);
        return;
      }

      const delegation = this.tools.find((tool) => tool.name === "run_subagent");
      if (delegation) {
        const args = { name: "loop", task: "keep calling shell" };
        this.emit({ type: "tool_execution_start", toolName: delegation.name, args });
        await delegation.execute("delegate-1", args);
        return;
      }

      const shell = this.tools.find((tool) => tool.name === "shell");
      if (!shell) throw new Error("shell was not exposed to the subagent");
      for (let index = 0; index < 100; index += 1) {
        const args = { command: `echo ${index}` };
        this.emit({ type: "tool_execution_start", toolName: shell.name, args });
        if (this.aborted) break;
        await shell.execute(`shell-${index}`, args);
      }
    }

    async waitForIdle() {}

    abort() {
      this.aborted = true;
      fakeAgentState.abortCount += 1;
    }

    private emit(event: Record<string, unknown>) {
      for (const listener of this.listeners) listener(event);
    }
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
  route: { connectorId: "destination", toolName: "destination.write" },
};

describe("Pi connector tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.mode = "dispatch";
    fakeAgentState.abortCount = 0;
    fakeAgentState.tools = [];
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
      { connectorId: "destination", toolName: "destination.write" },
    );
  });

  it("shares the tool-call budget with subagents", async () => {
    fakeAgentState.mode = "subagent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "limited",
        prompt: "delegate the loop",
        instructions: "Use run_subagent.",
        history: [],
        tools: [
          {
            name: "run_subagent",
            description: "Delegate work",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "shell",
            description: "Run a command",
            inputSchema: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
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
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(79);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
  });
});
