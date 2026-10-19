import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  result: undefined as unknown,
  systemPrompt: "",
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tool: {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };

    constructor(options: {
      initialState: {
        systemPrompt: string;
        tools: Array<{
          name: string;
          execute: (toolCallId: string, params: unknown) => Promise<unknown>;
        }>;
      };
    }) {
      fakeAgentState.systemPrompt = options.initialState.systemPrompt;
      const tool = options.initialState.tools.find(
        (candidate) => candidate.name === "computer_observe",
      );
      if (!tool) throw new Error("computer_observe was not exposed");
      this.tool = tool;
    }

    subscribe(_listener: unknown) {}

    async prompt() {
      fakeAgentState.result = await this.tool.execute("observe-1", {});
    }

    async waitForIdle() {}

    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) =>
      modelId === "computer-test-model" ? { provider: "test", id: modelId } : undefined,
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

import { COMPUTER_SCREEN_UNAVAILABLE } from "./computer-screens.js";
import {
  PiAgentRuntime,
  pruneComputerScreenshotContext,
  pruneStalePageStateContext,
} from "./pi-runtime.js";

const computerObserve: ConnectorTool = {
  name: "computer_observe",
  description: "Observe the computer",
  inputSchema: { type: "object", properties: {} },
};

describe("Pi computer tool dispatch", () => {
  beforeEach(() => {
    fakeAgentState.result = undefined;
    fakeAgentState.systemPrompt = "";
  });

  it("forwards screenshots as image content for any Pi model provider", async () => {
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "look at the screen",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [computerObserve],
        model: { provider: "test", id: "computer-test-model" },
        executeTool: async () => ({
          kind: "agent_tool_result",
          content: [
            { type: "text", text: "computer observed" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          details: { frameId: "frame-1" },
        }),
      },
      {
        operationId: "computer-test",
        traceId: "computer-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime so the fake agent executes the tool.
    }

    expect(fakeAgentState.result).toMatchObject({
      content: [{ type: "text" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
    expect(fakeAgentState.systemPrompt).toBe("Follow the user's instructions.");
  });

  it("keeps the run alive when a graphical tool returns an error object", async () => {
    const runtime = new PiAgentRuntime();
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run-screen-error",
        prompt: "look at the screen",
        instructions: "Follow the user's instructions.",
        history: [],
        tools: [computerObserve],
        model: { provider: "test", id: "computer-test-model" },
        executeTool: async () => ({ error: COMPUTER_SCREEN_UNAVAILABLE }),
      },
      {
        operationId: "computer-test",
        traceId: "computer-test",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(fakeAgentState.result).toMatchObject({
      content: [{ type: "text" }],
      details: { error: expect.stringMatching(/temporarily busy/) },
    });
    expect(events.some((event) => event.text?.includes("I hit a problem"))).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  const pageResult = (id: string, toolName: string, text = `page ${id} ${"x".repeat(1_200)}`) => ({
    role: "toolResult" as const,
    toolCallId: id,
    toolName,
    content: [{ type: "text" as const, text }],
    details: { frameId: id },
    isError: false,
    timestamp: 1,
  });

  it("trims page-state results older than the three most recent", () => {
    const messages = [
      { role: "user" as const, content: "find the cheapest coffee", timestamp: 1 },
      pageResult("s1", "browser_snapshot"),
      pageResult("s2", "browser_act"),
      {
        role: "toolResult" as const,
        toolCallId: "read-1",
        toolName: "read_file",
        content: [{ type: "text" as const, text: "tracker contents" }],
        isError: false,
        timestamp: 1,
      },
      pageResult("s3", "computer_observe"),
      pageResult("s4", "browser_snapshot"),
      pageResult("s5", "browser_navigate"),
    ];

    const pruned = pruneStalePageStateContext(messages);
    const texts = pruned.map((message) => {
      const content: unknown = "content" in message ? message.content : "";
      if (typeof content === "string") return content;
      return (content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? part.type)
        .join("");
    });
    expect(texts).toEqual([
      "find the cheapest coffee",
      expect.stringContaining("trimmed to save context"),
      expect.stringContaining("trimmed to save context"),
      "tracker contents",
      expect.stringContaining("page s3"),
      expect.stringContaining("page s4"),
      expect.stringContaining("page s5"),
    ]);
    // The original history is untouched, so the next request trims identically.
    expect(messages[1]?.content).toEqual([
      { type: "text", text: expect.stringContaining("page s1") },
    ]);
    expect(pruned[1]).toMatchObject({ toolCallId: "s1", toolName: "browser_snapshot" });
  });

  it("neither trims nor counts small page-state results such as errors and receipts", () => {
    const messages = [
      pageResult("s1", "browser_snapshot"),
      pageResult("nav", "browser_navigate", '{"url":"https://example.test","title":"Example"}'),
      pageResult("err", "browser_act", 'Unknown element ref "e9". Call browser_snapshot.'),
      pageResult("s2", "browser_snapshot"),
      pageResult("s3", "browser_snapshot"),
    ];

    const pruned = pruneStalePageStateContext(messages);
    expect(pruned).toBe(messages);
    expect(pruneStalePageStateContext(messages, 2)[0]).toMatchObject({
      toolCallId: "s1",
      content: [{ type: "text", text: expect.stringContaining("trimmed to save context") }],
    });
    expect(pruneStalePageStateContext(messages, 2).slice(1, 3)).toEqual(messages.slice(1, 3));
  });

  it("returns the same history when nothing is stale", () => {
    const messages = ["s1", "s2", "s3"].map((id) => pageResult(id, "browser_snapshot"));
    expect(pruneStalePageStateContext(messages)).toBe(messages);
  });

  it.each(["thrown", "returned"])("does not count a long %s error as a fresh page", (kind) => {
    const failure = {
      ...pageResult("error", "browser_act", `Action failed: ${"diagnostic ".repeat(150)}`),
      isError: kind === "thrown",
      details: kind === "returned" ? { error: "action failed" } : undefined,
    };
    const messages = [
      pageResult("s1", "browser_snapshot"),
      pageResult("s2", "computer_observe"),
      pageResult("s3", "browser_snapshot"),
      failure,
    ];
    expect(pruneStalePageStateContext(messages)).toBe(messages);
  });

  it.each(["thrown", "returned"])(
    "keeps an old long %s error while trimming stale pages",
    (kind) => {
      const failure = {
        ...pageResult("error", "computer_act", `Action failed: ${"diagnostic ".repeat(150)}`),
        isError: kind === "thrown",
        details: kind === "returned" ? { error: "action failed" } : undefined,
      };
      const messages = [
        failure,
        ...["s1", "s2", "s3", "s4"].map((id) => pageResult(id, "browser_snapshot")),
      ];
      const pruned = pruneStalePageStateContext(messages);
      expect(pruned[0]).toBe(failure);
      expect(pruned[1]).toMatchObject({
        toolCallId: "s1",
        content: [{ type: "text", text: expect.stringContaining("trimmed to save context") }],
      });
      expect(pruned.slice(2)).toEqual(messages.slice(2));
      expect(messages[1]?.content).toEqual([
        { type: "text", text: expect.stringContaining("page s1") },
      ]);
    },
  );

  it("keeps the two latest computer screenshots by default", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_observe",
      content: [
        { type: "text" as const, text: frameId },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const pruned = pruneComputerScreenshotContext(messages);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([false, true, true]);
  });

  it("honors a model-specific one-image limit", () => {
    const messages = ["frame-1", "frame-2", "frame-3"].map((frameId) => ({
      role: "toolResult" as const,
      toolCallId: frameId,
      toolName: "computer_observe",
      content: [
        { type: "text" as const, text: frameId },
        { type: "image" as const, data: frameId, mimeType: "image/png" as const },
      ],
      details: { frameId },
      isError: false,
      timestamp: 1,
    }));

    const pruned = pruneComputerScreenshotContext(messages, 1);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([false, false, true]);
  });

  it("reserves the image budget for user attachments", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: "user-image", mimeType: "image/png" as const }],
        timestamp: 1,
      },
      ...["frame-1", "frame-2"].map((frameId) => ({
        role: "toolResult" as const,
        toolCallId: frameId,
        toolName: "computer_observe",
        content: [
          { type: "text" as const, text: frameId },
          { type: "image" as const, data: frameId, mimeType: "image/png" as const },
        ],
        details: { frameId },
        isError: false,
        timestamp: 1,
      })),
    ];

    const pruned = pruneComputerScreenshotContext(messages, 2);
    expect(
      pruned.map((message) =>
        (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
      ),
    ).toEqual([true, false, true]);
  });

  it("rejects user images that exceed a configured model limit", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, data: "user-image-1", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-2", mimeType: "image/png" as const },
        ],
        timestamp: 1,
      },
    ];

    expect(() => pruneComputerScreenshotContext(messages, 1)).toThrow(
      "the prompt contains 2 non-screenshot images",
    );
  });

  it("does not apply the default screenshot retention to user images", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, data: "user-image-1", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-2", mimeType: "image/png" as const },
          { type: "image" as const, data: "user-image-3", mimeType: "image/png" as const },
        ],
        timestamp: 1,
      },
      ...["frame-1", "frame-2", "frame-3"].map((frameId) => ({
        role: "toolResult" as const,
        toolCallId: frameId,
        toolName: "computer_observe",
        content: [
          { type: "text" as const, text: frameId },
          { type: "image" as const, data: frameId, mimeType: "image/png" as const },
        ],
        details: { frameId },
        isError: false,
        timestamp: 1,
      })),
    ];

    const pruned = pruneComputerScreenshotContext(messages);
    expect(pruned[0]).toBe(messages[0]);
    expect((pruned[0] as (typeof messages)[number]).content).toHaveLength(3);
    expect(
      pruned
        .slice(1)
        .map((message) =>
          (message as (typeof messages)[number]).content.some((part) => part.type === "image"),
        ),
    ).toEqual([false, true, true]);
  });

  it("reuses the message array when no screenshot needs pruning", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
        timestamp: 1,
      },
    ];

    expect(pruneComputerScreenshotContext(messages)).toBe(messages);
  });
});
