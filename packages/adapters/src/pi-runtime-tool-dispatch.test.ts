import type { ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  mode: "dispatch" as "dispatch" | "empty" | "two-boundaries" | "subagent-limit" | "parent-limit",
  abortCount: 0,
  tools: [] as Array<{
    name: string;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>,
  invoke: {
    name: "destination_write",
    args: { collection: "notes", title: "Result", body: "Done" } as Record<string, unknown>,
  },
  preparedMessages: [] as unknown[],
  steeredMessages: [] as unknown[],
  initialMessages: [] as unknown[],
  promptInputs: [] as string[],
  promptImages: [] as unknown[][],
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: typeof fakeAgentState.tools;
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];
    private readonly prepareNextTurnWithContext?: (input: {
      context: { messages: unknown[] };
    }) => Promise<{ context?: { messages: unknown[] } } | undefined>;
    private aborted = false;

    constructor(options: {
      initialState: { tools: typeof fakeAgentState.tools; messages: unknown[] };
      prepareNextTurnWithContext?: (input: {
        context: { messages: unknown[] };
      }) => Promise<{ context?: { messages: unknown[] } } | undefined>;
    }) {
      this.tools = options.initialState.tools;
      this.prepareNextTurnWithContext = options.prepareNextTurnWithContext;
      fakeAgentState.tools = this.tools;
      fakeAgentState.initialMessages = options.initialState.messages;
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }

    async prompt(prompt: string, images?: unknown[]) {
      fakeAgentState.promptInputs.push(prompt);
      fakeAgentState.promptImages.push(images ?? []);
      if (fakeAgentState.mode === "empty" || fakeAgentState.mode === "two-boundaries") {
        await this.prepareNextTurnWithContext?.({ context: { messages: [] } });
        if (fakeAgentState.mode === "two-boundaries") {
          await this.prepareNextTurnWithContext?.({ context: { messages: [] } });
        }
        fakeAgentState.preparedMessages = [...fakeAgentState.steeredMessages];
        return;
      }

      if (fakeAgentState.mode === "dispatch") {
        const target =
          this.tools.find((tool) => tool.name === fakeAgentState.invoke.name) ?? this.tools[0];
        if (!target) throw new Error("expected tool was not exposed");
        const rawArgs = fakeAgentState.invoke.args;
        const args = target.prepareArguments?.(rawArgs) ?? rawArgs;
        this.emit({ type: "tool_execution_start", toolName: target.name, args });
        await target.execute("call-1", args);
        return;
      }

      if (fakeAgentState.mode === "parent-limit") {
        const shell = this.tools.find((tool) => tool.name === "shell");
        if (!shell) throw new Error("shell was not exposed");
        for (let index = 0; index < 100; index += 1) {
          const args = { command: `echo ${index}` };
          this.emit({ type: "tool_execution_start", toolName: shell.name, args });
          if (this.aborted) break;
          await shell.execute(`shell-${index}`, args);
        }
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

    steer(message: unknown) {
      fakeAgentState.steeredMessages.push(message);
    }

    abort() {
      this.aborted = true;
      // Mirror pi-agent-core: abort settles the run with an errorMessage that
      // would otherwise make PiAgentRuntime throw and skip a final reply.
      this.state.errorMessage = "Request aborted by user";
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

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { maxToolCallsPerTurn, PiAgentRuntime } from "./pi-runtime.js";

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

const shellTool = {
  name: "shell",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
};

const previousMaxToolCalls = process.env.MAX_TOOL_CALLS_PER_TURN;

describe("Pi connector tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.mode = "dispatch";
    fakeAgentState.abortCount = 0;
    fakeAgentState.tools = [];
    fakeAgentState.preparedMessages = [];
    fakeAgentState.steeredMessages = [];
    fakeAgentState.initialMessages = [];
    fakeAgentState.promptInputs = [];
    fakeAgentState.promptImages = [];
    fakeAgentState.invoke = {
      name: "destination_write",
      args: { collection: "notes", title: "Result", body: "Done" },
    };
    delete process.env.MAX_TOOL_CALLS_PER_TURN;
  });

  it("injects durable steering at Pi's next safe turn boundary", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      return claimCount === 1
        ? []
        : [
            { id: "steering-1", messageId: "message-1", text: "Use the newer customer totals." },
            { id: "steering-2", messageId: "message-2", text: "Keep the original date range." },
          ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "prepare the report",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ role: "user", content: "Use the newer customer totals." }),
      expect.objectContaining({ role: "user", content: "Keep the original date range." }),
    ]);
  });

  it("defers steering arriving during a continuation to the following boundary", async () => {
    fakeAgentState.mode = "two-boundaries";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) return [];
      return claimCount === 2
        ? [{ id: "steering-1", messageId: "message-1", text: "First boundary context." }]
        : [{ id: "steering-2", messageId: "message-2", text: "Next boundary context." }];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "continue",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(claimSteering).toHaveBeenNthCalledWith(1, []);
    expect(claimSteering).toHaveBeenNthCalledWith(2, []);
    expect(claimSteering).toHaveBeenNthCalledWith(3, ["steering-1"]);
    expect(fakeAgentState.preparedMessages).toEqual([
      expect.objectContaining({ content: "First boundary context." }),
      expect.objectContaining({ content: "Next boundary context." }),
    ]);
  });

  it("consumes pending continuation steering once in the first prompt", async () => {
    fakeAgentState.mode = "empty";
    const steering = [
      { id: "steering-1", messageId: "message-1", text: "Use the newer customer totals." },
      { id: "steering-2", messageId: "message-2", text: "Keep the original date range." },
    ];
    const claimSteering = vi.fn(async (seenIds: string[]) => (seenIds.length ? [] : steering));
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "continuation",
        prompt: "Respond to the user's steering context.",
        instructions: "Follow the user's instructions.",
        history: [
          { id: steering[0]!.messageId, role: "user", content: steering[0]!.text },
          { id: steering[1]!.messageId, role: "user", content: steering[1]!.text },
          { role: "assistant", content: "Here is the first result." },
        ],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptInputs).toHaveLength(1);
    for (const item of steering) {
      expect(fakeAgentState.promptInputs[0]?.split(item.text)).toHaveLength(2);
      expect(JSON.stringify(fakeAgentState.initialMessages)).not.toContain(item.text);
    }
    expect(fakeAgentState.steeredMessages).toEqual([]);
  });

  it("delivers images attached to initial and boundary steering", async () => {
    fakeAgentState.mode = "empty";
    let claimCount = 0;
    const claimSteering = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return [
          {
            id: "initial-image",
            messageId: "initial-image-message",
            text: "Inspect the first image.",
            images: [
              {
                name: "first.png",
                mimeType: "image/png" as const,
                data: new Uint8Array([1, 2, 3]),
              },
            ],
          },
        ];
      }
      return [
        {
          id: "boundary-image",
          messageId: "boundary-image-message",
          text: "Compare the second image.",
          images: [
            { name: "second.png", mimeType: "image/png" as const, data: new Uint8Array([4, 5, 6]) },
          ],
        },
      ];
    });
    const runtime = new PiAgentRuntime();

    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "image-steering",
        prompt: "continue",
        instructions: "Inspect attached images.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        claimSteering,
      },
      { signal: new AbortController().signal },
    )) {
      // Exhaust the runtime event stream.
    }

    expect(fakeAgentState.promptImages).toEqual([
      [{ type: "image", data: "AQID", mimeType: "image/png" }],
    ]);
    expect(fakeAgentState.steeredMessages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare the second image." },
        { type: "image", data: "BAUG", mimeType: "image/png" },
      ],
      timestamp: expect.any(Number),
    });
  });

  afterEach(() => {
    if (previousMaxToolCalls === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
    else process.env.MAX_TOOL_CALLS_PER_TURN = previousMaxToolCalls;
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
        spaceId: "w",
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

  it("does not claim a tool-only turn finished work the model never described", async () => {
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "tool-only",
        prompt: "send the update",
        instructions: "Use the destination tool.",
        history: [],
        tools: [destinationTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "tool-only",
        traceId: "tool-only",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).not.toContainEqual({ type: "text", text: "I finished the work." });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("keeps FYI bot-message wakes silent when the model produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "bot-wake-silent",
        prompt: "[bot] FYI only",
        instructions: "Stay silent when there is nothing to do.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        allowSilentEmpty: true,
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "bot-wake-silent",
        traceId: "bot-wake-silent",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).not.toContainEqual({ type: "text", text: "No response. Try again." });
    expect(events).toEqual([{ type: "done" }]);
  });

  it("still asks the user to retry when a normal empty turn produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "user-empty",
        prompt: "hello",
        instructions: "Reply to the user.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "user-empty",
        traceId: "user-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "No response. Try again." });
    expect(events.at(-1)).toEqual({ type: "done", text: "No response. Try again." });
  });

  it("surfaces a contextual peer fallback when that run produces nothing", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-empty",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "Update from Researcher: The answer is 42.",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-empty",
        traceId: "peer-result-empty",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "Update from Researcher: The answer is 42.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "Update from Researcher: The answer is 42.",
    });
  });

  it("normalizes a blank contextual fallback", async () => {
    fakeAgentState.mode = "empty";
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "peer-result-blank",
        prompt: "[bot] result",
        instructions: "Summarize the result.",
        history: [],
        tools: [],
        model: { provider: "test", id: "dispatch-test-model" },
        emptyResponseText: "   ",
        executeTool: vi.fn(async () => ({ ok: true })),
      },
      {
        operationId: "peer-result-blank",
        traceId: "peer-result-blank",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done", text: "No response. Try again." });
  });

  it("allows more than 80 tool calls by default when no fuse is configured", async () => {
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "unlimited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2a",
        traceId: "2a",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(100);
    expect(fakeAgentState.abortCount).toBe(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining("tool calls in one turn"),
      }),
    );
  });

  it("soft-stops with a final message when MAX_TOOL_CALLS_PER_TURN is set", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
    fakeAgentState.mode = "parent-limit";
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    const events: unknown[] = [];

    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "parent-limited",
        prompt: "keep going",
        instructions: "Use shell.",
        history: [],
        tools: [shellTool],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2b",
        traceId: "2b",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(executeTool).toHaveBeenCalledTimes(80);
    expect(fakeAgentState.abortCount).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 80 tool calls in one turn.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
  });

  it("shares an optional tool-call fuse with subagents and still emits a final message", async () => {
    process.env.MAX_TOOL_CALLS_PER_TURN = "80";
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
          shellTool,
        ],
        model: { provider: "test", id: "dispatch-test-model" },
        executeTool,
      },
      {
        operationId: "2",
        traceId: "2",
        spaceId: "w",
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
    expect(events).toContainEqual({
      type: "text",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    expect(events).toContainEqual({
      type: "done",
      text: "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
    });
    const subagentEvents = events.filter(
      (event): event is { type: "subagent"; status: string; result?: string } =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event as { type?: string }).type === "subagent",
    );
    expect(subagentEvents.some((event) => event.status === "failed")).toBe(false);
    expect(subagentEvents).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        status: "completed",
        result:
          "I stopped after reaching the limit of 80 tool calls in this turn. Send another message to continue.",
      }),
    );
  });

  it("treats unset, empty, and non-positive MAX_TOOL_CALLS_PER_TURN as unlimited", () => {
    expect(maxToolCallsPerTurn({})).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "0" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "-5" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "abc" })).toBe(0);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: "80" })).toBe(80);
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: " 12.9 " })).toBe(12);
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
        operationId: "3",
        traceId: "3",
        spaceId: "w",
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
