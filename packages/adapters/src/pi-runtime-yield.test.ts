import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";

const fake = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({
      provider,
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://models.invalid/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    streamSimple: (...args: unknown[]) => fake.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

/** Each model call answers with the next step: a call to list_files at `path`, or the reply. */
function script(steps: Array<string | undefined>) {
  fake.stream.mockImplementation((target: Model<"openai-completions">) => {
    if (steps.length === 0) throw new Error("Unexpected model call");
    const path = steps.shift();
    const message: AssistantMessage = {
      role: "assistant",
      api: target.api,
      provider: target.provider,
      model: target.id,
      content: path
        ? [{ type: "toolCall", id: `call-${path}`, name: "list_files", arguments: { path } }]
        : [{ type: "text", text: "Done." }],
      stopReason: path ? "toolUse" : "stop",
      timestamp: 1,
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end(message);
    return stream;
  });
}

function request(stopping: AbortController, stopAt?: string): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: `yield-run-${Math.random()}`,
    prompt: "Look through the folders",
    instructions: "",
    history: [],
    tools: builtinAgentTools.filter((tool) => tool.name === "list_files"),
    model: { provider: "test", id: "main", apiKey: "fake-key" },
    yieldSignal: stopping.signal,
    executeTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      // The process starts stopping while this step's tool call is running.
      if (args.path === stopAt) stopping.abort();
      return { entries: [`${args.path}/file.txt`] };
    }),
  };
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {})) events.push(event);
  return events;
}

const calledPaths = (input: AgentRunRequest) =>
  vi.mocked(input.executeTool!).mock.calls.map(([, args]) => args.path);

beforeEach(() => {
  fake.stream.mockReset();
});

describe("a turn whose process starts stopping", () => {
  it("hands back after the step in flight, and resumes with the next model call", async () => {
    const stopping = new AbortController();
    const input = request(stopping, "a");
    script(["a", "b", undefined]);

    const events = await run(input);
    const yielded = events.find((event) => event.type === "yielded");
    expect(yielded).toBeDefined();
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(fake.stream).toHaveBeenCalledTimes(1);
    expect(calledPaths(input)).toEqual(["a"]);

    // Another process resumes the run from the turn the first one saved.
    const resumed = {
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: yielded?.type === "yielded" ? yielded.checkpoint : undefined,
    };
    const resumedEvents = await run(resumed);

    // The finished step is not repeated: the next model call already has its result.
    expect(calledPaths(resumed)).toEqual(["b"]);
    expect(fake.stream).toHaveBeenCalledTimes(3);
    const nextCall = fake.stream.mock.calls[1]![1] as Context;
    expect(nextCall.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-a",
    });
    expect(resumedEvents.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("finishes a turn whose last step is in flight instead of handing it back", async () => {
    const stopping = new AbortController();
    stopping.abort();
    const input = request(stopping);
    script([undefined]);

    const events = await run(input);

    expect(events.some((event) => event.type === "yielded")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });
});

it("runs every step of a turn whose process is not stopping", async () => {
  const input = request(new AbortController());
  script(["a", "b", undefined]);

  const events = await run(input);

  expect(events.some((event) => event.type === "yielded")).toBe(false);
  expect(calledPaths(input)).toEqual(["a", "b"]);
  expect(fake.stream).toHaveBeenCalledTimes(3);
  expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
});
